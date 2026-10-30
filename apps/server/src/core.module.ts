import { DynamicModule, Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { AnalyticsService } from './analytics/analytics.service';
import { AppConfig, CONFIG } from './config';
import { Db, DB, migrate, openDb } from './db/db';
import { EventBus } from './events/event-bus';
import { MetricsService } from './observability/metrics.service';
import { StorageService } from './storage/storage.service';

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onApplicationShutdown() {
    await this.db.close();
  }
}

/** 全局基础设施：配置、数据库（启动时自动迁移）、事件总线、文件存储、指标、埋点 */
@Global()
@Module({})
export class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: DB,
          useFactory: async () => {
            const db = await openDb(config);
            await migrate(db);
            return db;
          },
        },
        DbLifecycle,
        EventBus,
        StorageService,
        MetricsService,
        AnalyticsService,
      ],
      exports: [CONFIG, DB, EventBus, StorageService, MetricsService, AnalyticsService],
    };
  }
}
