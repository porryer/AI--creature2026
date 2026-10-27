import { createHash } from 'node:crypto';
import type { Modality } from '@creature/shared';

export const CONFIG = Symbol('CONFIG');

export interface AppConfig {
  env: 'development' | 'test' | 'production';
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
  storageDir: string;
  /** 返回给前端的文件地址前缀，同源部署时留空 */
  publicBaseUrl: string;
  corsOrigins: string[];
  /** dev：验证码打印到日志并在响应中返回；production 必须接入短信服务商 */
  smsMode: 'dev' | 'provider';
  /** mock：订单可调用模拟支付；production 必须接入支付渠道 */
  paymentsMode: 'mock' | 'live';
  /** mock：所有模型由 Mock 供应商生成；live：只启用已配置适配器的模型 */
  providerMode: 'mock' | 'live';
  worker: { enabled: boolean; pollMs: number; concurrency: number };
  /** Mock 供应商各模态的模拟耗时（毫秒） */
  mockLatencyMs: Record<Modality, number>;
  /** 隐式标识中的服务提供者名称或编码 */
  serviceProviderCode: string;
  moderationExtraWords: string[];
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
  const mode = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['env'];
  const prod = mode === 'production';
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

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
    storageDir: env.STORAGE_DIR || '.data/files',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    smsMode: env.SMS_MODE === 'provider' ? 'provider' : 'dev',
    paymentsMode: env.PAYMENTS_MODE === 'live' ? 'live' : 'mock',
    providerMode: env.PROVIDER_MODE === 'live' ? 'live' : 'mock',
    worker: {
      enabled: env.WORKER_ENABLED ? env.WORKER_ENABLED !== 'false' : mode !== 'test',
      pollMs: num(env.WORKER_POLL_MS, 500),
      concurrency: num(env.WORKER_CONCURRENCY, 4),
    },
    mockLatencyMs: {
      image: num(env.MOCK_LATENCY_IMAGE_MS, mode === 'test' ? 0 : 3000),
      video: num(env.MOCK_LATENCY_VIDEO_MS, mode === 'test' ? 0 : 8000),
      text: num(env.MOCK_LATENCY_TEXT_MS, mode === 'test' ? 0 : 1500),
      audio: num(env.MOCK_LATENCY_AUDIO_MS, mode === 'test' ? 0 : 2500),
    },
    serviceProviderCode: env.SERVICE_PROVIDER_CODE || 'CREATURE-DEV',
    moderationExtraWords: (env.MODERATION_EXTRA_WORDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };

  if (prod) {
    const missing = ['JWT_SECRET', 'PHONE_ENC_KEY', 'PHONE_HASH_KEY', 'FILE_SIGNING_SECRET', 'DATABASE_URL'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`生产环境缺少配置：${missing.join(', ')}`);
    if (cfg.smsMode === 'dev') throw new Error('生产环境不能使用 SMS_MODE=dev，请接入短信服务商');
    if (cfg.paymentsMode === 'mock') throw new Error('生产环境不能使用模拟支付，请设置 PAYMENTS_MODE=live 并接入支付渠道');
    if (cfg.providerMode === 'mock') throw new Error('生产环境不能使用 Mock 模型供应商，请设置 PROVIDER_MODE=live');
  }
  return cfg;
}
