import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { BillingService } from './billing/billing.service';
import { AppConfig, CONFIG } from './config';
import { CreditsService } from './credits/credits.service';
import { ReconcileService } from './credits/reconcile.service';
import { StorageCleanupService } from './storage/cleanup.service';
import { AccountService } from './users/account.service';

/** 周期性维护任务：积分过期、订阅月度发放与到期降级、定期全量对账、到期账号注销、存储清理。与 Worker 同进程运行，开关一致 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly credits: CreditsService,
    private readonly billing: BillingService,
    private readonly reconcile: ReconcileService,
    private readonly cleanup: StorageCleanupService,
    private readonly account: AccountService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.worker.enabled) return;
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    void this.runOnce();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async runOnce(now = new Date()) {
    try {
      const expired = await this.credits.expireDue(now);
      const subs = await this.billing.runDue(now);
      if (expired || subs.granted || subs.expired) this.logger.log(`过期积分 ${expired}，订阅发放 ${subs.granted} 次，到期降级 ${subs.expired} 人`);
      // 多实例同时到期时各自对账一次，只读查询，不影响正确性
      await this.reconcile.runIfDue(this.config.reconcileIntervalHours);
      // 先匿名化冷静期已过的账号，其作品文件随即由存储清理删除
      await this.account.finalizeDue(now);
      await this.cleanup.run(now);
    } catch (e) {
      this.logger.error('维护任务失败', e instanceof Error ? e.stack : String(e));
    }
  }
}
