import { Inject, Injectable } from '@nestjs/common';
import type { AssetDTO, Modality, OutputDTO } from '@creature/shared';
import { Errors } from '../common/errors';
import { Db, DB } from '../db/db';
import { StorageService } from '../storage/storage.service';

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
  created_at: Date;
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
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

  async list(userId: string, f: { kind?: Modality; favorite?: boolean; q?: string; cursor: string | null; limit: number }) {
    const rows = await this.db.query<AssetRow>(
      `SELECT * FROM assets WHERE user_id = $1 AND deleted_at IS NULL
         AND ($2::text IS NULL OR kind = $2)
         AND ($3::boolean IS NULL OR favorite = $3)
         AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%' OR prompt ILIKE '%' || $4 || '%')
         AND ($5::text IS NULL OR id < $5)
       ORDER BY id DESC LIMIT $6`,
      [userId, f.kind ?? null, f.favorite ?? null, f.q?.trim() || null, f.cursor, f.limit + 1],
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

  async remove(userId: string, id: string): Promise<void> {
    await this.row(userId, id);
    await this.db.query('UPDATE assets SET deleted_at = now() WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  private async row(userId: string, id: string): Promise<AssetRow> {
    const [r] = await this.db.query<AssetRow>('SELECT * FROM assets WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, userId]);
    if (!r) throw Errors.notFound('作品');
    return r;
  }
}
