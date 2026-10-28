import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { AppConfig, CONFIG } from '../config';
import { S3Client, S3Error } from './s3';

const MIME_EXT: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'text/plain; charset=utf-8': 'txt',
};
export const extFor = (mime: string) => MIME_EXT[mime] ?? 'bin';
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
const mimeOf = (key: string) => EXT_MIME[key.split('.').pop() ?? ''] ?? 'application/octet-stream';
const KEY_RE = /^(public|private)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;

/** 字节存储驱动 */
interface BlobStore {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  /** 不存在时返回 null */
  get(key: string): Promise<Buffer | null>;
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
}

class LocalStore implements BlobStore {
  constructor(private readonly root: string) {}
  async put(key: string, data: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  async get(key: string) {
    return readFile(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  }
  async copy(from: string, to: string) {
    const dst = this.path(to);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(this.path(from), dst);
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  path(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root)) throw new Error('非法的存储路径');
    return path;
  }
}

/** 已校验签名的文件访问请求 */
export interface FileRef {
  key: string;
  mime: string;
  /** 访问地址剩余有效期（秒） */
  maxAge: number;
  /** 下载时的文件名 */
  filename?: string;
}

/**
 * 文件存储。public/ 下是带 AI 标识的交付文件，通过签名地址访问；private/ 下是原始文件，永不对外。
 * - local：本地目录，文件经 /v1/files 由本服务输出，上传经 /v1/uploads 由本服务接收（单机部署）；
 * - s3：S3 兼容对象存储，浏览器直接上传到存储桶（预签名 PUT），/v1/files 校验签名后跳转到预签名读取地址。
 * 两种驱动对前端的协议一致：上传用返回的 upload_url + headers，文件地址始终是 /v1/files/...。
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger('Storage');
  private readonly store: BlobStore;
  private readonly local?: LocalStore;
  private readonly s3?: S3Client;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    if (config.storageDriver === 's3') {
      this.s3 = new S3Client(config.s3!);
      const s3 = this.s3;
      this.store = {
        put: (key, data, mime) => s3.put(key, data, mime),
        get: (key) => s3.get(key),
        copy: (from, to) => s3.copy(from, to),
        delete: (key) => s3.delete(key),
      };
    } else {
      this.local = new LocalStore(resolve(config.storageDir));
      this.store = this.local;
    }
  }

  get driver(): 'local' | 's3' {
    return this.s3 ? 's3' : 'local';
  }

  /** 客户端是否直接上传到存储（上传内容在完成时校验） */
  get direct(): boolean {
    return !!this.s3;
  }

  /** 启动时检查存储桶（存储服务可能还在启动，最多重试 10 次）；非生产环境下不存在则创建（便于 staging / 测试） */
  async onModuleInit() {
    if (!this.s3) return;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.s3.ensureBucket(this.config.env !== 'production');
        this.logger.log(`对象存储 ${this.config.s3!.bucket}${r === 'created' ? '（已创建）' : ''}`);
        return;
      } catch (e) {
        if (attempt >= 10 || (e instanceof S3Error && e.status !== 503)) throw e;
        this.logger.warn(`对象存储暂不可用（${e instanceof Error ? e.message : String(e)}），1 秒后重试`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  static keyFor(scope: 'public' | 'private', userId: string, id: string, mime: string): string {
    return `${scope}/${userId}/${id}.${MIME_EXT[mime] ?? 'bin'}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.store.put(checkKey(key), data, mimeOf(key));
  }

  async read(key: string): Promise<Buffer> {
    const data = await this.store.get(checkKey(key));
    if (!data) throw new Error(`文件不存在：${key}`);
    return data;
  }

  /** 读取文件；不存在时返回 null */
  async tryRead(key: string): Promise<Buffer | null> {
    return this.store.get(checkKey(key));
  }

  async copy(from: string, to: string): Promise<void> {
    await this.store.copy(checkKey(from), checkKey(to));
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(checkKey(key));
  }

  /**
   * 上传地址。local：/v1/uploads/{id}?exp=&sig=，由本服务接收；
   * s3：预签名 PUT，content-type 与 content-length 参与签名，请求体必须恰好是申请时声明的字节数。
   */
  uploadTarget(uploadId: string, key: string, mime: string, size: number, expiresAt: Date): { url: string; headers: Record<string, string> } {
    if (this.s3) {
      const expiresSec = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
      return { url: this.s3.presign('PUT', checkKey(key), { expiresSec, headers: { 'content-type': mime, 'content-length': String(size) } }), headers: { 'content-type': mime } };
    }
    const exp = Math.floor(expiresAt.getTime() / 1000);
    return { url: `${this.config.publicBaseUrl}/v1/uploads/${uploadId}?exp=${exp}&sig=${this.sign(`upload:${uploadId}`, exp)}`, headers: { 'content-type': mime } };
  }

  verifyUpload(uploadId: string, exp: string, sig: string): boolean {
    const expNum = Number(exp);
    if (!Number.isInteger(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(`upload:${uploadId}`, expNum));
    const given = Buffer.from(String(sig));
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** 生成限时访问地址：/v1/files/{base64url(key)}?exp=&sig= */
  signedUrl(key: string, ttlSec = this.config.fileUrlTtlSec): string {
    if (!key.startsWith('public/')) throw new Error('只允许为 public/ 下的文件生成访问地址');
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const token = Buffer.from(key).toString('base64url');
    return `${this.config.publicBaseUrl}/v1/files/${token}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  /** 下载地址：附带文件名（参与签名，防止被篡改），响应以附件形式返回 */
  signedDownloadUrl(key: string, filename: string, ttlSec = 600): string {
    if (!key.startsWith('public/')) throw new Error('只允许为 public/ 下的文件生成访问地址');
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const token = Buffer.from(key).toString('base64url');
    const dl = Buffer.from(filename).toString('base64url');
    return `${this.config.publicBaseUrl}/v1/files/${token}?exp=${exp}&dl=${dl}&sig=${this.sign(`${key}#dl=${dl}`, exp)}`;
  }

  /** 校验文件访问地址的签名与有效期；任何不合法的情况都返回 null */
  verifyFile(token: string, exp: string, sig: string, dl?: string): FileRef | null {
    let key: string;
    try {
      key = Buffer.from(token, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const expNum = Number(exp);
    if (!KEY_RE.test(key) || !key.startsWith('public/') || !Number.isInteger(expNum)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (expNum < now) return null;
    if (dl !== undefined && !/^[A-Za-z0-9_-]{1,400}$/.test(dl)) return null;
    const expected = Buffer.from(this.sign(dl === undefined ? key : `${key}#dl=${dl}`, expNum));
    const given = Buffer.from(String(sig));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { key, mime: mimeOf(key), maxAge: expNum - now, filename: dl === undefined ? undefined : Buffer.from(dl, 'base64url').toString('utf8') };
  }

  /** 输出已校验的文件：本地驱动返回文件流（不存在时 null）；对象存储返回预签名读取地址 */
  deliver(f: FileRef): { stream: Readable } | { redirect: string } | null {
    if (this.s3) {
      const ttl = Math.max(60, f.maxAge);
      const query: Record<string, string> = { 'response-content-type': f.mime, 'response-cache-control': `private, max-age=${ttl}` };
      if (f.filename) query['response-content-disposition'] = contentDisposition(f.filename);
      return { redirect: this.s3.presign('GET', f.key, { expiresSec: ttl, query }) };
    }
    const path = this.local!.path(f.key);
    return existsSync(path) ? { stream: createReadStream(path) } : null;
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', this.config.fileSigningSecret).update(`${key}:${exp}`).digest('base64url');
  }
}

function checkKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error(`非法的存储键：${key}`);
  return key;
}

/** 附件下载的 Content-Disposition（非 ASCII 文件名用 RFC 5987 编码） */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
