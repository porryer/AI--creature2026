import { loadConfig } from '../src/config';

const secrets = {
  JWT_SECRET: 'x'.repeat(32),
  PHONE_ENC_KEY: 'a'.repeat(64),
  PHONE_HASH_KEY: 'b'.repeat(64),
  FILE_SIGNING_SECRET: 'y'.repeat(32),
  DATABASE_URL: 'postgres://u:p@db:5432/creature',
};

describe('配置', () => {
  it('开发环境全部可留空', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ env: 'development', smsMode: 'dev', paymentsMode: 'mock', providerMode: 'mock', cookieSecure: false });
  });

  it('生产环境：缺少密钥或仍使用 Mock 集成时拒绝启动', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/生产环境缺少配置：JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', ...secrets })).toThrow(/SMS_MODE=dev/);
    const c = loadConfig({ NODE_ENV: 'production', ...secrets, SMS_MODE: 'provider', PAYMENTS_MODE: 'live', PROVIDER_MODE: 'live' });
    expect(c).toMatchObject({ env: 'production', cookieSecure: true });
  });

  it('staging：密钥与数据库按生产要求，允许 Mock 集成；Cookie 是否仅 HTTPS 可配置', () => {
    expect(() => loadConfig({ APP_ENV: 'staging', NODE_ENV: 'production' })).toThrow(/staging 环境缺少配置/);
    const c = loadConfig({ APP_ENV: 'staging', NODE_ENV: 'production', ...secrets });
    expect(c).toMatchObject({ env: 'staging', smsMode: 'dev', providerMode: 'mock', cookieSecure: false });
    expect(loadConfig({ APP_ENV: 'staging', ...secrets, COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(loadConfig({ ADMIN_PHONES: '13800000001, 13800000002' }).adminPhones).toEqual(['13800000001', '13800000002']);
  });
});
