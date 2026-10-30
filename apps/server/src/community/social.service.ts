import { Inject, Injectable } from '@nestjs/common';
import { REPLIES_PREVIEW, type CommentDTO, type CommentReviewDTO, type CommentThreadDTO, type CreatorDTO, type Page, type ReportReason } from '@creature/shared';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { Db, DB, type Queryable } from '../db/db';
import { ModerationService } from '../safety/moderation.service';
import { AUTO_HIDE_REPORTS } from './community.service';

/** 每人每天最多发表的评论数 */
const DAILY_COMMENTS = 200;
/** 每人最多关注的人数 */
const MAX_FOLLOWING = 2000;
const DAILY_REPORTS = 20;

interface CommentRow {
  id: string;
  post_id: string;
  author_id: string;
  author_nickname: string;
  parent_id: string | null;
  reply_to_id: string | null;
  reply_to_nickname: string | null;
  body: string;
  status: 'published' | 'hidden' | 'removed';
  report_count: number;
  created_at: Date;
  post_author_id: string;
}

const COMMENT_SELECT = `
  SELECT c.*, u.nickname AS author_nickname, r.nickname AS reply_to_nickname, p.author_id AS post_author_id
    FROM post_comments c JOIN users u ON u.id = c.author_id JOIN posts p ON p.id = c.post_id LEFT JOIN users r ON r.id = c.reply_to_id`;

/**
 * 广场的评论与关注。
 * 评论：只对已发布的作品开放；一层回复；发表前机审（命中拦截词直接拒绝）；评论作者或作品作者可以删除；
 * 累计举报达到阈值自动隐藏，进入后台评论复核。
 * 关注：关注流按发布时间排列关注的创作者的作品；创作者主页展示粉丝、关注、作品与获赞数。
 */
@Injectable()
export class SocialService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly moderation: ModerationService,
  ) {}

  private toDTO(r: CommentRow, viewerId: string): CommentDTO {
    return {
      id: r.id,
      post_id: r.post_id,
      author: { id: r.author_id, nickname: r.author_nickname },
      reply_to: r.reply_to_id ? { id: r.reply_to_id, nickname: r.reply_to_nickname ?? '' } : null,
      body: r.body,
      created_at: new Date(r.created_at).toISOString(),
      can_delete: r.author_id === viewerId || r.post_author_id === viewerId,
      mine: r.author_id === viewerId,
    };
  }

  private async publishedPost(id: string): Promise<{ id: string; author_id: string }> {
    const [p] = await this.db.query<{ id: string; author_id: string }>(`SELECT id, author_id FROM posts WHERE id = $1 AND status = 'published'`, [id]);
    if (!p) throw Errors.notFound('作品');
    return p;
  }

  // ---------- 评论 ----------

  /** 顶层评论（最新在前）及每条最早的几条回复 */
  async comments(viewerId: string, postId: string, f: { cursor?: string; limit: number }): Promise<Page<CommentThreadDTO>> {
    await this.publishedPost(postId);
    const offset = f.cursor && /^o\d{1,5}$/.test(f.cursor) ? Number(f.cursor.slice(1)) : 0;
    const top = await this.db.query<CommentRow>(
      `${COMMENT_SELECT} WHERE c.post_id = $1 AND c.parent_id IS NULL AND c.status = 'published' ORDER BY c.created_at DESC, c.id DESC LIMIT $2 OFFSET $3`,
      [postId, f.limit + 1, offset],
    );
    const page = top.slice(0, f.limit);
    const ids = page.map((c) => c.id);
    const [replies, counts] = ids.length
      ? await Promise.all([
          this.db.query<CommentRow & { rn: number }>(
            `SELECT * FROM (${COMMENT_SELECT.replace('SELECT c.*', 'SELECT c.*, row_number() OVER (PARTITION BY c.parent_id ORDER BY c.created_at, c.id) AS rn')}
               WHERE c.parent_id = ANY($1::text[]) AND c.status = 'published') x WHERE rn <= $2 ORDER BY created_at, id`,
            [ids, REPLIES_PREVIEW],
          ),
          this.db.query<{ parent_id: string; n: number }>(
            `SELECT parent_id, COUNT(*)::int AS n FROM post_comments WHERE parent_id = ANY($1::text[]) AND status = 'published' GROUP BY parent_id`,
            [ids],
          ),
        ])
      : [[], []];
    const count = new Map(counts.map((c) => [c.parent_id, c.n]));
    return {
      data: page.map((c) => ({
        ...this.toDTO(c, viewerId),
        reply_count: count.get(c.id) ?? 0,
        replies: replies.filter((r) => r.parent_id === c.id).map((r) => this.toDTO(r, viewerId)),
      })),
      next_cursor: top.length > f.limit ? `o${offset + f.limit}` : null,
    };
  }

  /** 某条评论的全部回复（按时间正序） */
  async replies(viewerId: string, commentId: string, f: { cursor?: string; limit: number }): Promise<Page<CommentDTO>> {
    const [parent] = await this.db.query<{ post_id: string }>(`SELECT post_id FROM post_comments WHERE id = $1 AND parent_id IS NULL AND status = 'published'`, [commentId]);
    if (!parent) throw Errors.notFound('评论');
    await this.publishedPost(parent.post_id);
    const offset = f.cursor && /^o\d{1,5}$/.test(f.cursor) ? Number(f.cursor.slice(1)) : 0;
    const rows = await this.db.query<CommentRow>(`${COMMENT_SELECT} WHERE c.parent_id = $1 AND c.status = 'published' ORDER BY c.created_at, c.id LIMIT $2 OFFSET $3`, [
      commentId,
      f.limit + 1,
      offset,
    ]);
    return { data: rows.slice(0, f.limit).map((r) => this.toDTO(r, viewerId)), next_cursor: rows.length > f.limit ? `o${offset + f.limit}` : null };
  }

  /** 发表评论；parent_id 为顶层评论或回复（回复的回复会挂到顶层评论下，并记录被回复者） */
  async comment(userId: string, postId: string, b: { body: string; parent_id?: string }): Promise<CommentDTO> {
    await this.publishedPost(postId);
    const [{ n }] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM post_comments WHERE author_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
    if (n >= DAILY_COMMENTS) throw Errors.rateLimited('今天的评论次数已达上限', 3600);
    let parentId: string | null = null;
    let replyTo: string | null = null;
    if (b.parent_id) {
      const [p] = await this.db.query<{ id: string; parent_id: string | null; author_id: string }>(
        `SELECT id, parent_id, author_id FROM post_comments WHERE id = $1 AND post_id = $2 AND status = 'published'`,
        [b.parent_id, postId],
      );
      if (!p) throw Errors.notFound('评论');
      parentId = p.parent_id ?? p.id;
      if (p.parent_id) replyTo = p.author_id;
    }
    const id = newId('cmt');
    const v = this.moderation.checkText(b.body);
    await this.moderation.record({ userId, targetType: 'comment', targetId: id, result: v });
    if (v.verdict === 'block') throw new AppError('CONTENT_REJECTED', 422, '评论可能违反社区规范，请修改后再发', { reason_code: 'comment' });
    await this.db.tx(async (q) => {
      await q.query('INSERT INTO post_comments (id, post_id, author_id, parent_id, reply_to_id, body) VALUES ($1, $2, $3, $4, $5, $6)', [id, postId, userId, parentId, replyTo, b.body]);
      await q.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [postId]);
    });
    return this.toDTO(await this.row(id), userId);
  }

  /** 删除评论：评论作者或作品作者；删除顶层评论时其回复一并删除 */
  async deleteComment(userId: string, id: string): Promise<void> {
    const c = await this.row(id);
    if (c.status === 'removed') throw Errors.notFound('评论');
    if (c.author_id !== userId && c.post_author_id !== userId) throw new AppError('FORBIDDEN', 403, '只能删除自己的评论或自己作品下的评论');
    await this.remove(this.db, c);
  }

  private async remove(q: Queryable, c: Pick<CommentRow, 'id' | 'post_id'>) {
    const removed = await q.query<{ id: string; was: string }>(
      `UPDATE post_comments x SET status = 'removed' FROM (SELECT id, status AS was FROM post_comments WHERE (id = $1 OR parent_id = $1) AND status <> 'removed' FOR UPDATE) y
        WHERE x.id = y.id RETURNING x.id, y.was`,
      [c.id],
    );
    const visible = removed.filter((r) => r.was === 'published').length;
    if (visible) await q.query('UPDATE posts SET comment_count = GREATEST(0, comment_count - $2) WHERE id = $1', [c.post_id, visible]);
  }

  async reportComment(userId: string, b: { target_id: string; reason: ReportReason; detail?: string }): Promise<{ id: string; status: 'open' }> {
    const [c] = await this.db.query<{ id: string; author_id: string; post_id: string }>(
      `SELECT c.id, c.author_id, c.post_id FROM post_comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1 AND c.status = 'published' AND p.status = 'published'`,
      [b.target_id],
    );
    if (!c) throw Errors.notFound('评论');
    if (c.author_id === userId) throw Errors.invalid('不能举报自己的评论');
    const [{ n }] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM reports WHERE reporter_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
    if (n >= DAILY_REPORTS) throw Errors.rateLimited('今天的举报次数已达上限', 3600);
    return this.db.tx(async (q) => {
      const [added] = await q.query<{ id: string }>(
        `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, detail) VALUES ($1, $2, 'comment', $3, $4, $5)
         ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING RETURNING id`,
        [newId('rpt'), userId, b.target_id, b.reason, b.detail ?? null],
      );
      if (!added) {
        const [old] = await q.query<{ id: string }>(`SELECT id FROM reports WHERE reporter_id = $1 AND target_type = 'comment' AND target_id = $2`, [userId, b.target_id]);
        return { id: old.id, status: 'open' as const };
      }
      const [hit] = await q.query<{ status: string }>(
        `UPDATE post_comments SET report_count = report_count + 1,
                status = CASE WHEN status = 'published' AND report_count + 1 >= $2 THEN 'hidden' ELSE status END
          WHERE id = $1 RETURNING status`,
        [b.target_id, AUTO_HIDE_REPORTS],
      );
      if (hit.status === 'hidden') await q.query('UPDATE posts SET comment_count = GREATEST(0, comment_count - 1) WHERE id = $1', [c.post_id]);
      return { id: added.id, status: 'open' as const };
    });
  }

  // ---------- 后台复核 ----------

  async reviewQueue(): Promise<{ data: CommentReviewDTO[] }> {
    const rows = await this.db.query<CommentRow & { post_title: string }>(
      `${COMMENT_SELECT.replace('SELECT c.*', 'SELECT c.*, p.title AS post_title')} WHERE c.status = 'hidden' ORDER BY c.created_at LIMIT 100`,
    );
    const reasons = rows.length
      ? await this.db.query<{ target_id: string; reason: ReportReason; n: number }>(
          `SELECT target_id, reason, COUNT(*)::int AS n FROM reports WHERE target_type = 'comment' AND target_id = ANY($1::text[]) AND status = 'open' GROUP BY target_id, reason ORDER BY n DESC`,
          [rows.map((r) => r.id)],
        )
      : [];
    return {
      data: rows.map((r) => ({
        comment: { ...this.toDTO(r, ''), status: r.status },
        post: { id: r.post_id, title: r.post_title },
        report_count: r.report_count,
        reasons: reasons.filter((x) => x.target_id === r.id).map((x) => ({ reason: x.reason, count: x.n })),
      })),
    };
  }

  /** 复核：通过则恢复显示并驳回举报；下架则删除（含回复）并认定举报成立 */
  async decide(adminId: string, id: string, action: 'approve' | 'remove', note?: string): Promise<void> {
    const c = await this.row(id);
    if (c.status !== 'hidden') throw Errors.conflict('NOT_IN_REVIEW', '该评论不在复核队列中');
    await this.db.tx(async (q) => {
      if (action === 'approve') {
        await q.query(`UPDATE post_comments SET status = 'published', report_count = 0 WHERE id = $1`, [id]);
        await q.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [c.post_id]);
      } else {
        await this.remove(q, c);
      }
      await q.query(`UPDATE reports SET status = $2, handled_by = $3, handled_at = now() WHERE target_type = 'comment' AND target_id = $1 AND status = 'open'`, [
        id,
        action === 'approve' ? 'rejected' : 'resolved',
        adminId,
      ]);
      await this.moderation.record({ userId: c.author_id, targetType: 'comment', targetId: id, result: { verdict: action === 'approve' ? 'pass' : 'block', labels: ['human'] }, reviewerId: adminId }, q);
      await q.query('INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)', [
        newId('aud'),
        adminId,
        `comment.${action}`,
        'comment',
        id,
        JSON.stringify({ note: note ?? '' }),
      ]);
    });
  }

  private async row(id: string): Promise<CommentRow> {
    const [c] = await this.db.query<CommentRow>(`${COMMENT_SELECT} WHERE c.id = $1`, [id]);
    if (!c) throw Errors.notFound('评论');
    return c;
  }

  // ---------- 关注 ----------

  async setFollow(userId: string, targetId: string, on: boolean): Promise<CreatorDTO> {
    if (targetId === userId) throw Errors.invalid('不能关注自己');
    await this.activeUser(targetId);
    if (on) {
      const [{ n }] = await this.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM user_follows WHERE follower_id = $1', [userId]);
      if (n >= MAX_FOLLOWING) throw Errors.invalid(`最多关注 ${MAX_FOLLOWING} 位创作者`);
      await this.db.query('INSERT INTO user_follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, targetId]);
    } else {
      await this.db.query('DELETE FROM user_follows WHERE follower_id = $1 AND followee_id = $2', [userId, targetId]);
    }
    return this.creator(userId, targetId);
  }

  async creator(viewerId: string, id: string): Promise<CreatorDTO> {
    const u = await this.activeUser(id);
    const [s] = await this.db.query<{ followers: number; following: number; posts: number; likes: number; followed: boolean }>(
      `SELECT (SELECT COUNT(*)::int FROM user_follows WHERE followee_id = $1) AS followers,
              (SELECT COUNT(*)::int FROM user_follows WHERE follower_id = $1) AS following,
              (SELECT COUNT(*)::int FROM posts WHERE author_id = $1 AND status = 'published') AS posts,
              (SELECT COALESCE(SUM(like_count), 0)::int FROM posts WHERE author_id = $1 AND status = 'published') AS likes,
              EXISTS (SELECT 1 FROM user_follows WHERE follower_id = $2 AND followee_id = $1) AS followed`,
      [id, viewerId],
    );
    return { id, nickname: u.nickname, follower_count: s.followers, following_count: s.following, post_count: s.posts, like_count: s.likes, followed: s.followed, mine: id === viewerId };
  }

  private async activeUser(id: string): Promise<{ nickname: string }> {
    const [u] = await this.db.query<{ nickname: string }>(`SELECT nickname FROM users WHERE id = $1 AND status = 'active'`, [id]);
    if (!u) throw Errors.notFound('创作者');
    return u;
  }
}
