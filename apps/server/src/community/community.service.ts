import { Inject, Injectable } from '@nestjs/common';
import type { FeedTab, GenerationParams, Page, PostDTO, PostStatus, RemixDTO, ReportReason } from '@creature/shared';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { Db, DB, isUniqueViolation, type Queryable } from '../db/db';
import { ModerationService } from '../safety/moderation.service';
import { StorageService } from '../storage/storage.service';

const DAILY_POSTS = 20;
const DAILY_REPORTS = 20;
/** 累计举报达到该数量时自动隐藏，等待人工复核 */
export const AUTO_HIDE_REPORTS = 3;

export interface PostRow {
  id: string;
  author_id: string;
  asset_id: string;
  kind: 'image' | 'video';
  title: string;
  prompt: string;
  show_prompt: boolean;
  tags: string[];
  model_code: string | null;
  model_name: string;
  params: GenerationParams;
  like_count: number;
  remix_count: number;
  report_count: number;
  status: PostStatus;
  hidden_reason: 'reports' | 'admin' | null;
  published_at: Date | null;
  created_at: Date;
  author_nickname: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  content_id: string;
  liked: boolean;
}

/** 列表与详情共用的查询：作品 + 作者 + 文件 + 当前用户是否点赞（$1 为当前用户） */
export const POST_SELECT = `
  SELECT p.*, u.nickname AS author_nickname, a.storage_key, a.width, a.height, a.duration_ms, a.content_id,
         EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked
    FROM posts p JOIN users u ON u.id = p.author_id JOIN assets a ON a.id = p.asset_id`;

// 推荐：互动越多越靠前，按发布时长衰减（类似 Hacker News 排序）
const RECOMMEND_SCORE = `(p.like_count * 2 + p.remix_count * 3 + 1) / power(EXTRACT(EPOCH FROM (now() - p.published_at)) / 3600 + 2, 1.5)`;
const ORDER: Record<FeedTab, string> = {
  recommend: `${RECOMMEND_SCORE} DESC, p.id DESC`,
  latest: 'p.published_at DESC, p.id DESC',
  hot: 'p.like_count DESC, p.published_at DESC, p.id DESC',
  mine: 'p.created_at DESC, p.id DESC',
};

interface AssetForPost {
  id: string;
  user_id: string;
  kind: string;
  source: 'generated' | 'uploaded';
  prompt: string;
  model_name: string;
  model_code: string | null;
  params: GenerationParams | null;
}

/**
 * 灵感广场：只能发布自己的 AI 生成作品（图像 / 视频），发布时机审，存疑进入人工复核；
 * 点赞与做同款按人去重；累计举报达到阈值自动隐藏，等待后台复核。
 */
@Injectable()
export class CommunityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly moderation: ModerationService,
  ) {}

  toDTO(r: PostRow, viewerId: string): PostDTO {
    const mine = r.author_id === viewerId;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      prompt: r.show_prompt || mine ? r.prompt : null,
      tags: r.tags ?? [],
      author: { id: r.author_id, nickname: r.author_nickname },
      model: r.model_name,
      url: this.storage.signedUrl(r.storage_key),
      width: r.width ?? undefined,
      height: r.height ?? undefined,
      duration_sec: r.duration_ms ? Math.round(r.duration_ms / 100) / 10 : undefined,
      content_id: r.content_id,
      like_count: r.like_count,
      remix_count: r.remix_count,
      liked: r.liked,
      mine,
      status: r.status,
      published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
      created_at: new Date(r.created_at).toISOString(),
    };
  }

  /** 广场列表；mine 为自己的全部发布（含审核中、已隐藏） */
  async feed(viewerId: string, f: { tab: FeedTab; kind?: 'image' | 'video'; cursor?: string; limit: number }): Promise<Page<PostDTO>> {
    const offset = f.cursor && /^o\d{1,5}$/.test(f.cursor) ? Number(f.cursor.slice(1)) : 0;
    const where = f.tab === 'mine' ? `p.author_id = $1 AND p.status <> 'removed'` : `p.status = 'published'`;
    const rows = await this.db.query<PostRow>(
      `${POST_SELECT} WHERE ${where} AND ($2::text IS NULL OR p.kind = $2) ORDER BY ${ORDER[f.tab]} LIMIT $3 OFFSET $4`,
      [viewerId, f.kind ?? null, f.limit + 1, offset],
    );
    const page = rows.slice(0, f.limit);
    return { data: page.map((r) => this.toDTO(r, viewerId)), next_cursor: rows.length > f.limit ? `o${offset + f.limit}` : null };
  }

  /** 作品详情：已发布的作品所有人可见，其余状态只有作者可见 */
  async get(viewerId: string, id: string): Promise<PostDTO> {
    return this.toDTO(await this.visible(viewerId, id), viewerId);
  }

  async publish(userId: string, b: { asset_id: string; title: string; tags: string[]; show_prompt: boolean }): Promise<PostDTO> {
    const [asset] = await this.db.query<AssetForPost>(
      `SELECT a.id, a.user_id, a.kind, a.source, a.prompt, a.model_name, COALESCE(t.used_model_code, t.model_code) AS model_code, t.params
         FROM assets a LEFT JOIN generation_tasks t ON t.id = a.task_id
        WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL`,
      [b.asset_id, userId],
    );
    if (!asset) throw Errors.notFound('作品');
    if (asset.source === 'uploaded') throw Errors.invalid('上传的素材不能发布到灵感广场，只能发布 AI 生成的作品');
    if (asset.kind !== 'image' && asset.kind !== 'video') throw Errors.invalid('目前只支持发布图像和视频作品');

    const existing = await this.existingPost(b.asset_id);
    if (existing) return this.get(userId, existing);

    const [{ n }] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM posts WHERE author_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
    if (n >= DAILY_POSTS) throw Errors.rateLimited('今天发布的作品已达上限，请明天再试', 3600);

    const tags = [...new Set(b.tags.map((t) => t.trim()).filter(Boolean))];
    const postId = newId('pst');
    const verdict = this.moderation.checkPost({ title: b.title, tags, prompt: asset.prompt });
    await this.moderation.record({ userId, targetType: 'post', targetId: postId, result: verdict });
    if (verdict.verdict === 'block') throw new AppError('CONTENT_REJECTED', 422, '标题、标签或提示词可能违反社区规范，未发布', { reason_code: verdict.labels[0] ?? 'post' });

    const status: PostStatus = verdict.verdict === 'review' ? 'reviewing' : 'published';
    try {
      await this.db.query(
        `INSERT INTO posts (id, author_id, asset_id, kind, title, prompt, show_prompt, tags, model_code, model_name, params, status, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12 = 'published' THEN now() END)`,
        [postId, userId, asset.id, asset.kind, b.title, asset.prompt, b.show_prompt, JSON.stringify(tags), asset.model_code, asset.model_name, JSON.stringify(asset.params ?? {}), status],
      );
    } catch (e) {
      // 并发发布同一作品：返回已存在的那条
      if (isUniqueViolation(e)) return this.get(userId, (await this.existingPost(b.asset_id))!);
      throw e;
    }
    return this.get(userId, postId);
  }

  /** 作者撤回发布 */
  async withdraw(userId: string, id: string): Promise<void> {
    const r = await this.db.query(`UPDATE posts SET status = 'removed' WHERE id = $1 AND author_id = $2 AND status <> 'removed' RETURNING id`, [id, userId]);
    if (!r.length) throw Errors.notFound('作品');
  }

  async setLike(userId: string, id: string, on: boolean): Promise<{ liked: boolean; like_count: number }> {
    await this.published(userId, id);
    return this.db.tx(async (q) => {
      const changed = on
        ? await q.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING post_id', [id, userId])
        : await q.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 RETURNING post_id', [id, userId]);
      const [p] = changed.length
        ? await q.query<{ like_count: number }>(`UPDATE posts SET like_count = GREATEST(0, like_count + $2) WHERE id = $1 RETURNING like_count`, [id, on ? 1 : -1])
        : await q.query<{ like_count: number }>('SELECT like_count FROM posts WHERE id = $1', [id]);
      return { liked: on, like_count: p.like_count };
    });
  }

  /** 做同款：返回预填参数；每人只计一次，作者自己不计 */
  async remix(userId: string, id: string): Promise<RemixDTO> {
    const p = await this.visible(userId, id);
    if (p.author_id !== userId) {
      await this.db.tx(async (q) => {
        const added = await q.query('INSERT INTO post_remixes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING post_id', [id, userId]);
        if (added.length) await q.query('UPDATE posts SET remix_count = remix_count + 1 WHERE id = $1', [id]);
      });
    }
    return { modality: p.kind, prompt: p.show_prompt || p.author_id === userId ? p.prompt : '', params: p.params ?? {}, model_code: p.model_code };
  }

  /** 举报：同一用户对同一作品只记一次；累计达到阈值的已发布作品自动隐藏 */
  async report(userId: string, b: { target_type: 'post'; target_id: string; reason: ReportReason; detail?: string }): Promise<{ id: string; status: 'open' }> {
    // 只能举报广场上可见的作品；已隐藏或审核中的作品已在复核队列里
    const [p] = await this.db.query<{ id: string; author_id: string }>(`SELECT id, author_id FROM posts WHERE id = $1 AND status = 'published'`, [b.target_id]);
    if (!p) throw Errors.notFound('作品');
    if (p.author_id === userId) throw Errors.invalid('不能举报自己的作品');
    const [{ n }] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM reports WHERE reporter_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
    if (n >= DAILY_REPORTS) throw Errors.rateLimited('今天的举报次数已达上限', 3600);

    return this.db.tx(async (q) => {
      const [added] = await q.query<{ id: string }>(
        `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, detail) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING RETURNING id`,
        [newId('rpt'), userId, b.target_type, b.target_id, b.reason, b.detail ?? null],
      );
      if (!added) {
        const [old] = await q.query<{ id: string }>('SELECT id FROM reports WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3', [userId, b.target_type, b.target_id]);
        return { id: old.id, status: 'open' as const };
      }
      await q.query(
        `UPDATE posts SET report_count = report_count + 1,
                hidden_reason = CASE WHEN status = 'published' AND report_count + 1 >= $2 THEN 'reports' ELSE hidden_reason END,
                status = CASE WHEN status = 'published' AND report_count + 1 >= $2 THEN 'hidden' ELSE status END
          WHERE id = $1`,
        [b.target_id, AUTO_HIDE_REPORTS],
      );
      return { id: added.id, status: 'open' as const };
    });
  }

  async rows(viewerId: string, where: string, params: unknown[], q: Queryable = this.db): Promise<PostRow[]> {
    return q.query<PostRow>(`${POST_SELECT} WHERE ${where}`, [viewerId, ...params]);
  }

  private async existingPost(assetId: string): Promise<string | null> {
    const [r] = await this.db.query<{ id: string }>(`SELECT id FROM posts WHERE asset_id = $1 AND status <> 'removed'`, [assetId]);
    return r?.id ?? null;
  }

  private async visible(viewerId: string, id: string): Promise<PostRow> {
    const [r] = await this.rows(viewerId, `p.id = $2 AND (p.status = 'published' OR (p.author_id = $1 AND p.status <> 'removed'))`, [id]);
    if (!r) throw Errors.notFound('作品');
    return r;
  }

  private async published(viewerId: string, id: string): Promise<PostRow> {
    const [r] = await this.rows(viewerId, `p.id = $2 AND p.status = 'published'`, [id]);
    if (!r) throw Errors.notFound('作品');
    return r;
  }
}
