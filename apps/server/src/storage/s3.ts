import { createHash, createHmac } from 'node:crypto';

/** S3 兼容对象存储的连接配置（阿里云 OSS、腾讯云 COS、火山引擎 TOS、MinIO、AWS S3） */
export interface S3Config {
  /** 服务端访问的地址，如 https://oss-cn-hangzhou.aliyuncs.com 或 http://minio:9000 */
  endpoint: string;
  /** 浏览器访问的地址（预签名地址使用），默认与 endpoint 相同 */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 路径风格（endpoint/bucket/key），MinIO 需要；OSS / COS 使用虚拟主机风格（bucket.endpoint/key） */
  forcePathStyle: boolean;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986：只保留非保留字符 */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

interface SignInput {
  method: string;
  url: URL;
  /** 参与签名的请求头（名称小写） */
  headers: Record<string, string>;
  payloadHash: string;
  now: Date;
}

/** AWS Signature Version 4（只实现 S3 需要的部分） */
export class S3Client {
  constructor(private readonly cfg: S3Config) {}

  /** 对象地址；public 为 true 时使用浏览器访问的地址 */
  objectUrl(key: string, pub = false): URL {
    const base = new URL(pub ? this.cfg.publicEndpoint : this.cfg.endpoint);
    const path = key
      .split('/')
      .map((s) => encode(s))
      .join('/');
    const basePath = base.pathname.replace(/\/$/, '');
    if (this.cfg.forcePathStyle) return new URL(`${base.protocol}//${base.host}${basePath}/${this.cfg.bucket}${key ? `/${path}` : ''}`);
    return new URL(`${base.protocol}//${this.cfg.bucket}.${base.host}${basePath}/${path}`);
  }

  /**
   * 预签名地址（查询参数签名）。headers 中的请求头参与签名，客户端必须带上相同的值（如上传时的 content-type、content-length）。
   */
  presign(method: string, key: string, opts: { expiresSec: number; headers?: Record<string, string>; query?: Record<string, string>; now?: Date }): string {
    const now = opts.now ?? new Date();
    const url = this.objectUrl(key, true);
    const headers = { host: url.host, ...lower(opts.headers ?? {}) };
    const scope = this.scope(now);
    const params: Record<string, string> = {
      ...(opts.query ?? {}),
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.cfg.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate(now),
      'X-Amz-Expires': String(Math.max(1, Math.min(604_800, Math.floor(opts.expiresSec)))),
      'X-Amz-SignedHeaders': Object.keys(headers).sort().join(';'),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const signature = this.signature({ method, url, headers, payloadHash: 'UNSIGNED-PAYLOAD', now });
    return `${url.origin}${url.pathname}?${canonicalQuery(url)}&X-Amz-Signature=${signature}`;
  }

  /** 请求头签名：返回需要附加的 Authorization 等请求头 */
  signHeaders(method: string, url: URL, headers: Record<string, string>, body: Buffer | undefined, now = new Date()): Record<string, string> {
    const payloadHash = sha256(body ?? '');
    const signed = { host: url.host, ...lower(headers), 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(now) };
    const signature = this.signature({ method, url, headers: signed, payloadHash, now });
    const { host: _host, ...rest } = signed;
    return {
      ...rest,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${this.scope(now)}, SignedHeaders=${Object.keys(signed).sort().join(';')}, Signature=${signature}`,
    };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.send('PUT', key, { body, headers: { 'content-type': contentType } });
  }

  /** 读取对象；不存在时返回 null */
  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key, { allow404: true });
    return res ? Buffer.from(await res.arrayBuffer()) : null;
  }

  async head(key: string): Promise<{ size: number } | null> {
    const res = await this.send('HEAD', key, { allow404: true });
    return res ? { size: Number(res.headers.get('content-length') ?? 0) } : null;
  }

  /** 服务端复制（不经过本服务传输数据） */
  async copy(from: string, to: string): Promise<void> {
    const source = `/${this.cfg.bucket}/${from.split('/').map(encode).join('/')}`;
    const res = await this.send('PUT', to, { headers: { 'x-amz-copy-source': source } });
    // 复制失败时 S3 可能返回 200 + 错误正文
    const text = await res!.text();
    if (text.includes('<Error>')) throw parseError(200, text);
  }

  async delete(key: string): Promise<void> {
    await this.send('DELETE', key, { allow404: true });
  }

  /** 检查存储桶是否可访问；不存在且 create 为 true 时创建 */
  async ensureBucket(create: boolean): Promise<'ok' | 'created'> {
    const exists = await this.send('HEAD', '', { allow404: true });
    if (exists) return 'ok';
    if (!create) throw new S3Error(404, 'NoSuchBucket', `存储桶 ${this.cfg.bucket} 不存在`);
    try {
      await this.send('PUT', '', {});
    } catch (e) {
      // 多个实例同时启动时其他实例已经创建
      if (e instanceof S3Error && e.code === 'BucketAlreadyOwnedByYou') return 'ok';
      throw e;
    }
    return 'created';
  }

  private async send(method: string, key: string, opts: { body?: Buffer; headers?: Record<string, string>; allow404?: boolean }): Promise<Response | null> {
    const url = this.objectUrl(key);
    const headers = this.signHeaders(method, url, opts.headers ?? {}, opts.body);
    const res = await fetch(url, { method, headers, body: opts.body });
    if (opts.allow404 && res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw parseError(res.status, method === 'HEAD' ? '' : await res.text());
    return res;
  }

  private scope(now: Date) {
    return `${amzDate(now).slice(0, 8)}/${this.cfg.region}/s3/aws4_request`;
  }

  private signature(s: SignInput): string {
    const names = Object.keys(s.headers).sort();
    const canonical = [
      s.method,
      s.url.pathname,
      canonicalQuery(s.url),
      names.map((n) => `${n}:${s.headers[n].trim().replace(/\s+/g, ' ')}\n`).join(''),
      names.join(';'),
      s.payloadHash,
    ].join('\n');
    const date = amzDate(s.now);
    const toSign = ['AWS4-HMAC-SHA256', date, this.scope(s.now), sha256(canonical)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, date.slice(0, 8)), this.cfg.region), 's3'), 'aws4_request');
    return createHmac('sha256', key).update(toSign).digest('hex');
  }
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

/** 按编码后的参数名排序（同名参数按值排序） */
function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function parseError(status: number, body: string): S3Error {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP_${status}`;
  const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? '';
  return new S3Error(status, code, `对象存储请求失败（${status} ${code}）${message ? `：${message}` : ''}`);
}
