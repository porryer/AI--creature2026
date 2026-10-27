import { Inject, Injectable } from '@nestjs/common';
import type { BalanceDTO, LedgerEntryDTO, LedgerType } from '@creature/shared';
import { GRANT_RULES } from '@creature/shared';
import { Errors } from '../common/errors';
import { newId } from '../common/ids';
import { addDays, cnDateKey, endOfCnDay } from '../common/time';
import { Db, DB, isUniqueViolation, Queryable } from '../db/db';
import { EventBus } from '../events/event-bus';

interface AccountRow {
  id: string;
  owner_id: string;
  available: number;
  frozen: number;
}
interface GrantRow {
  id: string;
  remaining: number;
  amount: number;
  expires_at: Date;
}
interface HoldRow {
  grant_id: string;
  amount: number;
  expires_at: Date;
}
interface LedgerRow {
  id: string;
  entry_type: LedgerType;
  delta_available: number;
  delta_frozen: number;
  balance_after: number;
  memo: string;
  task_id: string | null;
  created_at: Date;
}

export type GrantSource = 'daily' | 'signup' | 'subscription' | 'pack' | 'admin';

/**
 * 积分账务（docs/03-architecture.md 5.3）：
 * - 积分按批次（credit_grants）发放，各有来源与有效期；
 * - 提交任务时冻结，按"先过期先扣"从批次中扣减，并在 credit_holds 记录扣自哪些批次；
 * - 成功后按实际消耗结算，差额退回；失败、拦截、取消全额退回原批次；
 * - 所有变动写入只追加的 credit_ledger，并用幂等键防止重复记账。
 * 不变量：available = Σ 未过期批次 remaining；frozen = Σ holds；两者都等于流水增量之和。
 */
@Injectable()
export class CreditsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  async accountIdFor(userId: string, q: Queryable = this.db): Promise<string> {
    const rows = await q.query<{ id: string }>(`SELECT id FROM credit_accounts WHERE owner_type = 'user' AND owner_id = $1`, [userId]);
    if (rows[0]) return rows[0].id;
    const id = newId('acc');
    await q.query(`INSERT INTO credit_accounts (id, owner_type, owner_id) VALUES ($1, 'user', $2) ON CONFLICT (owner_type, owner_id) DO NOTHING`, [id, userId]);
    return (await q.query<{ id: string }>(`SELECT id FROM credit_accounts WHERE owner_type = 'user' AND owner_id = $1`, [userId]))[0].id;
  }

  async balance(accountId: string, q: Queryable = this.db): Promise<BalanceDTO> {
    const [acc] = await q.query<AccountRow>('SELECT * FROM credit_accounts WHERE id = $1', [accountId]);
    const [soon] = await q.query<{ n: number | null }>(
      `SELECT COALESCE(SUM(remaining), 0)::int AS n FROM credit_grants WHERE account_id = $1 AND remaining > 0 AND expires_at > now() AND expires_at <= now() + interval '3 days'`,
      [accountId],
    );
    return { available: acc?.available ?? 0, frozen: acc?.frozen ?? 0, expiring_soon: soon?.n ?? 0 };
  }

  async balanceForUser(userId: string): Promise<BalanceDTO> {
    const accountId = await this.accountIdFor(userId);
    await this.db.tx((q) => this.expireAccount(q, accountId));
    return this.balance(accountId);
  }

  /** 发放积分。传入 idemKey 时重复调用不会重复发放，返回是否新发放 */
  async grant(
    q: Queryable,
    accountId: string,
    opts: { amount: number; source: GrantSource; expiresAt: Date; memo: string; idemKey?: string; refId?: string },
  ): Promise<boolean> {
    if (opts.amount <= 0) throw Errors.invalid('发放积分必须大于 0');
    const acc = await this.lock(q, accountId);
    if (opts.idemKey) {
      const dup = await q.query('SELECT 1 FROM credit_ledger WHERE account_id = $1 AND idempotency_key = $2', [accountId, opts.idemKey]);
      if (dup.length) return false;
    }
    const grantId = newId('grt');
    await q.query(
      `INSERT INTO credit_grants (id, account_id, source, amount, remaining, expires_at, ref_id) VALUES ($1, $2, $3, $4, $4, $5, $6)`,
      [grantId, accountId, opts.source, opts.amount, opts.expiresAt, opts.refId ?? null],
    );
    const available = acc.available + opts.amount;
    await this.setBalances(q, accountId, available, acc.frozen);
    await this.write(q, accountId, 'grant', opts.amount, 0, available, { grantId, memo: opts.memo, idemKey: opts.idemKey });
    return true;
  }

  /** 冻结积分：不足时抛出 INSUFFICIENT_CREDITS */
  async freeze(q: Queryable, accountId: string, amount: number, taskId: string, memo: string): Promise<void> {
    if (amount <= 0) return;
    await this.expireAccount(q, accountId);
    const acc = await this.lock(q, accountId);
    if (acc.available < amount) throw Errors.insufficientCredits(amount, acc.available);
    const grants = await q.query<GrantRow>(
      `SELECT id, remaining, amount, expires_at FROM credit_grants WHERE account_id = $1 AND remaining > 0 AND expires_at > now()
       ORDER BY expires_at, id FOR UPDATE`,
      [accountId],
    );
    let left = amount;
    for (const g of grants) {
      if (left === 0) break;
      const take = Math.min(left, g.remaining);
      await q.query('UPDATE credit_grants SET remaining = remaining - $2 WHERE id = $1', [g.id, take]);
      await q.query('INSERT INTO credit_holds (task_id, grant_id, amount) VALUES ($1, $2, $3)', [taskId, g.id, take]);
      left -= take;
    }
    if (left > 0) throw new Error(`积分批次与账户余额不一致（账户 ${accountId} 缺少 ${left}）`);
    const available = acc.available - amount;
    await this.setBalances(q, accountId, available, acc.frozen + amount);
    await this.write(q, accountId, 'freeze', -amount, amount, available, { taskId, memo, idemKey: `freeze:${taskId}` });
  }

  /** 结算：按实际消耗扣除，差额退回可用余额。重复调用无副作用 */
  async settle(q: Queryable, accountId: string, taskId: string, actual: number, memo: string): Promise<number> {
    const acc = await this.lock(q, accountId);
    const holds = await this.holds(q, taskId);
    const total = holds.reduce((a, h) => a + h.amount, 0);
    if (total === 0) return 0;
    const charge = Math.max(0, Math.min(actual, total));
    const diff = total - charge;
    if (diff > 0) await this.restore(q, holds, diff);
    await q.query('DELETE FROM credit_holds WHERE task_id = $1', [taskId]);
    const available = acc.available + diff;
    await this.setBalances(q, accountId, available, acc.frozen - total);
    await this.write(q, accountId, 'settle', 0, -charge, acc.available, { taskId, memo, idemKey: `settle:${taskId}` });
    if (diff > 0) await this.write(q, accountId, 'unfreeze', diff, -diff, available, { taskId, memo: `${memo} · 差额退回`, idemKey: `unfreeze:${taskId}` });
    return charge;
  }

  /** 全额退回冻结积分（失败、拦截、取消）。重复调用无副作用 */
  async refund(q: Queryable, accountId: string, taskId: string, memo: string): Promise<number> {
    const acc = await this.lock(q, accountId);
    const holds = await this.holds(q, taskId);
    const total = holds.reduce((a, h) => a + h.amount, 0);
    if (total === 0) return 0;
    await this.restore(q, holds, total);
    await q.query('DELETE FROM credit_holds WHERE task_id = $1', [taskId]);
    const available = acc.available + total;
    await this.setBalances(q, accountId, available, acc.frozen - total);
    await this.write(q, accountId, 'refund', total, -total, available, { taskId, memo, idemKey: `refund:${taskId}` });
    return total;
  }

  /** 让账户中已过期批次的剩余积分失效 */
  async expireAccount(q: Queryable, accountId: string, now = new Date()): Promise<number> {
    // 加锁顺序固定为"先账户、后批次"，与冻结 / 结算一致，避免并发事务死锁
    const acc = await this.lock(q, accountId);
    const due = await q.query<GrantRow>(
      'SELECT id, remaining, amount, expires_at FROM credit_grants WHERE account_id = $1 AND remaining > 0 AND expires_at <= $2 ORDER BY id FOR UPDATE',
      [accountId, now],
    );
    if (!due.length) return 0;
    let available = acc.available;
    for (const g of due) {
      await q.query('UPDATE credit_grants SET remaining = 0 WHERE id = $1', [g.id]);
      available -= g.remaining;
      await this.write(q, accountId, 'expire', -g.remaining, 0, available, { grantId: g.id, memo: '积分到期失效', idemKey: `expire:${g.id}` });
    }
    await this.setBalances(q, accountId, available, acc.frozen);
    return acc.available - available;
  }

  /** 定时任务：处理所有账户的过期积分 */
  async expireDue(now = new Date()): Promise<number> {
    const accounts = await this.db.query<{ account_id: string }>(
      'SELECT DISTINCT account_id FROM credit_grants WHERE remaining > 0 AND expires_at <= $1',
      [now],
    );
    let total = 0;
    for (const a of accounts) {
      const n = await this.db.tx((q) => this.expireAccount(q, a.account_id, now));
      if (n > 0) {
        total += n;
        await this.notify(a.account_id);
      }
    }
    return total;
  }

  /** 每日首次访问赠送积分（当天有效），同一天重复调用不会重复发放 */
  async ensureDailyGrant(userId: string, now = new Date()): Promise<boolean> {
    const accountId = await this.accountIdFor(userId);
    const granted = await this.db
      .tx((q) =>
        this.grant(q, accountId, {
          amount: GRANT_RULES.dailyCredits,
          source: 'daily',
          expiresAt: endOfCnDay(now),
          memo: '每日登录赠送',
          idemKey: `daily:${cnDateKey(now)}`,
        }),
      )
      .catch((e) => {
        if (isUniqueViolation(e)) return false;
        throw e;
      });
    if (granted) await this.notify(accountId);
    return granted;
  }

  async grantSignup(q: Queryable, accountId: string, now = new Date()) {
    await this.grant(q, accountId, {
      amount: GRANT_RULES.signupCredits,
      source: 'signup',
      expiresAt: addDays(now, GRANT_RULES.signupValidDays),
      memo: '新用户赠送',
      idemKey: 'signup',
    });
  }

  async ledger(accountId: string, cursor: string | null, limit: number): Promise<{ data: LedgerEntryDTO[]; next_cursor: string | null }> {
    const rows = await this.db.query<LedgerRow>(
      `SELECT * FROM credit_ledger WHERE account_id = $1 AND ($2::text IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [accountId, cursor, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        id: r.id,
        entry_type: r.entry_type,
        delta_available: r.delta_available,
        delta_frozen: r.delta_frozen,
        balance_after: r.balance_after,
        memo: r.memo,
        task_id: r.task_id,
        created_at: new Date(r.created_at).toISOString(),
      })),
      next_cursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** 对账：账户余额、批次余量、冻结明细与流水增量四方核对 */
  async reconcile(accountId: string): Promise<{ ok: boolean; available: number; frozen: number; ledgerAvailable: number; ledgerFrozen: number; grantsRemaining: number; holds: number }> {
    const [acc] = await this.db.query<AccountRow>('SELECT * FROM credit_accounts WHERE id = $1', [accountId]);
    const [l] = await this.db.query<{ a: number; f: number }>(
      'SELECT COALESCE(SUM(delta_available), 0)::int AS a, COALESCE(SUM(delta_frozen), 0)::int AS f FROM credit_ledger WHERE account_id = $1',
      [accountId],
    );
    const [g] = await this.db.query<{ n: number }>('SELECT COALESCE(SUM(remaining), 0)::int AS n FROM credit_grants WHERE account_id = $1', [accountId]);
    const [h] = await this.db.query<{ n: number }>(
      'SELECT COALESCE(SUM(h.amount), 0)::int AS n FROM credit_holds h JOIN credit_grants g ON g.id = h.grant_id WHERE g.account_id = $1',
      [accountId],
    );
    const r = { available: acc.available, frozen: acc.frozen, ledgerAvailable: l.a, ledgerFrozen: l.f, grantsRemaining: g.n, holds: h.n };
    return { ok: r.available === r.ledgerAvailable && r.frozen === r.ledgerFrozen && r.available === r.grantsRemaining && r.frozen === r.holds, ...r };
  }

  async notify(accountId: string) {
    const [acc] = await this.db.query<AccountRow>('SELECT * FROM credit_accounts WHERE id = $1', [accountId]);
    if (acc) this.bus.emit(acc.owner_id, { type: 'credits.changed', credits: await this.balance(accountId) });
  }

  // ---------- 内部 ----------

  private async lock(q: Queryable, accountId: string): Promise<AccountRow> {
    const [acc] = await q.query<AccountRow>('SELECT * FROM credit_accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!acc) throw Errors.notFound('积分账户');
    return acc;
  }

  private holds(q: Queryable, taskId: string): Promise<HoldRow[]> {
    return q.query<HoldRow>(
      `SELECT h.grant_id, h.amount, g.expires_at FROM credit_holds h JOIN credit_grants g ON g.id = h.grant_id
       WHERE h.task_id = $1 ORDER BY g.expires_at DESC, g.id DESC FOR UPDATE OF h`,
      [taskId],
    );
  }

  /** 把积分退回冻结时扣减的批次：优先退回有效期最长的批次 */
  private async restore(q: Queryable, holds: HoldRow[], amount: number) {
    let left = amount;
    for (const h of holds) {
      if (left === 0) break;
      const back = Math.min(left, h.amount);
      await q.query('UPDATE credit_grants SET remaining = remaining + $2 WHERE id = $1', [h.grant_id, back]);
      left -= back;
    }
  }

  private async setBalances(q: Queryable, accountId: string, available: number, frozen: number) {
    await q.query('UPDATE credit_accounts SET available = $2, frozen = $3, updated_at = now() WHERE id = $1', [accountId, available, frozen]);
  }

  private async write(
    q: Queryable,
    accountId: string,
    type: LedgerType,
    dAvail: number,
    dFrozen: number,
    balanceAfter: number,
    o: { taskId?: string; grantId?: string; memo: string; idemKey?: string },
  ) {
    await q.query(
      `INSERT INTO credit_ledger (id, account_id, entry_type, delta_available, delta_frozen, balance_after, task_id, grant_id, idempotency_key, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newId('led'), accountId, type, dAvail, dFrozen, balanceAfter, o.taskId ?? null, o.grantId ?? null, o.idemKey ?? null, o.memo],
    );
  }
}
