import { Inject, Injectable } from '@nestjs/common';
import { MODELS, type AdminModelDTO, type AdminOverviewDTO, type PostDTO, type ReportReason, type ReviewItemDTO } from '@creature/shared';
import { Errors } from '../common/errors';
import { newId } from '../common/ids';
import { addDays, cnDateKey, endOfCnDay } from '../common/time';
import { CommunityService } from '../community/community.service';
import { Db, DB } from '../db/db';
import { ModelGateway } from '../gateway/model-gateway.service';
import { ModerationService } from '../safety/moderation.service';

const TREND_DAYS = 14;

// 需要复核的作品：机审存疑、被举报自动隐藏、或已发布但有未处理的举报
const REVIEW_WHERE = `(p.status = 'reviewing'
   OR (p.status = 'hidden' AND p.hidden_reason = 'reports')
   OR (p.status = 'published' AND EXISTS (SELECT 1 FROM reports r WHERE r.target_type = 'post' AND r.target_id = p.id AND r.status = 'open')))`;

/** 管理后台 v1：运营概览、模型健康度、广场内容复核（每次处理写审核记录与审计日志） */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly gateway: ModelGateway,
    private readonly community: CommunityService,
    private readonly moderation: ModerationService,
  ) {}

  async overview(): Promise<AdminOverviewDTO> {
    const now = new Date();
    const todayStart = addDays(endOfCnDay(now), -1);
    const trendStart = addDays(todayStart, -(TREND_DAYS - 1));
    const [[users], [tasks], [revenue], [consumed], [queue], [reviews], days] = await Promise.all([
      this.db.query<{ total: number; today: number }>(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > $1)::int AS today FROM users`, [todayStart]),
      this.db.query<{ total: number; ok: number; done: number }>(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'succeeded')::int AS ok,
                COUNT(*) FILTER (WHERE status IN ('succeeded', 'failed'))::int AS done
           FROM generation_tasks WHERE created_at > $1`,
        [todayStart],
      ),
      this.db.query<{ fen: number }>(`SELECT COALESCE(SUM(amount_fen), 0)::int AS fen FROM orders WHERE status = 'paid' AND paid_at > $1`, [todayStart]),
      this.db.query<{ credits: number }>(`SELECT COALESCE(SUM(-delta_frozen), 0)::int AS credits FROM credit_ledger WHERE entry_type = 'settle' AND created_at > $1`, [todayStart]),
      this.db.query<{ queued: number; running: number }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued, COUNT(*) FILTER (WHERE status IN ('running', 'post_processing'))::int AS running
           FROM generation_tasks WHERE status IN ('queued', 'running', 'post_processing')`,
      ),
      this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM posts p WHERE ${REVIEW_WHERE}`),
      this.db.query<{ created_at: Date; status: string }>(`SELECT created_at, status FROM generation_tasks WHERE created_at > $1`, [trendStart]),
    ]);
    // 按北京时间分天统计（在应用层分组，避免依赖数据库时区设置）
    const trend = Array.from({ length: TREND_DAYS }, (_, i) => ({ date: cnDateKey(addDays(trendStart, i + 0.5)), tasks: 0, succeeded: 0 }));
    const byDate = new Map(trend.map((d) => [d.date, d]));
    for (const t of days) {
      const d = byDate.get(cnDateKey(new Date(t.created_at)));
      if (!d) continue;
      d.tasks++;
      if (t.status === 'succeeded') d.succeeded++;
    }
    return {
      users_total: users.total,
      users_new_today: users.today,
      tasks_today: tasks.total,
      success_rate_today: tasks.done ? tasks.ok / tasks.done : null,
      revenue_today_fen: revenue.fen,
      credits_consumed_today: consumed.credits,
      queue,
      pending_reviews: reviews.n,
      trend,
    };
  }

  async models(): Promise<{ data: AdminModelDTO[] }> {
    const stats = await this.db.query<{ code: string; n: number; ok: number; done: number; p95: number | null }>(
      `SELECT COALESCE(used_model_code, model_code) AS code, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'succeeded')::int AS ok,
              COUNT(*) FILTER (WHERE status IN ('succeeded', 'failed'))::int AS done,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))) FILTER (WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL) AS p95
         FROM generation_tasks WHERE created_at > now() - interval '24 hours' GROUP BY 1`,
    );
    const byCode = new Map(stats.map((s) => [s.code, s]));
    const health = new Map(this.gateway.health().map((h) => [h.code, h]));
    return {
      data: MODELS.map((m) => {
        const s = byCode.get(m.code);
        const h = health.get(m.code);
        return {
          code: m.code,
          name: m.name,
          modality: m.modality,
          enabled: this.gateway.configured(m.code),
          breaker_open: h?.breakerOpen ?? false,
          window_samples: h?.samples ?? 0,
          window_success_rate: h?.successRate ?? null,
          tasks_24h: s?.n ?? 0,
          success_rate_24h: s?.done ? s.ok / s.done : null,
          p95_sec_24h: s?.p95 != null ? Math.round(Number(s.p95) * 10) / 10 : null,
        };
      }),
    };
  }

  async reviewQueue(adminId: string): Promise<{ data: ReviewItemDTO[] }> {
    const rows = await this.community.rows(adminId, `${REVIEW_WHERE} ORDER BY p.created_at LIMIT 100`, []);
    if (!rows.length) return { data: [] };
    const ids = rows.map((r) => r.id);
    const [reports, labels] = await Promise.all([
      this.db.query<{ target_id: string; reason: ReportReason; n: number }>(
        `SELECT target_id, reason, COUNT(*)::int AS n FROM reports WHERE target_type = 'post' AND status = 'open' AND target_id = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 3 DESC`,
        [ids],
      ),
      this.db.query<{ target_id: string; labels: string[] }>(
        `SELECT DISTINCT ON (target_id) target_id, labels FROM moderation_records
          WHERE target_type = 'post' AND stage = 'machine' AND target_id = ANY($1::text[]) ORDER BY target_id, created_at DESC`,
        [ids],
      ),
    ]);
    const labelMap = new Map(labels.map((l) => [l.target_id, l.labels]));
    return {
      data: rows.map((r) => ({
        post: this.adminView(this.community.toDTO(r, adminId), r.prompt),
        reason: r.status === 'reviewing' ? 'reviewing' : 'reported',
        machine_labels: labelMap.get(r.id) ?? [],
        reports: reports.filter((x) => x.target_id === r.id).map((x) => ({ reason: x.reason, count: x.n })),
      })),
    };
  }

  /** 复核决定：approve 发布（驳回举报），remove 下架（举报成立） */
  async decide(adminId: string, postId: string, action: 'approve' | 'remove', note?: string): Promise<PostDTO> {
    await this.db.tx(async (q) => {
      const [p] = await q.query<{ id: string; author_id: string; status: string }>(`SELECT id, author_id, status FROM posts WHERE id = $1 AND status <> 'removed' FOR UPDATE`, [postId]);
      if (!p) throw Errors.notFound('作品');
      if (action === 'approve') {
        await q.query(`UPDATE posts SET status = 'published', hidden_reason = NULL, report_count = 0, published_at = COALESCE(published_at, now()) WHERE id = $1`, [postId]);
      } else {
        await q.query(`UPDATE posts SET status = 'hidden', hidden_reason = 'admin' WHERE id = $1`, [postId]);
      }
      await q.query(`UPDATE reports SET status = $2, handled_by = $3, handled_at = now() WHERE target_type = 'post' AND target_id = $1 AND status = 'open'`, [
        postId,
        action === 'approve' ? 'rejected' : 'resolved',
        adminId,
      ]);
      await this.moderation.record(
        { userId: p.author_id, targetType: 'post', targetId: postId, result: { verdict: action === 'approve' ? 'pass' : 'block', labels: note ? [`note:${note}`] : [] }, reviewerId: adminId },
        q,
      );
      await q.query('INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)', [
        newId('aud'),
        adminId,
        `post.${action}`,
        'post',
        postId,
        JSON.stringify({ from: p.status, note: note ?? null }),
      ]);
    });
    const [row] = await this.community.rows(adminId, 'p.id = $2', [postId]);
    return this.adminView(this.community.toDTO(row, adminId), row.prompt);
  }

  /** 审核员需要看到完整提示词，即使作者选择不公开 */
  private adminView(post: PostDTO, prompt: string): PostDTO {
    return { ...post, prompt };
  }
}
