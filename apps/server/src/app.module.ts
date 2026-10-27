import { Controller, Get, Inject, INestApplication, Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CanvasesModule } from './canvases/canvases.module';
import { AllExceptionsFilter, requestIdMiddleware } from './common/http';
import { AppConfig, CONFIG, loadConfig } from './config';
import { CoreModule } from './core.module';
import { CreditsModule } from './credits/credits.module';
import { Db, DB } from './db/db';
import { GatewayModule } from './gateway/gateway.module';
import { ModelGateway } from './gateway/model-gateway.service';
import { GenerationsModule } from './generations/generations.module';
import { JobsService } from './jobs.service';
import { UsersModule } from './users/users.module';

@Controller('healthz')
class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly gateway: ModelGateway,
  ) {}

  @Get()
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true, db: this.db.driver, providers: this.config.providerMode, models: this.gateway.available().length };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(config), AuthModule, CreditsModule, UsersModule, GatewayModule, AssetsModule, GenerationsModule, BillingModule, CanvasesModule],
      controllers: [HealthController],
      providers: [JobsService],
    };
  }
}

/** 创建并配置应用（main.ts 与测试共用） */
export async function createApp(config: AppConfig = loadConfig()): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: config.env === 'test' ? ['error'] : ['log', 'warn', 'error'],
    // 启动失败时抛出异常而不是直接退出进程，由调用方决定如何处理
    abortOnError: false,
  });
  app.setGlobalPrefix('v1');
  app.set('trust proxy', 1);
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  // 画布文档可能较大（上限 1 MB，见 CanvasesService）；图片上传走签名 PUT，不经过 JSON 解析
  app.useBodyParser('json', { limit: '1100kb' });
  app.enableCors({ origin: config.corsOrigins, credentials: true, exposedHeaders: ['X-Request-Id'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  return app;
}
