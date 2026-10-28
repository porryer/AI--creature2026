import { Controller, Get, Headers, Inject, Logger, Module, Res } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { MODELS } from '@creature/shared';
import { Errors } from '../common/errors';
import type { AuthedRequest } from '../common/http';
import { AppConfig, CONFIG } from '../config';
import { Db, DB } from '../db/db';
import { GatewayModule } from '../gateway/gateway.module';
import { ModelGateway } from '../gateway/model-gateway.service';
import { MetricsService } from './metrics.service';

const SKIP_LOG = new Set(['/v1/healthz', '/v1/metrics']);

/**
 * 请求级中间件：安全响应头、请求计数与耗时（按路由模板聚合，避免 ID 造成高基数）、访问日志。
 * 在路由之前注册，响应结束时记录。
 */
export function httpObservability(metrics: MetricsService, config: AppConfig) {
  const log = new Logger('HTTP');
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // 接口只返回数据，不应被当作页面渲染；文件接口会改成自己的沙箱策略
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = (req as Request & { route?: { path?: string } }).route?.path ?? 'unmatched';
      const labels = { method: req.method, route, status: String(res.statusCode) };
      metrics.inc('creature_http_requests_total', 'HTTP 请求数', labels);
      metrics.observe('creature_http_request_duration_seconds', 'HTTP 请求耗时', { method: req.method, route }, seconds);
      const path = req.originalUrl.split('?')[0];
      if (config.accessLog && !SKIP_LOG.has(path)) {
        log.log(`${req.method} ${path.slice(0, 120)} ${res.statusCode} ${(seconds * 1000).toFixed(0)}ms ${req.requestId ?? '-'}${req.user ? ` ${req.user.id}` : ''}`);
      }
    });
    next();
  };
}

/** Prometheus 抓取端点：设置 METRICS_TOKEN 后需要 Authorization: Bearer <token>；未设置时只在开发与测试环境开放 */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly metrics: MetricsService,
    private readonly gateway: ModelGateway,
  ) {}

  @Get()
  async scrape(@Headers('authorization') authorization: string | undefined, @Res() res: Response) {
    const token = this.config.metricsToken;
    if (token) {
      const given = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
      const expected = Buffer.from(token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw Errors.unauthenticated('需要有效的指标令牌');
    } else if (this.config.env === 'production' || this.config.env === 'staging') {
      throw Errors.notFound('接口');
    }

    const [queue, reconcile] = await Promise.all([
      this.db.query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM generation_tasks WHERE status IN ('queued', 'running', 'post_processing') GROUP BY status`),
      this.db.query<{ mismatches: number; finished_at: Date | null }>(`SELECT mismatches, finished_at FROM reconcile_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`).catch(() => []),
    ]);
    const health = this.gateway.health();
    const mem = process.memoryUsage();
    const body = this.metrics.render([
      { name: 'creature_tasks_in_flight', help: '排队中与生成中的任务数', samples: ['queued', 'running', 'post_processing'].map((s) => ({ labels: { status: s }, value: queue.find((q) => q.status === s)?.n ?? 0 })) },
      { name: 'creature_model_breaker_open', help: '模型是否处于熔断（1 为熔断）', samples: health.map((h) => ({ labels: { model: h.code }, value: h.breakerOpen ? 1 : 0 })) },
      {
        name: 'creature_model_window_success_ratio',
        help: '模型近 5 分钟成功率（无样本时不输出）',
        samples: health.filter((h) => h.successRate !== null).map((h) => ({ labels: { model: h.code }, value: h.successRate! })),
      },
      { name: 'creature_models_configured', help: '已配置供应商适配器的模型数', samples: [{ value: MODELS.filter((m) => this.gateway.configured(m.code)).length }] },
      { name: 'creature_reconcile_mismatches', help: '最近一次对账发现的不一致账户数', samples: [{ value: reconcile[0]?.mismatches ?? 0 }] },
      { name: 'creature_reconcile_last_success_timestamp_seconds', help: '最近一次完成对账的时间', samples: [{ value: reconcile[0]?.finished_at ? Math.floor(new Date(reconcile[0].finished_at).getTime() / 1000) : 0 }] },
      { name: 'process_resident_memory_bytes', help: '常驻内存', samples: [{ value: mem.rss }] },
      { name: 'nodejs_heap_used_bytes', help: 'V8 堆已用', samples: [{ value: mem.heapUsed }] },
      { name: 'process_uptime_seconds', help: '进程运行时长', samples: [{ value: Math.round(process.uptime()) }] },
    ]);
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }
}

@Module({
  imports: [GatewayModule],
  controllers: [MetricsController],
})
export class ObservabilityModule {}
