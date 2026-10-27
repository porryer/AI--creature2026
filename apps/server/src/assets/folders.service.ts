import { Inject, Injectable } from '@nestjs/common';
import type { FolderDTO } from '@creature/shared';
import { Errors } from '../common/errors';
import { newId } from '../common/ids';
import { Db, DB, isUniqueViolation } from '../db/db';

const MAX_FOLDERS = 50;

interface FolderRow {
  id: string;
  name: string;
  asset_count: number;
  created_at: Date;
}

/** 作品库文件夹：每人最多 50 个，名称不可重复；删除文件夹不删除其中的作品 */
@Injectable()
export class FoldersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(userId: string): Promise<{ data: FolderDTO[] }> {
    const rows = await this.db.query<FolderRow>(
      `SELECT f.id, f.name, f.created_at, COUNT(a.id)::int AS asset_count
         FROM asset_folders f LEFT JOIN assets a ON a.folder_id = f.id AND a.deleted_at IS NULL
        WHERE f.user_id = $1 AND f.deleted_at IS NULL
        GROUP BY f.id ORDER BY f.created_at`,
      [userId],
    );
    return { data: rows.map(toDTO) };
  }

  async create(userId: string, name: string): Promise<FolderDTO> {
    const [{ n }] = await this.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM asset_folders WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
    if (n >= MAX_FOLDERS) throw Errors.invalid(`最多创建 ${MAX_FOLDERS} 个文件夹`);
    try {
      const [r] = await this.db.query<FolderRow>('INSERT INTO asset_folders (id, user_id, name) VALUES ($1, $2, $3) RETURNING id, name, created_at, 0 AS asset_count', [newId('fld'), userId, name]);
      return toDTO(r);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('FOLDER_EXISTS', `已有名为「${name}」的文件夹`);
      throw e;
    }
  }

  async rename(userId: string, id: string, name: string): Promise<void> {
    try {
      const r = await this.db.query('UPDATE asset_folders SET name = $3 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id', [id, userId, name]);
      if (!r.length) throw Errors.notFound('文件夹');
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('FOLDER_EXISTS', `已有名为「${name}」的文件夹`);
      throw e;
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.db.tx(async (q) => {
      const r = await q.query('UPDATE asset_folders SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id', [id, userId]);
      if (!r.length) throw Errors.notFound('文件夹');
      await q.query('UPDATE assets SET folder_id = NULL WHERE folder_id = $1', [id]);
    });
  }
}

const toDTO = (r: FolderRow): FolderDTO => ({ id: r.id, name: r.name, asset_count: Number(r.asset_count), created_at: new Date(r.created_at).toISOString() });
