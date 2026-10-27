import { Inject, Injectable } from '@nestjs/common';
import { GRANT_RULES, orderAmountFen, PLANS, type OrderDTO, type PlanCode } from '@creature/shared';
import { randomInt } from 'node:crypto';
import { AppConfig, CONFIG } from '../config';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { addDays, addMonths, cnDateKey } from '../common/time';
import { CreditsService } from '../credits/credits.service';
import { Db, DB, Queryable } from '../db/db';

interface OrderRow {
  id: string;
  order_no: string;
  user_id: string;
  item_type: 'subscription' | 'credit_pack';
  item_ref: string;
  cycle: 'month' | 'year' | null;
  amount_fen: number;
  credits: number;
  status: 'pending' | 'paid' | 'closed';
  created_at: Date;
  paid_at: Date | null;
}

interface SubRow {
  id: string;
  user_id: string;
  plan_code: PlanCode;
  cycle: 'month' | 'year';
  current_period_end: Date;
  next_grant_at: Date | null;
}

const toDTO = (r: OrderRow): OrderDTO => ({
  id: r.id,
  order_no: r.order_no,
  item_type: r.item_type,
  item_ref: r.item_ref,
  cycle: r.cycle,
  amount_fen: r.amount_fen,
  credits: r.credits,
  status: r.status,
  created_at: new Date(r.created_at).toISOString(),
  paid_at: r.paid_at ? new Date(r.paid_at).toISOString() : null,
});

/**
 * 订单与订阅：
 * - 积分包到账后 1 年有效；
 * - 订阅积分按月发放，可结转一个周期（本月积分在下月底前有效）；年付按月分批发放；
 * - 当前只实现模拟支付（PAYMENTS_MODE=mock），接入微信 / 支付宝时在 markPaid 前增加回调验签。
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly credits: CreditsService,
  ) {}

  async createOrder(userId: string, itemType: 'subscription' | 'credit_pack', itemRef: string, cycle: 'month' | 'year' | null): Promise<OrderDTO> {
    if (this.config.paymentsMode !== 'mock') throw new AppError('PAYMENT_CHANNEL_UNAVAILABLE', 503, '支付渠道尚未开通');
    const price = orderAmountFen(itemType, itemRef, itemType === 'subscription' ? cycle : null);
    if (!price) throw Errors.invalid('商品不存在');
    const now = new Date();
    const orderNo = `CR${cnDateKey(now)}${String(now.getTime()).slice(-6)}${String(randomInt(0, 10000)).padStart(4, '0')}`;
    const [r] = await this.db.query<OrderRow>(
      `INSERT INTO orders (id, order_no, user_id, item_type, item_ref, cycle, amount_fen, credits, status, pay_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'mock') RETURNING *`,
      [newId('ord'), orderNo, userId, itemType, itemRef, itemType === 'subscription' ? cycle : null, price.amountFen, price.credits],
    );
    return toDTO(r);
  }

  async getOrder(userId: string, id: string): Promise<OrderDTO> {
    const [r] = await this.db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) throw Errors.notFound('订单');
    return toDTO(r);
  }

  /** 模拟支付成功（仅开发 / 测试环境），重复调用幂等 */
  async mockPay(userId: string, id: string): Promise<OrderDTO> {
    if (this.config.paymentsMode !== 'mock') throw Errors.forbidden('模拟支付仅在开发环境可用');
    const order = await this.db.tx(async (q) => {
      const [o] = await q.query<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
      if (!o) throw Errors.notFound('订单');
      if (o.status === 'paid') return o;
      if (o.status !== 'pending') throw Errors.conflict('ORDER_CLOSED', '订单已关闭');
      const [paid] = await q.query<OrderRow>(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1 RETURNING *`, [id]);
      await this.fulfill(q, paid);
      return paid;
    });
    await this.credits.notify(await this.credits.accountIdFor(userId));
    return toDTO(order);
  }

  private async fulfill(q: Queryable, o: OrderRow) {
    const accountId = await this.credits.accountIdFor(o.user_id, q);
    const now = new Date();
    if (o.item_type === 'credit_pack') {
      await this.credits.grant(q, accountId, {
        amount: o.credits,
        source: 'pack',
        expiresAt: addDays(now, GRANT_RULES.packValidDays),
        memo: `积分包 ${o.credits} 到账`,
        idemKey: `order:${o.id}`,
        refId: o.id,
      });
      return;
    }
    const plan = PLANS[o.item_ref as PlanCode];
    const months = o.cycle === 'year' ? 12 : 1;
    // 已有同档有效订阅时顺延，否则从现在开始
    const [user] = await q.query<{ plan_code: string; plan_expires_at: Date | null }>('SELECT plan_code, plan_expires_at FROM users WHERE id = $1 FOR UPDATE', [o.user_id]);
    const start = user?.plan_code === plan.code && user.plan_expires_at && new Date(user.plan_expires_at) > now ? new Date(user.plan_expires_at) : now;
    const end = addMonths(start, months);
    const subId = newId('sub');
    await q.query(
      `INSERT INTO subscriptions (id, user_id, plan_code, cycle, status, current_period_start, current_period_end, next_grant_at, order_id)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8)`,
      [subId, o.user_id, plan.code, o.cycle, start, end, months > 1 ? addMonths(start, 1) : null, o.id],
    );
    await q.query('UPDATE users SET plan_code = $2, plan_expires_at = $3, updated_at = now() WHERE id = $1', [o.user_id, plan.code, end]);
    await this.credits.grant(q, accountId, {
      amount: plan.monthlyCredits,
      source: 'subscription',
      expiresAt: addMonths(start, 1 + GRANT_RULES.subscriptionRolloverPeriods),
      memo: `${plan.name}月度积分`,
      idemKey: `sub:${subId}:0`,
      refId: subId,
    });
  }

  /** 定时任务：发放年付套餐的后续月度积分；套餐到期后降级为免费版 */
  async runDue(now = new Date()): Promise<{ granted: number; expired: number }> {
    let granted = 0;
    const due = await this.db.query<SubRow>(
      `SELECT * FROM subscriptions WHERE status = 'active' AND next_grant_at IS NOT NULL AND next_grant_at <= $1 AND next_grant_at < current_period_end`,
      [now],
    );
    for (const s of due) {
      await this.db.tx(async (q) => {
        const [locked] = await q.query<SubRow>('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [s.id]);
        if (!locked?.next_grant_at || new Date(locked.next_grant_at) > now) return;
        const at = new Date(locked.next_grant_at);
        const accountId = await this.credits.accountIdFor(s.user_id, q);
        const plan = PLANS[s.plan_code];
        const ok = await this.credits.grant(q, accountId, {
          amount: plan.monthlyCredits,
          source: 'subscription',
          expiresAt: addMonths(at, 1 + GRANT_RULES.subscriptionRolloverPeriods),
          memo: `${plan.name}月度积分`,
          idemKey: `sub:${s.id}:${at.toISOString().slice(0, 7)}`,
          refId: s.id,
        });
        const next = addMonths(at, 1);
        await q.query('UPDATE subscriptions SET next_grant_at = $2 WHERE id = $1', [s.id, next < new Date(locked.current_period_end) ? next : null]);
        if (ok) granted++;
      });
    }
    await this.db.query(`UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND current_period_end <= $1`, [now]);
    const expired = await this.db.query(
      `UPDATE users SET plan_code = 'free', plan_expires_at = NULL, updated_at = now() WHERE plan_code <> 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at <= $1 RETURNING id`,
      [now],
    );
    return { granted, expired: expired.length };
  }
}
