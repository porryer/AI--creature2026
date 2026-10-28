import { Inject, Injectable } from '@nestjs/common';
import { PLANS, type AdminUserDetailDTO, type AdminUserDTO, type Modality, type Page, type PlanCode, type TaskStatus, type UserStatus } from '@creature/shared';
import { invalidateUserStatus } from '../auth/auth.guard';
import { decryptPhone, hmac, maskPhone, PHONE_RE } from '../auth/crypto';
import { Errors } from '../common/errors';
import { newId } from '../common/ids';
import { AppConfig, CONFIG } from '../config';
import { CreditsService } from '../credits/credits.service';
import { Db, DB } from '../db/db';

/** 单次人工调整积分的上限 */
export const MAX_ADJUST = 100_000;

interface UserRow {
  id: string;
  nickname: string;
  phone_enc: string;
  status: UserStatus;
  role: 'user' | 'admin';
  plan_code: PlanCode;
  plan_expires_at: Date | null;
  created_at: Date;
  available: number | null;
  frozen: number | null;
  tasks_total: number;
}

const USER_SELECT = `
  SELECT u.id, u.nickname, u.phone_enc, u.status, u.role, u.plan_code, u.plan_expires_at, u.created_at, a.available, a.frozen,
         (SELECT COUNT(*)::int FROM generation_tasks t WHERE t.user_id = u.id) AS tasks_total
    FROM users u LEFT JOIN credit_accounts a ON a.owner_type = 'user' AND a.owner_id = u.id`;

/** 后台用户管理：查询、冻结 / 封禁 / 解除、人工调整积分；所有修改写审计日志 */
@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly credits: CreditsService,
  ) {}

  /** q 可以是完整手机号、手机号后 4 位、昵称片段或用户 ID */
  async list(f: { q?: string; status?: UserStatus; cursor: string | null; limit: number }): Promise<Page<AdminUserDTO>> {
    const q = f.q?.trim() || null;
    const phoneHash = q && PHONE_RE.test(q) ? hmac(this.config.phoneHashKey, q) : null;
    const rows = await this.db.query<UserRow>(
      `${USER_SELECT}
        WHERE ($1::text IS NULL OR u.status = $1)
          AND ($2::text IS NULL OR u.id = $2 OR u.phone_hash = $3 OR u.phone_last4 = $2 OR u.nickname ILIKE '%' || $2 || '%')
          AND ($4::text IS NULL OR u.id < $4)
        ORDER BY u.id DESC LIMIT $5`,
      [f.status ?? null, q, phoneHash, f.cursor, f.limit + 1],
    );
    const page = rows.slice(0, f.limit);
    return { data: page.map((r) => this.toDTO(r)), next_cursor: rows.length > f.limit ? page[page.length - 1].id : null };
  }

  async detail(id: string): Promise<AdminUserDetailDTO> {
    const u = await this.row(id);
    const accountId = await this.credits.accountIdFor(id);
    const [[stats], ledger, tasks, audit] = await Promise.all([
      this.db.query<AdminUserDetailDTO['stats']>(
        `SELECT (SELECT COUNT(*)::int FROM generation_tasks WHERE user_id = $1 AND status = 'succeeded') AS tasks_succeeded,
                (SELECT COUNT(*)::int FROM generation_tasks WHERE user_id = $1 AND status IN ('failed', 'blocked')) AS tasks_failed,
                (SELECT COUNT(*)::int FROM assets WHERE user_id = $1 AND deleted_at IS NULL) AS assets,
                (SELECT COUNT(*)::int FROM posts WHERE author_id = $1 AND status <> 'removed') AS posts,
                (SELECT COUNT(*)::int FROM reports r JOIN posts p ON p.id = r.target_id WHERE r.target_type = 'post' AND p.author_id = $1) AS reports_received`,
        [id],
      ),
      this.credits.ledger(accountId, null, 20),
      this.db.query<{ id: string; modality: Modality; prompt: string; status: TaskStatus; credits: number; created_at: Date }>(
        `SELECT id, modality, prompt, status, COALESCE(actual_credits, estimated_credits) AS credits, created_at FROM generation_tasks WHERE user_id = $1 ORDER BY id DESC LIMIT 10`,
        [id],
      ),
      this.db.query<{ action: string; actor_nickname: string | null; detail: Record<string, unknown>; created_at: Date }>(
        `SELECT l.action, u.nickname AS actor_nickname, l.detail, l.created_at FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
          WHERE l.target_type = 'user' AND l.target_id = $1 ORDER BY l.created_at DESC LIMIT 20`,
        [id],
      ),
    ]);
    return {
      ...this.toDTO(u),
      stats,
      ledger: ledger.data,
      recent_tasks: tasks.map((t) => ({ ...t, created_at: new Date(t.created_at).toISOString() })),
      audit: audit.map((a) => ({ action: a.action, actor_nickname: a.actor_nickname ?? '系统', detail: a.detail, created_at: new Date(a.created_at).toISOString() })),
    };
  }

  /** 冻结 / 封禁会立即吊销该用户的全部登录会话，进行中的请求最迟 10 秒后失效 */
  async setStatus(adminId: string, id: string, status: UserStatus, reason: string): Promise<AdminUserDetailDTO> {
    if (id === adminId) throw Errors.invalid('不能修改自己的账号状态');
    await this.db.tx(async (q) => {
      const [u] = await q.query<{ status: UserStatus; role: string }>('SELECT status, role FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!u) throw Errors.notFound('用户');
      if (u.role === 'admin' && status !== 'active') throw Errors.invalid('不能限制管理员账号，请先在 ADMIN_PHONES 中移除');
      if (u.status === status) return;
      await q.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
      if (status !== 'active') await q.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await this.audit(q, adminId, `user.${status === 'active' ? 'restore' : status === 'frozen' ? 'freeze' : 'ban'}`, id, { from: u.status, to: status, reason });
    });
    invalidateUserStatus(id);
    return this.detail(id);
  }

  /** 人工调整积分（补偿或扣回），需要填写原因；同一请求 ID 重复提交只生效一次 */
  async adjustCredits(adminId: string, id: string, delta: number, reason: string, requestId: string): Promise<AdminUserDetailDTO> {
    await this.row(id);
    const accountId = await this.credits.accountIdFor(id);
    await this.db.tx(async (q) => {
      const before = await q.query(`SELECT 1 FROM credit_ledger WHERE account_id = $1 AND idempotency_key = $2`, [accountId, `admin:${requestId}`]);
      const balance = await this.credits.adjust(q, accountId, delta, `人工调整 · ${reason}`, `admin:${requestId}`);
      if (!before.length) await this.audit(q, adminId, 'user.credits_adjust', id, { delta, reason, balance_after: balance });
    });
    await this.credits.notify(accountId);
    return this.detail(id);
  }

  private async audit(q: { query: Db['query'] }, actorId: string, action: string, userId: string, detail: Record<string, unknown>) {
    await q.query('INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)', [newId('aud'), actorId, action, 'user', userId, JSON.stringify(detail)]);
  }

  private async row(id: string): Promise<UserRow> {
    const [u] = await this.db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
    if (!u) throw Errors.notFound('用户');
    return u;
  }

  private toDTO(r: UserRow): AdminUserDTO {
    const plan = PLANS[r.plan_code] ?? PLANS.free;
    return {
      id: r.id,
      nickname: r.nickname,
      phone_masked: maskPhone(decryptPhone(r.phone_enc, this.config.phoneEncKey)),
      status: r.status,
      role: r.role,
      plan: { code: plan.code, name: plan.name, expires_at: r.plan_expires_at ? new Date(r.plan_expires_at).toISOString() : null },
      credits: { available: r.available ?? 0, frozen: r.frozen ?? 0 },
      tasks_total: r.tasks_total,
      created_at: new Date(r.created_at).toISOString(),
    };
  }
}
