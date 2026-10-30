import { Inject, Injectable } from '@nestjs/common';
import type { AssetDTO } from '@creature/shared';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError, Errors } from '../common/errors';
import { newId } from '../common/ids';
import { addSeconds, cnDateKey } from '../common/time';
import { Db, DB } from '../db/db';
import { ModerationService } from '../safety/moderation.service';
import { StorageService } from '../storage/storage.service';
import { AssetsService, type AssetRow } from './assets.service';
import { imageInfo, type RasterMime } from './image-info';

export const UPLOAD_MIMES: RasterMime[] = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const UPLOAD_TTL_SEC = 15 * 60;
const DAILY_UPLOAD_LIMIT = 200;

interface UploadRow {
  id: string;
  user_id: string;
  filename: string;
  mime_type: RasterMime;
  max_bytes: number;
  status: 'pending' | 'uploaded' | 'completed' | 'rejected' | 'expired';
  storage_key: string;
  asset_id: string | null;
  expires_at: Date;
}

/**
 * 素材上传（三步流程，两种存储驱动对客户端一致）：
 * 1. 创建上传会话，返回 15 分钟有效的签名上传地址；
 * 2. 客户端 PUT 原始文件到该地址：本地驱动由本服务接收，按声明大小截断读取并校验文件头；
 *    对象存储驱动直接上传到存储桶（大小参与签名，存储端拒绝不一致的请求）；
 * 3. 完成上传：对象存储驱动在此校验文件头（不符时删除并允许重新上传）；内容审核通过后生成资产。
 * 上传的素材不是 AI 生成内容，不添加 AI 标识。
 */
@Injectable()
export class UploadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly moderation: ModerationService,
    private readonly assets: AssetsService,
  ) {}

  async create(userId: string, b: { filename: string; mime: RasterMime; size: number }) {
    const [stat] = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM uploads WHERE user_id = $1 AND created_at > now() - interval '1 day'`, [userId]);
    if ((stat?.n ?? 0) >= DAILY_UPLOAD_LIMIT) throw Errors.rateLimited('今天的上传次数已达上限，请明天再试', 3600);
    const id = newId('upl');
    const expiresAt = addSeconds(new Date(), UPLOAD_TTL_SEC);
    const key = StorageService.keyFor('private', userId, id, b.mime);
    await this.db.query(
      `INSERT INTO uploads (id, user_id, filename, mime_type, max_bytes, status, storage_key, expires_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [id, userId, b.filename, b.mime, b.size, key, expiresAt],
    );
    const target = this.storage.uploadTarget(id, key, b.mime, b.size, expiresAt);
    return {
      upload_id: id,
      upload_url: target.url,
      method: 'PUT' as const,
      headers: target.headers,
      max_bytes: b.size,
      expires_at: expiresAt.toISOString(),
    };
  }

  /** 接收上传的文件（签名鉴权，无需登录令牌；仅本地驱动，对象存储驱动由客户端直传） */
  async receive(id: string, exp: string, sig: string, body: Readable): Promise<void> {
    if (this.storage.direct) throw Errors.notFound('上传地址');
    if (!this.storage.verifyUpload(id, exp, sig)) throw Errors.forbidden('上传地址无效或已过期');
    const [u] = await this.db.query<UploadRow>('SELECT * FROM uploads WHERE id = $1', [id]);
    if (!u || u.status !== 'pending' || new Date(u.expires_at).getTime() < Date.now()) throw Errors.conflict('UPLOAD_CLOSED', '上传会话已结束，请重新上传');

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > u.max_bytes) throw new AppError('PAYLOAD_TOO_LARGE', 413, '文件大小超过申请上传时声明的大小');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const info = imageInfo(data);
    if (!info || info.mime !== u.mime_type) throw Errors.invalid('文件内容与声明的图片格式不符，仅支持 PNG、JPEG、WebP');
    await this.storage.put(u.storage_key, data);
    const r = await this.db.query(`UPDATE uploads SET status = 'uploaded', size_bytes = $2 WHERE id = $1 AND status = 'pending' RETURNING id`, [id, data.length]);
    if (!r.length) throw Errors.conflict('UPLOAD_CLOSED', '上传会话已结束，请重新上传');
  }

  /** 完成上传：审核通过后生成资产；重复调用返回同一资产 */
  async complete(userId: string, id: string): Promise<AssetDTO> {
    const [u] = await this.db.query<UploadRow>('SELECT * FROM uploads WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!u) throw Errors.notFound('上传');
    if (u.status === 'completed' && u.asset_id) return this.assets.get(userId, u.asset_id);
    if (u.status === 'rejected') throw Errors.contentRejected('upload');
    if (u.status === 'expired') throw Errors.conflict('UPLOAD_CLOSED', '上传会话已过期，请重新上传');
    if (u.status === 'pending' && this.storage.direct) await this.verifyDirect(u);
    else if (u.status !== 'uploaded') throw Errors.conflict('UPLOAD_INCOMPLETE', '文件尚未上传完成');

    const data = await this.storage.read(u.storage_key);
    const info = imageInfo(data)!;
    const verdict = this.moderation.checkUpload({ filename: u.filename });
    await this.moderation.record({ userId, targetType: 'upload', targetId: id, result: verdict });
    if (verdict.verdict === 'block') {
      await this.db.query(`UPDATE uploads SET status = 'rejected' WHERE id = $1`, [id]);
      throw Errors.contentRejected(verdict.labels[0] ?? 'upload');
    }

    const assetId = newId('ast');
    const publicKey = StorageService.keyFor('public', userId, assetId, info.mime);
    await this.storage.copy(u.storage_key, publicKey);
    const row = await this.db.tx(async (q) => {
      const done = await q.query(`UPDATE uploads SET status = 'completed', asset_id = $2 WHERE id = $1 AND status = 'uploaded' RETURNING id`, [id, assetId]);
      if (!done.length) return null;
      const [a] = await q.query<AssetRow>(
        `INSERT INTO assets (id, user_id, kind, source, title, prompt, model_name, storage_key, raw_storage_key, mime_type, width, height, size_bytes, content_id)
         VALUES ($1, $2, 'image', 'uploaded', $3, '', '本地上传', $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [assetId, userId, u.filename.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || '上传的图片', publicKey, u.storage_key, info.mime, info.width, info.height, data.length, `UPL-${cnDateKey(new Date())}-${randomBytes(4).toString('hex').toUpperCase()}`],
      );
      return a;
    });
    if (!row) return this.complete(userId, id);
    return this.assets.toDTO(row);
  }

  /** 直传到对象存储的文件：校验大小与文件头，不符时删除文件（会话仍可重新上传） */
  private async verifyDirect(u: UploadRow): Promise<void> {
    const data = await this.storage.tryRead(u.storage_key);
    if (!data) throw Errors.conflict('UPLOAD_INCOMPLETE', '文件尚未上传完成');
    const info = imageInfo(data);
    if (data.length > u.max_bytes || !info || info.mime !== u.mime_type) {
      await this.storage.delete(u.storage_key);
      if (data.length > u.max_bytes) throw new AppError('PAYLOAD_TOO_LARGE', 413, '文件大小超过申请上传时声明的大小');
      throw Errors.invalid('文件内容与声明的图片格式不符，仅支持 PNG、JPEG、WebP');
    }
    await this.db.query(`UPDATE uploads SET status = 'uploaded', size_bytes = $2 WHERE id = $1 AND status = 'pending'`, [u.id, data.length]);
  }
}
