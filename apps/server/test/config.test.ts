import { loadConfig } from '../src/config';

const secrets = {
  JWT_SECRET: 'x'.repeat(32),
  PHONE_ENC_KEY: 'a'.repeat(64),
  PHONE_HASH_KEY: 'b'.repeat(64),
  FILE_SIGNING_SECRET: 'y'.repeat(32),
  DATABASE_URL: 'postgres://u:p@db:5432/creature',
};

const s3 = { STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com', S3_REGION: 'oss-cn-hangzhou', S3_BUCKET: 'creature-files', S3_ACCESS_KEY_ID: 'ak', S3_SECRET_ACCESS_KEY: 'sk' };

describe('配置', () => {
  it('开发环境全部可留空', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ env: 'development', smsMode: 'dev', paymentsMode: 'mock', providerMode: 'mock', cookieSecure: false });
  });

  it('生产环境：缺少密钥或仍使用 Mock 集成时拒绝启动', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/生产环境缺少配置：JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', ...secrets })).toThrow(/SMS_MODE=dev/);
    const live = { ...secrets, SMS_MODE: 'provider', PAYMENTS_MODE: 'live', PROVIDER_MODE: 'live' };
    expect(() => loadConfig({ NODE_ENV: 'production', ...live })).toThrow(/必须使用对象存储/);
    const c = loadConfig({ NODE_ENV: 'production', ...live, ...s3 });
    expect(c).toMatchObject({ env: 'production', cookieSecure: true, storageDriver: 's3' });
  });

  it('对象存储：缺少配置时拒绝启动；浏览器地址默认与服务端地址相同', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3', S3_ENDPOINT: 'http://minio:9000' })).toThrow(/S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    expect(loadConfig({ ...s3 }).s3).toEqual({
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      publicEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      region: 'oss-cn-hangzhou',
      bucket: 'creature-files',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      forcePathStyle: false,
    });
    expect(loadConfig({ ...s3, S3_PUBLIC_ENDPOINT: 'https://files.example.com', S3_FORCE_PATH_STYLE: 'true' }).s3).toMatchObject({ publicEndpoint: 'https://files.example.com', forcePathStyle: true });
    expect(loadConfig({}).storageDriver).toBe('local');
  });

  it('Worker：各模态并发默认取 WORKER_CONCURRENCY，可单独覆盖', () => {
    expect(loadConfig({}).worker.concurrency).toEqual({ image: 4, video: 4, text: 4, audio: 4 });
    expect(loadConfig({ WORKER_CONCURRENCY: '6', WORKER_CONCURRENCY_VIDEO: '2' }).worker.concurrency).toEqual({ image: 6, video: 2, text: 6, audio: 6 });
  });

  it('staging：密钥与数据库按生产要求，允许 Mock 集成；Cookie 是否仅 HTTPS 可配置', () => {
    expect(() => loadConfig({ APP_ENV: 'staging', NODE_ENV: 'production' })).toThrow(/staging 环境缺少配置/);
    const c = loadConfig({ APP_ENV: 'staging', NODE_ENV: 'production', ...secrets });
    expect(c).toMatchObject({ env: 'staging', smsMode: 'dev', providerMode: 'mock', cookieSecure: false });
    expect(loadConfig({ APP_ENV: 'staging', ...secrets, COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(loadConfig({ ADMIN_PHONES: '13800000001, 13800000002' }).adminPhones).toEqual(['13800000001', '13800000002']);
  });
});
