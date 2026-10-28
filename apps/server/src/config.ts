import { createHash } from 'node:crypto';
import type { Modality } from '@creature/shared';
import type { S3Config } from './storage/s3';

export const CONFIG = Symbol('CONFIG');

export interface AppConfig {
  /** staging：密钥与数据库按生产要求校验，但允许 Mock 的短信 / 支付 / 模型供应商（启动时告警） */
  env: 'development' | 'test' | 'staging' | 'production';
  port: number;
  /** 设置后连接真实 PostgreSQL；为空时使用内嵌 PGlite */
  databaseUrl?: string;
  /** PGlite 数据目录；为空表示内存库（测试用） */
  pgliteDir?: string;
  jwtSecret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  maxSessionsPerUser: number;
  /** 手机号加密与哈希密钥（32 字节） */
  phoneEncKey: Buffer;
  phoneHashKey: Buffer;
  fileSigningSecret: string;
  fileUrlTtlSec: number;
  /** 文件存储：local 为本地目录（单机部署）；s3 为 S3 兼容对象存储（多机部署，生产环境必须） */
  storageDriver: 'local' | 's3';
  storageDir: string;
  s3?: S3Config;
  /** 返回给前端的文件地址前缀，同源部署时留空 */
  publicBaseUrl: string;
  corsOrigins: string[];
  /** 刷新令牌 Cookie 是否只在 HTTPS 下发送（生产默认开启） */
  cookieSecure: boolean;
  /** dev：验证码打印到日志并在响应中返回；production 必须接入短信服务商 */
  smsMode: 'dev' | 'provider';
  /** mock：订单可调用模拟支付；production 必须接入支付渠道 */
  paymentsMode: 'mock' | 'live';
  /** mock：所有模型由 Mock 供应商生成；live：只启用已配置适配器的模型 */
  providerMode: 'mock' | 'live';
  /** concurrency：每个实例各模态同时处理的任务数；shutdownGraceMs：停机时等待处理中任务的时长，超时的任务重新排队 */
  worker: { enabled: boolean; pollMs: number; concurrency: Record<Modality, number>; shutdownGraceMs: number };
  /** Mock 供应商各模态的模拟耗时（毫秒） */
  mockLatencyMs: Record<Modality, number>;
  /** 隐式标识中的服务提供者名称或编码 */
  serviceProviderCode: string;
  moderationExtraWords: string[];
  /** 登录时授予管理后台权限的手机号 */
  adminPhones: string[];
  /** 访问 /v1/metrics 的令牌；未设置时只在开发与测试环境开放 */
  metricsToken?: string;
  /** 每个请求输出一行访问日志 */
  accessLog: boolean;
  /** 每个用户每分钟最多提交的生成任务数、同时进行中的任务上限 */
  generationRatePerMin: number;
  maxInflightTasks: number;
  /** 定时全量对账间隔（小时） */
  reconcileIntervalHours: number;
  /** 多实例之间广播事件的 PostgreSQL 通知频道（同一数据库上的不同环境应使用不同频道） */
  eventsChannel: string;
}

const DEV_SECRET = 'creature-dev-secret-do-not-use-in-production';

function key32(raw: string | undefined, fallbackSeed: string): Buffer {
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('加密密钥必须是 32 字节（64 位十六进制或 base64）');
    return buf;
  }
  return createHash('sha256').update(fallbackSeed).digest();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.APP_ENV === 'staging' ? 'staging' : env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['env'];
  const prod = mode === 'production';
  const strict = prod || mode === 'staging';
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  const concurrency = num(env.WORKER_CONCURRENCY, 4);
  const storageDriver = env.STORAGE_DRIVER === 's3' ? 's3' : 'local';

  const cfg: AppConfig = {
    env: mode,
    port: num(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR ?? (mode === 'test' ? undefined : '.data/pglite'),
    jwtSecret: env.JWT_SECRET || DEV_SECRET,
    accessTtlSec: num(env.ACCESS_TTL_SEC, 2 * 3600),
    refreshTtlSec: num(env.REFRESH_TTL_SEC, 30 * 24 * 3600),
    maxSessionsPerUser: 5,
    phoneEncKey: key32(env.PHONE_ENC_KEY, `${DEV_SECRET}:phone-enc`),
    phoneHashKey: key32(env.PHONE_HASH_KEY, `${DEV_SECRET}:phone-hash`),
    fileSigningSecret: env.FILE_SIGNING_SECRET || `${DEV_SECRET}:files`,
    fileUrlTtlSec: num(env.FILE_URL_TTL_SEC, 2 * 3600),
    storageDriver,
    storageDir: env.STORAGE_DIR || '.data/files',
    s3:
      storageDriver === 's3'
        ? {
            endpoint: env.S3_ENDPOINT ?? '',
            publicEndpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT || '',
            region: env.S3_REGION || 'us-east-1',
            bucket: env.S3_BUCKET ?? '',
            accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
            forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
          }
        : undefined,
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : prod,
    smsMode: env.SMS_MODE === 'provider' ? 'provider' : 'dev',
    paymentsMode: env.PAYMENTS_MODE === 'live' ? 'live' : 'mock',
    providerMode: env.PROVIDER_MODE === 'live' ? 'live' : 'mock',
    worker: {
      enabled: env.WORKER_ENABLED ? env.WORKER_ENABLED !== 'false' : mode !== 'test',
      pollMs: num(env.WORKER_POLL_MS, 500),
      concurrency: {
        image: num(env.WORKER_CONCURRENCY_IMAGE, concurrency),
        video: num(env.WORKER_CONCURRENCY_VIDEO, concurrency),
        text: num(env.WORKER_CONCURRENCY_TEXT, concurrency),
        audio: num(env.WORKER_CONCURRENCY_AUDIO, concurrency),
      },
      shutdownGraceMs: num(env.WORKER_SHUTDOWN_GRACE_MS, 8000),
    },
    mockLatencyMs: {
      image: num(env.MOCK_LATENCY_IMAGE_MS, mode === 'test' ? 0 : 3000),
      video: num(env.MOCK_LATENCY_VIDEO_MS, mode === 'test' ? 0 : 8000),
      text: num(env.MOCK_LATENCY_TEXT_MS, mode === 'test' ? 0 : 1500),
      audio: num(env.MOCK_LATENCY_AUDIO_MS, mode === 'test' ? 0 : 2500),
    },
    serviceProviderCode: env.SERVICE_PROVIDER_CODE || 'CREATURE-DEV',
    moderationExtraWords: (env.MODERATION_EXTRA_WORDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    adminPhones: (env.ADMIN_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean),
    metricsToken: env.METRICS_TOKEN || undefined,
    accessLog: env.ACCESS_LOG ? env.ACCESS_LOG === 'true' : mode !== 'test',
    generationRatePerMin: num(env.GENERATION_RATE_PER_MIN, 30),
    maxInflightTasks: num(env.MAX_INFLIGHT_TASKS, 20),
    reconcileIntervalHours: num(env.RECONCILE_INTERVAL_HOURS, 24),
    eventsChannel: env.EVENTS_CHANNEL || 'creature_events',
  };

  if (storageDriver === 's3') {
    const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`STORAGE_DRIVER=s3 缺少配置：${missing.join(', ')}`);
  }
  if (strict) {
    const missing = ['JWT_SECRET', 'PHONE_ENC_KEY', 'PHONE_HASH_KEY', 'FILE_SIGNING_SECRET', 'DATABASE_URL'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`${prod ? '生产' : 'staging '}环境缺少配置：${missing.join(', ')}`);
  }
  if (prod) {
    if (cfg.smsMode === 'dev') throw new Error('生产环境不能使用 SMS_MODE=dev，请接入短信服务商');
    if (cfg.paymentsMode === 'mock') throw new Error('生产环境不能使用模拟支付，请设置 PAYMENTS_MODE=live 并接入支付渠道');
    if (cfg.providerMode === 'mock') throw new Error('生产环境不能使用 Mock 模型供应商，请设置 PROVIDER_MODE=live');
    if (cfg.storageDriver !== 's3') throw new Error('生产环境必须使用对象存储，请设置 STORAGE_DRIVER=s3 及 S3_* 配置');
  }
  return cfg;
}
