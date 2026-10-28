import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { fallbackModels, findModel, MODELS, modelsFor, routeModel, type Modality, type ModelInfo, type RouteResult, type RoutingStrategy } from '@creature/shared';
import { AppConfig, CONFIG } from '../config';
import { MetricsService } from '../observability/metrics.service';
import type { RawOutput } from '../safety/labeling.service';
import { AdapterRequest, PROVIDER_ADAPTERS, ProviderAdapter, VendorError } from './provider';

const WINDOW_MS = 5 * 60_000;
const MIN_SAMPLES = 10;
const BREAKER_THRESHOLD = 0.85;
const BREAKER_OPEN_MS = 5 * 60_000;
const MAX_CANDIDATES = 3;
const TIMEOUT_MS: Record<Modality, number> = { image: 120_000, video: 15 * 60_000, text: 60_000, audio: 120_000 };

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly attempts: { model: string; code: string }[],
  ) {
    super(message);
  }
}

export interface GatewayResult {
  model: ModelInfo;
  outputs: RawOutput[];
  vendorCostFen: number;
  attempts: { model: string; code: string }[];
}

export interface ModelHealth {
  code: string;
  samples: number;
  successRate: number | null;
  breakerOpen: boolean;
}

/**
 * 模型网关（docs/03-architecture.md 5.1）：
 * 统一请求 → 智能路由 → 供应商适配器；主模型可重试失败时依次切换备选模型；
 * 按 5 分钟滑动窗口统计成功率，低于 85% 时熔断该模型 5 分钟。
 */
@Injectable()
export class ModelGateway {
  private readonly logger = new Logger('ModelGateway');
  private readonly outcomes = new Map<string, { t: number; ok: boolean }[]>();
  private readonly openUntil = new Map<string, number>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PROVIDER_ADAPTERS) private readonly adapters: ProviderAdapter[],
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const missing = MODELS.filter((m) => !this.adapterFor(m)).map((m) => m.code);
    if (missing.length) this.logger.warn(`以下模型没有可用的供应商适配器，已停用：${missing.join(', ')}`);
  }

  private adapterFor(model: ModelInfo): ProviderAdapter | undefined {
    return this.adapters.find((a) => a.supports(model));
  }

  /** 可供路由的模型：有适配器且未熔断 */
  available(modality?: Modality): ModelInfo[] {
    const pool = modality ? modelsFor(modality) : MODELS;
    return pool.filter((m) => this.adapterFor(m) && !this.isOpen(m.code));
  }

  /** 是否已配置供应商适配器（不考虑熔断） */
  configured(code: string): boolean {
    const m = findModel(code);
    return !!m && !!this.adapterFor(m);
  }

  /** 校验用户手动指定的模型 */
  resolvePinned(code: string, modality: Modality): ModelInfo | null {
    const m = findModel(code);
    if (!m || m.modality !== modality || m.editOnly || !this.adapterFor(m)) return null;
    return m;
  }

  route(modality: Modality, prompt: string, strategy: RoutingStrategy): RouteResult | null {
    const pool = this.available(modality);
    return pool.length ? routeModel(modality, prompt, strategy, pool) : null;
  }

  async generate(primary: ModelInfo, req: Omit<AdapterRequest, 'model' | 'candidateIndex' | 'signal'>, onProgress: (pct: number) => void): Promise<GatewayResult> {
    // 配乐与配音不能互为备选
    // 配乐与图像编辑没有可替代的模型，不切换备选
    const pool = primary.code === 'creature-music' || primary.editOnly ? [] : this.available(primary.modality);
    const candidates = [primary, ...fallbackModels(primary, pool)]
      .filter((m, i) => i === 0 || !this.isOpen(m.code))
      .slice(0, MAX_CANDIDATES);
    const attempts: { model: string; code: string }[] = [];
    for (const [i, model] of candidates.entries()) {
      const adapter = this.adapterFor(model);
      if (!adapter) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS[model.modality]);
      try {
        const r = await adapter.generate({ ...req, model, candidateIndex: i, signal: ctrl.signal }, onProgress);
        this.record(model.code, true);
        return { model, outputs: r.outputs, vendorCostFen: r.vendorCostFen, attempts };
      } catch (e) {
        const err = e instanceof VendorError ? e : new VendorError('VENDOR_ERROR', e instanceof Error ? e.message : String(e), true);
        this.record(model.code, false);
        attempts.push({ model: model.code, code: err.code });
        this.logger.warn(`[${req.taskId}] ${model.code} 失败（${err.code}）：${err.message}`);
        if (!err.retryable) throw new GatewayError(err.code, err.message, attempts);
      } finally {
        clearTimeout(timer);
      }
    }
    const tried = attempts.map((a) => findModel(a.model)?.name ?? a.model).join('、');
    throw new GatewayError('ALL_MODELS_FAILED', `已依次尝试 ${tried}，均未成功`, attempts);
  }

  health(): ModelHealth[] {
    const now = Date.now();
    return MODELS.map((m) => {
      const list = (this.outcomes.get(m.code) ?? []).filter((o) => now - o.t < WINDOW_MS);
      return { code: m.code, samples: list.length, successRate: list.length ? list.filter((o) => o.ok).length / list.length : null, breakerOpen: this.isOpen(m.code) };
    });
  }

  private record(code: string, ok: boolean) {
    this.metrics?.inc('creature_model_calls_total', '模型调用次数（含切换备选）', { model: code, result: ok ? 'ok' : 'error' });
    const now = Date.now();
    const list = (this.outcomes.get(code) ?? []).filter((o) => now - o.t < WINDOW_MS);
    list.push({ t: now, ok });
    this.outcomes.set(code, list);
    if (list.length >= MIN_SAMPLES && list.filter((o) => o.ok).length / list.length < BREAKER_THRESHOLD && !this.isOpen(code)) {
      this.openUntil.set(code, now + BREAKER_OPEN_MS);
      this.outcomes.set(code, []);
      this.logger.warn(`${code} 近 5 分钟成功率低于 ${BREAKER_THRESHOLD * 100}%，熔断 5 分钟`);
    }
  }

  private isOpen(code: string) {
    return (this.openUntil.get(code) ?? 0) > Date.now();
  }
}
