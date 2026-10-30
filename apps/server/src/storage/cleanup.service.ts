import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { Db, DB } from '../db/db';
import { MetricsService } from '../observability/metrics.service';
import { StorageService } from './storage.service';

/** 上传会话过期后再等这么久才清理（留给正在进行的上传与完成请求） */
const UPLOAD_GRACE_MS = 60 * 60_000;
/** 每批处理的数量 */
const BATCH = 100;

export interface CleanupResult {
  uploads: number;
  assets: number;
  files: number;
}

/**
 * 存储清理（docs/04-database.md 第 6 节）：
 * - 过期未完成的上传会话：删除已写入的文件（本地写入或浏览器直传到存储桶的），会话标记为 expired；
 * - 已删除的作品：超过宽限期（ASSET_PURGE_DAYS）后删除交付文件与原始文件，保留元数据（内容编号、审核记录可追溯）。
 *   仍被使用的文件不删：肖像授权材料（无论角色是否已删除）、未删除角色的参考图、未删除品牌套件的 Logo。
 * 用 FOR UPDATE SKIP LOCKED 认领，多个实例同时运行时互不重复；删除失败的批次回滚，下次重试。
 */
@Injectable()
export class StorageCleanupService {
  private readonly logger = new Logger('StorageCleanup');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly metrics: MetricsService,
  ) {}

  async run(now = new Date()): Promise<CleanupResult> {
    const result = { uploads: 0, assets: 0, files: 0 };
    for (;;) {
      const n = await this.expireUploads(now);
      result.uploads += n.rows;
      result.files += n.files;
      if (n.rows < BATCH) break;
    }
    for (;;) {
      const n = await this.purgeAssets(now);
      result.assets += n.rows;
      result.files += n.files;
      if (n.rows < BATCH) break;
    }
    if (result.uploads || result.assets) {
      this.metrics.inc('creature_storage_cleanup_total', '存储清理处理的记录数', { kind: 'upload' }, result.uploads);
      this.metrics.inc('creature_storage_cleanup_total', '存储清理处理的记录数', { kind: 'asset' }, result.assets);
      this.logger.log(`清理过期上传 ${result.uploads} 个、已删除作品 ${result.assets} 个，共删除 ${result.files} 个文件`);
    }
    return result;
  }

  private expireUploads(now: Date) {
    return this.db.tx(async (q) => {
      const rows = await q.query<{ id: string; storage_key: string }>(
        `SELECT id, storage_key FROM uploads WHERE status IN ('pending', 'uploaded') AND expires_at < $1
          ORDER BY expires_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
        [new Date(now.getTime() - UPLOAD_GRACE_MS)],
      );
      for (const r of rows) await this.storage.delete(r.storage_key);
      if (rows.length) await q.query(`UPDATE uploads SET status = 'expired' WHERE id = ANY($1::text[])`, [rows.map((r) => r.id)]);
      return { rows: rows.length, files: rows.length };
    });
  }

  private purgeAssets(now: Date) {
    return this.db.tx(async (q) => {
      const rows = await q.query<{ id: string; storage_key: string; raw_storage_key: string | null }>(
        `SELECT a.id, a.storage_key, a.raw_storage_key FROM assets a
          WHERE a.deleted_at < $1 AND a.files_purged_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.consent_asset_id = a.id)
            AND NOT EXISTS (SELECT 1 FROM character_refs r JOIN characters c ON c.id = r.character_id WHERE r.asset_id = a.id AND c.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM brand_kits b WHERE b.deleted_at IS NULL AND b.logos @> jsonb_build_array(jsonb_build_object('asset_id', a.id)))
          ORDER BY a.deleted_at LIMIT ${BATCH} FOR UPDATE OF a SKIP LOCKED`,
        [new Date(now.getTime() - this.config.assetPurgeDays * 86_400_000)],
      );
      let files = 0;
      for (const r of rows) {
        for (const key of new Set([r.storage_key, r.raw_storage_key].filter((k): k is string => !!k))) {
          await this.storage.delete(key);
          files++;
        }
      }
      if (rows.length) await q.query(`UPDATE assets SET files_purged_at = now() WHERE id = ANY($1::text[])`, [rows.map((r) => r.id)]);
      return { rows: rows.length, files };
    });
  }
}
