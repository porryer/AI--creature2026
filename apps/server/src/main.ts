import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  const log = new Logger('Bootstrap');
  log.log(`造物 Creature 后端已启动：http://localhost:${config.port}/v1  （数据库：${config.databaseUrl ? 'PostgreSQL' : `PGlite ${config.pgliteDir ?? '内存'}`}，模型：${config.providerMode}）`);
  if (config.env !== 'production' && config.jwtSecret.startsWith('creature-dev')) log.warn('正在使用开发默认密钥，部署前请配置 JWT_SECRET 等环境变量');
  if (config.env === 'staging') {
    const mocks = [config.smsMode === 'dev' && '短信（验证码直接返回）', config.paymentsMode === 'mock' && '支付（模拟支付）', config.providerMode === 'mock' && '模型供应商'].filter(Boolean);
    if (mocks.length) log.warn(`staging 环境正在使用 Mock 集成：${mocks.join('、')}。不要对外开放`);
  }
}

bootstrap().catch((e) => {
  new Logger('Bootstrap').error(`启动失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
