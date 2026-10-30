import { Inject, Injectable, Logger } from '@nestjs/common';
import { DELETION_COOLING_DAYS, PLANS, type DeletionRequestDTO, type PlanCode } from '@creature/shared';
import { AssetsService, type AssetRow } from '../assets/assets.service';
import { AuthService } from '../auth/auth.service';
import { decryptPhone } from '../auth/crypto';
import { UserStatusService } from '../auth/user-status.service';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { AppConfig, CONFIG } from '../config';
import { CreditsService } from '../credits/credits.service';
import { Db, DB, type Queryable } from '../db/db';

/** 每人每天可导出个人信息的次数 */
const EXPORT_DAILY_LIMIT = 5;
/** 每批匿名化的账号数 */
const BATCH = 50;
const DAY_MS = 86_400_000;

/**
 * 个人信息权利（docs/08-compliance.md 第 5 节）：注销账号与导出个人信息副本。
 *
 * 注销：短信验证后进入 15 天冷静期（status = deleting，所有会话立即失效），期间用手机号重新登录即撤销；
 * 到期后由维护任务匿名化：清除手机号与昵称（手机号可重新注册新账号）、删除作品（文件随后由存储清理删除）、
 * 撤回广场发布、删除角色 / 品牌套件 / 项目内容与点赞；生成记录（合规留存）、订单与积分流水保留，但不再关联到个人。
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger('Account');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly statuses: UserStatusService,
    private readonly assets: AssetsService,
    private readonly credits: CreditsService,
  ) {}

  private async phoneOf(userId: string): Promise<string> {
    const [u] = await this.db.query<{ phone_enc: string }>('SELECT phone_enc FROM users WHERE id = $1', [userId]);
    if (!u) throw Errors.unauthenticated();
    return decryptPhone(u.phone_enc, this.config.phoneEncKey);
  }

  /** 向账号绑定的手机号发送验证码（注销确认用） */
  async sendDeletionCode(userId: string) {
    return this.auth.sendCode(await this.phoneOf(userId));
  }

  async requestDeletion(userId: string, code: string): Promise<DeletionRequestDTO> {
    await this.auth.verifyCode(await this.phoneOf(userId), code);
    const [busy] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM generation_tasks WHERE user_id = $1 AND status IN ('queued', 'running', 'post_processing')`, [userId]);
    if (busy.n > 0) throw new AppError('ACCOUNT_BUSY', 409, `还有 ${busy.n} 个任务正在生成，请等待完成或取消后再注销`);
    const row = await this.db.tx(async (q) => {
      const [u] = await q.query<{ requested_at: Date }>(
        `UPDATE users SET status = 'deleting', deletion_requested_at = now(), updated_at = now() WHERE id = $1 AND status = 'active' RETURNING deletion_requested_at AS requested_at`,
        [userId],
      );
      if (!u) throw Errors.suspended();
      await q.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await this.audit(q, userId, 'user.deletion_requested', userId, {});
      return u;
    });
    this.statuses.changed(userId);
    const at = new Date(row.requested_at);
    return { status: 'deleting', requested_at: at.toISOString(), delete_after: new Date(at.getTime() + DELETION_COOLING_DAYS * DAY_MS).toISOString() };
  }

  /** 冷静期已过的账号：匿名化（维护任务调用；多实例用 SKIP LOCKED 认领） */
  async finalizeDue(now = new Date()): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.db.tx(async (q) => {
        const due = await q.query<{ id: string }>(
          `SELECT id FROM users WHERE status = 'deleting' AND deletion_requested_at < $1 ORDER BY deletion_requested_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
          [new Date(now.getTime() - DELETION_COOLING_DAYS * DAY_MS)],
        );
        for (const { id } of due) await this.anonymize(q, id);
        return due.map((d) => d.id);
      });
      for (const id of n) this.statuses.changed(id);
      total += n.length;
      if (n.length < BATCH) break;
    }
    if (total) this.logger.log(`已完成 ${total} 个账号的注销`);
    return total;
  }

  private async anonymize(q: Queryable, id: string) {
    await q.query(
      `UPDATE users SET status = 'deleted', deleted_at = now(), nickname = '已注销用户', phone_enc = '', phone_hash = 'deleted:' || id, phone_last4 = '',
              role = 'user', plan_code = 'free', plan_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    await q.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
    // 作品：标记删除并清除标题与正文，文件由存储清理删除（不等宽限期）；内容编号保留以便追溯
    await q.query(`UPDATE assets SET deleted_at = COALESCE(deleted_at, now()), title = '', prompt = '', text_content = NULL WHERE user_id = $1`, [id]);
    await q.query(`UPDATE asset_folders SET deleted_at = COALESCE(deleted_at, now()), name = '' WHERE user_id = $1`, [id]);
    await q.query(`UPDATE posts SET status = 'removed' WHERE author_id = $1 AND status <> 'removed'`, [id]);
    await q.query(`UPDATE characters SET deleted_at = COALESCE(deleted_at, now()), name = '', description = '' WHERE user_id = $1`, [id]);
    await q.query(`UPDATE brand_kits SET deleted_at = COALESCE(deleted_at, now()), name = '', tone = '', banned = '[]', fonts = '[]' WHERE user_id = $1`, [id]);
    await q.query(`UPDATE projects SET deleted_at = COALESCE(deleted_at, now()), name = '' WHERE user_id = $1`, [id]);
    await q.query(`UPDATE canvases SET doc = '{}', name = '' WHERE user_id = $1`, [id]);
    await q.query('DELETE FROM canvas_snapshots WHERE user_id = $1', [id]);
    // 评论：清空内容并删除（顶层评论下的回复一并删除），同步作品的评论数；关注关系双向删除
    const gone = await q.query<{ post_id: string }>(`UPDATE post_comments SET status = 'removed', body = CASE WHEN author_id = $1 THEN '' ELSE body END
          WHERE (author_id = $1 OR parent_id IN (SELECT id FROM post_comments WHERE author_id = $1)) AND status <> 'removed' RETURNING post_id`, [id]);
    if (gone.length) {
      await q.query(
        `UPDATE posts p SET comment_count = (SELECT COUNT(*)::int FROM post_comments c WHERE c.post_id = p.id AND c.status = 'published') WHERE p.id = ANY($1::text[])`,
        [[...new Set(gone.map((g) => g.post_id))]],
      );
    }
    await q.query('DELETE FROM user_follows WHERE follower_id = $1 OR followee_id = $1', [id]);
    await q.query('UPDATE canvas_shares SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    // 点赞：删除并重算被点赞作品的计数
    const liked = await q.query<{ post_id: string }>('DELETE FROM post_likes WHERE user_id = $1 RETURNING post_id', [id]);
    if (liked.length) {
      await q.query(`UPDATE posts p SET like_count = (SELECT COUNT(*)::int FROM post_likes l WHERE l.post_id = p.id) WHERE p.id = ANY($1::text[])`, [liked.map((l) => l.post_id)]);
    }
    await q.query('UPDATE analytics_events SET user_id = NULL WHERE user_id = $1', [id]);
    await this.audit(q, 'system', 'user.deleted', id, {});
  }

  /** 个人信息副本（JSON）：账号、积分、订单、生成记录、作品（含 2 小时有效的下载地址）、发布、角色、品牌套件与项目 */
  async export(userId: string) {
    const [n] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE actor_id = $1 AND action = 'user.export' AND created_at > now() - interval '1 day'`, [userId]);
    if (n.n >= EXPORT_DAILY_LIMIT) throw Errors.rateLimited(`每天最多导出 ${EXPORT_DAILY_LIMIT} 次，请明天再试`, 3600);
    await this.audit(this.db, userId, 'user.export', userId, {});

    const [u] = await this.db.query<{ id: string; nickname: string; phone_enc: string; plan_code: PlanCode; plan_expires_at: Date | null; created_at: Date }>(
      'SELECT id, nickname, phone_enc, plan_code, plan_expires_at, created_at FROM users WHERE id = $1',
      [userId],
    );
    const accountId = await this.credits.accountIdFor(userId);
    const [balance, ledger, orders, tasks, assets, posts, characters, brandKits, projects, ratings] = await Promise.all([
      this.credits.balanceForUser(userId),
      this.db.query('SELECT entry_type, delta_available, delta_frozen, balance_after, task_id, memo, created_at FROM credit_ledger WHERE account_id = $1 ORDER BY id', [accountId]),
      this.db.query('SELECT order_no, item_type, item_ref, cycle, amount_fen, credits, status, pay_channel, created_at, paid_at FROM orders WHERE user_id = $1 ORDER BY id', [userId]),
      this.db.query(
        `SELECT id, modality, operation, prompt, params, model_code, status, COALESCE(actual_credits, estimated_credits) AS credits, source, template_id, created_at, finished_at
           FROM generation_tasks WHERE user_id = $1 ORDER BY id`,
        [userId],
      ),
      this.db.query<AssetRow>('SELECT * FROM assets WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id', [userId]),
      this.db.query(`SELECT id, asset_id, title, prompt, show_prompt, tags, like_count, remix_count, status, created_at FROM posts WHERE author_id = $1 ORDER BY id`, [userId]),
      this.db.query(
        `SELECT c.id, c.name, c.description, c.likeness, c.consent_asset_id, c.created_at,
                COALESCE((SELECT json_agg(json_build_object('asset_id', r.asset_id, 'view', r.view) ORDER BY r.position) FROM character_refs r WHERE r.character_id = c.id), '[]') AS refs
           FROM characters c WHERE c.user_id = $1 AND c.deleted_at IS NULL ORDER BY c.id`,
        [userId],
      ),
      this.db.query('SELECT id, name, tone, colors, fonts, banned, logos, created_at FROM brand_kits WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id', [userId]),
      this.db.query('SELECT id, name, created_at, updated_at FROM projects WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id', [userId]),
      this.db.query('SELECT template_id, score, updated_at FROM template_ratings WHERE user_id = $1 ORDER BY template_id', [userId]),
    ]);
    return {
      exported_at: new Date().toISOString(),
      note: '作品下载地址 2 小时内有效；生成作品的文件带 AI 生成标识。',
      account: {
        id: u.id,
        nickname: u.nickname,
        phone: decryptPhone(u.phone_enc, this.config.phoneEncKey),
        plan: { code: u.plan_code, name: (PLANS[u.plan_code] ?? PLANS.free).name, expires_at: u.plan_expires_at },
        created_at: u.created_at,
      },
      credits: { balance, ledger },
      orders,
      generations: tasks,
      assets: assets.map((r) => {
        const a = this.assets.toDTO(r);
        return { id: a.id, kind: a.kind, source: a.source, title: a.title, prompt: a.prompt, text: a.text, content_id: a.content_id, favorite: a.favorite, created_at: a.created_at, url: a.url };
      }),
      posts,
      characters,
      brand_kits: brandKits,
      projects,
      template_ratings: ratings,
    };
  }

  private async audit(q: Queryable, actorId: string, action: string, userId: string, detail: Record<string, unknown>) {
    await q.query('INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)', [newId('aud'), actorId, action, 'user', userId, JSON.stringify(detail)]);
  }
}
