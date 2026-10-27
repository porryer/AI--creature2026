import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { AppConfig, CONFIG } from '../config';

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
const KEY_RE = /^(public|private)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;

/**
 * 文件存储：本地目录实现，接口与对象存储（OSS / S3）一致。
 * public/ 下是带 AI 标识的交付文件，通过签名 URL 访问；private/ 下是原始文件，永不对外。
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.root = resolve(config.storageDir);
  }

  static keyFor(scope: 'public' | 'private', userId: string, id: string, mime: string): string {
    return `${scope}/${userId}/${id}.${MIME_EXT[mime] ?? 'bin'}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  async copy(from: string, to: string): Promise<void> {
    const dst = this.pathOf(to);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(this.pathOf(from), dst);
  }

  /** 上传地址：/v1/uploads/{id}?exp=&sig=，客户端用 PUT 直接上传文件（对象存储的预签名上传同理） */
  signedUploadUrl(uploadId: string, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    return `${this.config.publicBaseUrl}/v1/uploads/${uploadId}?exp=${exp}&sig=${this.sign(`upload:${uploadId}`, exp)}`;
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

  /** 校验签名并打开文件；任何不合法的情况都返回 null。dl 存在时返回下载文件名 */
  open(token: string, exp: string, sig: string, dl?: string): { stream: Readable; mime: string; maxAge: number; filename?: string } | null {
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
    const path = this.pathOf(key);
    if (!existsSync(path)) return null;
    const ext = key.split('.').pop() ?? '';
    const filename = dl === undefined ? undefined : Buffer.from(dl, 'base64url').toString('utf8');
    return { stream: createReadStream(path), mime: EXT_MIME[ext] ?? 'application/octet-stream', maxAge: expNum - now, filename };
  }

  private sign(key: string, exp: number): string {
    return createHmac('sha256', this.config.fileSigningSecret).update(`${key}:${exp}`).digest('base64url');
  }

  private pathOf(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`非法的存储键：${key}`);
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root)) throw new Error('非法的存储路径');
    return path;
  }
}
