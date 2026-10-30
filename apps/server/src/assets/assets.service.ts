import { Inject, Injectable } from '@nestjs/common';
import type { AssetDTO, DownloadDTO, Modality, OutputDTO } from '@creature/shared';
import { AnalyticsService } from '../analytics/analytics.service';
import { Errors } from '../common/errors';
import { Db, DB } from '../db/db';
import { extFor, StorageService } from '../storage/storage.service';

export interface AssetRow {
  id: string;
  user_id: string;
  task_id: string | null;
  kind: Modality;
  title: string;
  prompt: string;
  model_name: string;
  storage_key: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  size_bytes: number;
  text_content: string | null;
  content_id: string;
  favorite: boolean;
  source: 'generated' | 'uploaded';
  folder_id: string | null;
  created_at: Date;
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly analytics: AnalyticsService,
  ) {}

  toDTO(r: AssetRow): AssetDTO {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      prompt: r.prompt,
      url: this.storage.signedUrl(r.storage_key),
      mime: r.mime_type,
      width: r.width ?? undefined,
      height: r.height ?? undefined,
      duration_sec: r.duration_ms ? Math.round(r.duration_ms / 100) / 10 : undefined,
      text: r.text_content ?? undefined,
      content_id: r.content_id,
      favorite: r.favorite,
      model: r.model_name,
      task_id: r.task_id,
      source: r.source,
      folder_id: r.folder_id,
      created_at: new Date(r.created_at).toISOString(),
    };
  }

  toOutput(r: AssetRow): OutputDTO {
    const a = this.toDTO(r);
    return { asset_id: a.id, kind: a.kind, url: a.url, mime: a.mime, width: a.width, height: a.height, duration_sec: a.duration_sec, text: a.text, content_id: a.content_id };
  }

  async outputsFor(taskIds: string[]): Promise<Map<string, OutputDTO[]>> {
    const map = new Map<string, OutputDTO[]>();
    if (!taskIds.length) return map;
    const rows = await this.db.query<AssetRow>('SELECT * FROM assets WHERE task_id = ANY($1::text[]) AND deleted_at IS NULL ORDER BY id', [taskIds]);
    for (const r of rows) map.set(r.task_id!, [...(map.get(r.task_id!) ?? []), this.toOutput(r)]);
    return map;
  }

  /** folder：文件夹 ID；'none' 表示未归入文件夹 */
  async list(userId: string, f: { kind?: Modality; favorite?: boolean; q?: string; folder?: string; cursor: string | null; limit: number }) {
    const rows = await this.db.query<AssetRow>(
      `SELECT * FROM assets WHERE user_id = $1 AND deleted_at IS NULL
         AND ($2::text IS NULL OR kind = $2)
         AND ($3::boolean IS NULL OR favorite = $3)
         AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%' OR prompt ILIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR id < $5)
         AND ($7::text IS NULL OR ($7 = 'none' AND folder_id IS NULL) OR folder_id = $7)
       ORDER BY id DESC LIMIT $6`,
      [userId, f.kind ?? null, f.favorite ?? null, f.q?.trim() || null, f.cursor, f.limit + 1, f.folder ?? null],
    );
    const page = rows.slice(0, f.limit);
    return { data: page.map((r) => this.toDTO(r)), next_cursor: rows.length > f.limit ? page[page.length - 1].id : null };
  }

  async get(userId: string, id: string): Promise<AssetDTO> {
    return this.toDTO(await this.row(userId, id));
  }

  async update(userId: string, id: string, patch: { favorite?: boolean; title?: string }): Promise<AssetDTO> {
    await this.row(userId, id);
    const [r] = await this.db.query<AssetRow>(
      'UPDATE assets SET favorite = COALESCE($3, favorite), title = COALESCE($4, title) WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId, patch.favorite ?? null, patch.title ?? null],
    );
    return this.toDTO(r);
  }

  /** 删除作品；已发布到广场的同时撤回 */
  async remove(userId: string, id: string): Promise<void> {
    await this.row(userId, id);
    await this.db.tx(async (q) => {
      await q.query('UPDATE assets SET deleted_at = now() WHERE id = $1 AND user_id = $2', [id, userId]);
      await q.query(`UPDATE posts SET status = 'removed' WHERE asset_id = $1 AND status <> 'removed'`, [id]);
    });
  }

  /** 批量移动到文件夹（folderId 为 null 时移出文件夹），返回实际移动的数量 */
  async move(userId: string, ids: string[], folderId: string | null): Promise<number> {
    if (folderId) {
      const [f] = await this.db.query('SELECT id FROM asset_folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [folderId, userId]);
      if (!f) throw Errors.notFound('文件夹');
    }
    const r = await this.db.query('UPDATE assets SET folder_id = $3 WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL RETURNING id', [ids, userId, folderId]);
    return r.length;
  }

  /** 下载：返回 10 分钟有效的附件地址；生成作品下载的是带显式与隐式标识的交付文件 */
  async download(userId: string, id: string): Promise<DownloadDTO> {
    const r = await this.row(userId, id);
    const base = r.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) || r.content_id;
    const filename = `${base}.${extFor(r.mime_type)}`;
    await this.analytics.track(userId, 'asset_export', { channel: 'download', asset_id: r.id, asset_type: r.kind, source: r.source, format: extFor(r.mime_type) });
    return { url: this.storage.signedDownloadUrl(r.storage_key, filename), filename };
  }

  private async row(userId: string, id: string): Promise<AssetRow> {
    const [r] = await this.db.query<AssetRow>('SELECT * FROM assets WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, userId]);
    if (!r) throw Errors.notFound('作品');
    return r;
  }
}
