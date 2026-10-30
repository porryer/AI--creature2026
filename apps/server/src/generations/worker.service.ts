import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { composePrompt, estimateCredits, findModel, type Modality, type TaskStatus } from '@creature/shared';
import { AnalyticsService } from '../analytics/analytics.service';
import { AppConfig, CONFIG } from '../config';
import { newId } from '../common/ids';
import { CreditsService } from '../credits/credits.service';
import { Db, DB } from '../db/db';
import { EventBus, TASK_STOP } from '../events/event-bus';
import { MetricsService } from '../observability/metrics.service';
import { GatewayError, ModelGateway, type StreamOptions } from '../gateway/model-gateway.service';
import type { ReferenceInput } from '../gateway/provider';
import { LabelingService, type LabeledOutput, type RawOutput } from '../safety/labeling.service';
import { ModerationService, type Verdict } from '../safety/moderation.service';
import { StorageService } from '../storage/storage.service';
import { GenerationsService, ledgerMemo, type TaskRow } from './generations.service';

/** 处理中的任务超过该时长视为卡死（含模型超时与余量），会被重新排队或判定失败 */
const STALE_MS: Record<Modality, number> = { image: 5 * 60_000, video: 20 * 60_000, text: 3 * 60_000, audio: 5 * 60_000 };
const MAX_ATTEMPTS = 3;
const MODALITIES: Modality[] = ['image', 'video', 'text', 'audio'];
/** 卡死任务检查间隔 */
const RECOVER_INTERVAL_MS = 30_000;
/** 流式输出的推送间隔：期间产出的文本合并为一条，推送前对已生成的全文做一次审核 */
const DELTA_FLUSH_MS = 120;
/** 单条推送的最大字数（跨实例通知有 8000 字节上限） */
const DELTA_MAX_CHARS = 1500;
/** 流式输出期间检查数据库中停止标记的间隔（跨实例停止通知丢失时的兜底） */
const STOP_CHECK_MS = 1000;

/**
 * 生成任务 Worker（docs/03-architecture.md 5.2 状态机）：
 * queued → running → post_processing → succeeded / failed / blocked。
 * 以数据库为队列（FOR UPDATE SKIP LOCKED），可水平扩展多个实例；后续可替换为 Temporal 工作流。
 * 每个模态有独立的并发槽位，任务结束即补位认领，慢任务不会拖住其他任务。
 */
@Injectable()
export class GenerationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private timer?: NodeJS.Timeout;
  private recoverTimer?: NodeJS.Timeout;
  private stopped = false;
  /** 后台循环是否开启（测试中关闭，由 runOnce 驱动） */
  private looping = false;
  private claiming?: Promise<number>;
  private refill = false;
  private readonly active = new Map<string, { task: TaskRow; done: Promise<void> }>();
  /** 本实例正在流式输出的任务：用户停止时中止 */
  private readonly stops = new Map<string, AbortController>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly gateway: ModelGateway,
    private readonly credits: CreditsService,
    private readonly moderation: ModerationService,
    private readonly labeling: LabelingService,
    private readonly storage: StorageService,
    private readonly generations: GenerationsService,
    private readonly bus: EventBus,
    private readonly metrics: MetricsService,
    private readonly analytics: AnalyticsService,
  ) {
    bus.onControl(TASK_STOP, (d) => typeof d.id === 'string' && this.stops.get(d.id)?.abort());
  }

  onApplicationBootstrap() {
    if (!this.config.worker.enabled) return;
    this.looping = true;
    const loop = async () => {
      if (this.stopped) return;
      await this.fill().catch((e) => this.logger.error('Worker 认领任务失败', e instanceof Error ? e.stack : String(e)));
      if (!this.stopped) this.timer = setTimeout(loop, this.config.worker.pollMs);
    };
    this.timer = setTimeout(loop, 0);
    const recover = () => void this.recoverStale().catch((e) => this.logger.error('卡死任务检查失败', e instanceof Error ? e.stack : String(e)));
    recover();
    this.recoverTimer = setInterval(recover, RECOVER_INTERVAL_MS);
    const c = this.config.worker.concurrency;
    this.logger.log(`已启动：并发 图像 ${c.image} / 视频 ${c.video} / 文本 ${c.text} / 音频 ${c.audio}，轮询间隔 ${this.config.worker.pollMs}ms`);
  }

  /** 停止认领；等待处理中的任务，超过宽限期仍未结束的重新排队，由其他实例接手（不必等卡死回收） */
  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.recoverTimer);
    await this.claiming?.catch(() => undefined);
    if (!this.active.size) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.all([...this.active.values()].map((a) => a.done)).then(() => false),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(true), this.config.worker.shutdownGraceMs))),
    ]);
    clearTimeout(timer);
    if (timedOut) await this.requeueActive();
  }

  /** 认领排队任务并处理完毕；返回认领的任务数（测试中直接调用，后台循环关闭时不会自动补位） */
  async runOnce(): Promise<number> {
    await this.recoverStale();
    const n = await this.fill();
    await Promise.all([...this.active.values()].map((a) => a.done));
    return n;
  }

  /** 各模态正在处理的任务数 */
  activeCounts(): Record<Modality, number> {
    const counts = { image: 0, video: 0, text: 0, audio: 0 };
    for (const { task } of this.active.values()) counts[task.modality]++;
    return counts;
  }

  /** 按各模态的空闲槽位认领任务并开始处理（不等待处理完成）。同一时刻只有一次认领在进行，期间的补位请求在其后合并执行 */
  private fill(): Promise<number> {
    if (this.claiming) {
      this.refill = true;
      return this.claiming;
    }
    this.claiming = this.claim().finally(() => {
      this.claiming = undefined;
      if (this.refill && this.looping && !this.stopped) {
        this.refill = false;
        void this.fill().catch(() => undefined);
      }
    });
    return this.claiming;
  }

  private async claim(): Promise<number> {
    if (this.stopped) return 0;
    const counts = this.activeCounts();
    const free = MODALITIES.map((m) => [m, this.config.worker.concurrency[m] - counts[m]] as const).filter(([, n]) => n > 0);
    if (!free.length) return 0;
    const claimed = await this.db.query<TaskRow>(
      `UPDATE generation_tasks SET status = 'running', attempt = attempt + 1, started_at = now(), progress = 0
        WHERE id IN (
          SELECT c.id FROM unnest($1::text[], $2::int[]) AS m(modality, n)
          CROSS JOIN LATERAL (
            SELECT id FROM generation_tasks WHERE status = 'queued' AND modality = m.modality
             ORDER BY queue, created_at LIMIT m.n FOR UPDATE SKIP LOCKED
          ) c)
        RETURNING *`,
      [free.map(([m]) => m), free.map(([, n]) => n)],
    );
    for (const t of claimed) this.start(t);
    return claimed.length;
  }

  private start(task: TaskRow) {
    const done = this.process(task)
      .catch((e) => this.logger.error(`[${task.id}] 处理异常`, e instanceof Error ? e.stack : String(e)))
      .finally(() => {
        this.active.delete(task.id);
        if (this.looping && !this.stopped) void this.fill().catch(() => undefined);
      });
    this.active.set(task.id, { task, done });
  }

  private async requeueActive() {
    for (const { task } of this.active.values()) {
      const r = await this.db.query(
        `UPDATE generation_tasks SET status = 'queued', progress = 0 WHERE id = $1 AND status IN ('running', 'post_processing') AND attempt = $2 RETURNING id`,
        [task.id, task.attempt],
      );
      if (r.length) this.logger.warn(`[${task.id}] 停机时仍未完成，已重新排队`);
    }
  }

  private async process(task: TaskRow) {
    const primary = findModel(task.model_code);
    const stream = task.modality === 'text' && task.operation !== 'edit' ? this.streamer(task) : undefined;
    try {
      if (!primary) throw new GatewayError('MODEL_NOT_FOUND', `模型 ${task.model_code} 不存在`, []);
      await this.publish(task.id, task.user_id, 'running');

      // 进度更新串行写库，每 10% 推送一次
      let last = 0;
      let chain = Promise.resolve();
      const onProgress = (pct: number) => {
        if (pct - last < 10) return;
        last = pct;
        chain = chain.then(() => this.setProgress(task, pct)).catch(() => undefined);
      };
      const references = await this.loadReferences(task);
      // 发给模型的提示词附加角色设定与品牌规范；品牌标准色同时作为调色板传给适配器
      const prompt = composePrompt(task.prompt, task.modality, task.context);
      const palette = task.context?.brand_kit?.colors.map((c) => c.hex);
      const result = await this.gateway.generate(primary, { taskId: task.id, modality: task.modality, operation: task.operation, prompt, params: task.params, references, palette }, onProgress, stream?.options);
      await chain;
      stream?.finish();
      if (stream?.blocked) return await this.blockStream(task, stream.blocked);
      // 停止时还没有任何输出：按取消处理，全额返还
      if (result.stopped && !result.outputs.some((o) => o.text?.trim())) return await this.fail(task, 'canceled', 'CANCELED', `已停止生成，返还 ${task.estimated_credits} 积分`);

      // 只有当前这次尝试仍持有任务时才继续（任务可能已被超时回收并重新排队）
      const owned = await this.db.query(
        `UPDATE generation_tasks SET status = 'post_processing', progress = 90, used_model_code = $2 WHERE id = $1 AND status = 'running' AND attempt = $3 RETURNING id`,
        [task.id, result.model.code, task.attempt],
      );
      if (!owned.length) return;
      await this.publish(task.id, task.user_id, 'post_processing');

      // 输出审核
      for (const out of result.outputs) {
        const v = this.moderation.checkOutput(out);
        await this.moderation.record({ userId: task.user_id, targetType: 'output', targetId: task.id, result: v });
        if (v.verdict === 'block') return await this.fail(task, 'blocked', 'CONTENT_BLOCKED', '生成内容未通过审核，已返还积分');
      }

      // 添加 AI 标识、写入存储
      const labeled = result.outputs.map((o) => this.labeling.apply(o));
      const assetIds: string[] = [];
      for (const [i, out] of labeled.entries()) {
        const id = newId('ast');
        assetIds.push(id);
        await this.storage.put(StorageService.keyFor('private', task.user_id, id, out.mime), result.outputs[i].data);
        await this.storage.put(StorageService.keyFor('public', task.user_id, id, out.mime), out.data);
      }

      // 写资产、结算积分、更新状态在同一事务内完成
      // 写作按实际输出字数计费（不超过预估）
      const billed = stream ? { ...task.params, chars: result.outputs.reduce((n, o) => n + (o.text?.length ?? 0), 0) } : task.params;
      const actual = Math.min(task.estimated_credits, estimateCredits(result.model, billed));
      const done = await this.db.tx(async (q) => {
        const rows = await q.query(
          `UPDATE generation_tasks SET status = 'succeeded', progress = 100, actual_credits = $2, vendor_cost_fen = $3, finished_at = now(), stopped = $5
           WHERE id = $1 AND status = 'post_processing' AND attempt = $4 RETURNING id`,
          [task.id, actual, result.vendorCostFen, task.attempt, result.stopped],
        );
        if (!rows.length) return false;
        for (const [i, out] of labeled.entries()) await this.insertAsset(q, task, assetIds[i], out, result.outputs[i], result.model.name, i, labeled.length);
        await this.credits.settle(q, task.account_id, task.id, actual, ledgerMemo(task, result.model.name));
        return true;
      });
      if (!done) return;
      await this.finished(task, 'succeeded');
      const dto = await this.generations.toDTO((await this.generations.row(task.user_id, task.id))!);
      this.bus.emit(task.user_id, { type: 'task.succeeded', task: dto });
      await this.credits.notify(task.account_id);
    } catch (e) {
      stream?.finish();
      if (stream?.blocked) return await this.blockStream(task, stream.blocked);
      const code = e instanceof GatewayError ? e.code : 'INTERNAL';
      const message = e instanceof GatewayError ? e.message : '生成服务异常';
      if (!(e instanceof GatewayError)) this.logger.error(`[${task.id}] 处理失败`, e instanceof Error ? e.stack : String(e));
      await this.fail(task, 'failed', code, `${message}，已返还 ${task.estimated_credits} 积分`);
    } finally {
      stream?.close();
    }
  }

  /**
   * 写作任务的流式输出：适配器产出的文本按 DELTA_FLUSH_MS 合并推送；
   * 每次推送前审核已生成的全文，命中拦截时中止生成（已推送的部分由客户端在任务失败后清除，未通过的文字不会推送）。
   * 切换备选模型时从头重新推送（offset 回到 0）。
   */
  private streamer(task: TaskRow) {
    const stop = new AbortController();
    const abort = new AbortController();
    this.stops.set(task.id, stop);
    let text = '';
    let sent = 0;
    let candidate = 0;
    let timer: NodeJS.Timeout | undefined;
    let lastStopCheck = Date.now();
    let blocked: Verdict | null = null;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (blocked || abort.signal.aborted) return;
      const v = this.moderation.checkText(text);
      if (v.verdict === 'block') {
        blocked = v;
        abort.abort();
        return;
      }
      while (sent < text.length) {
        const piece = text.slice(sent, sent + DELTA_MAX_CHARS);
        this.bus.emit(task.user_id, { type: 'task.delta', task_id: task.id, offset: sent, text: piece });
        sent += piece.length;
      }
      if (Date.now() - lastStopCheck >= STOP_CHECK_MS && !stop.signal.aborted) {
        lastStopCheck = Date.now();
        void this.db
          .query<{ stop_requested: boolean }>('SELECT stop_requested FROM generation_tasks WHERE id = $1', [task.id])
          .then(([r]) => r?.stop_requested && stop.abort())
          .catch(() => undefined);
      }
    };
    const options: StreamOptions = {
      onDelta: (t, i) => {
        if (i !== candidate) {
          candidate = i;
          text = '';
          sent = 0;
        }
        text += t;
        timer ??= setTimeout(flush, DELTA_FLUSH_MS);
      },
      stop: stop.signal,
      abort: abort.signal,
    };
    return {
      options,
      get blocked() {
        return blocked;
      },
      /** 推送剩余的文本（并做最后一次审核） */
      finish: flush,
      close: () => {
        clearTimeout(timer);
        this.stops.delete(task.id);
      },
    };
  }

  private async blockStream(task: TaskRow, v: Verdict) {
    await this.moderation.record({ userId: task.user_id, targetType: 'output', targetId: task.id, result: v });
    await this.fail(task, 'blocked', 'CONTENT_BLOCKED', '生成内容未通过审核，已停止生成并返还积分');
  }

  /** 读取参考图：生成的作品用内部原始文件（不带角标），上传的素材即原图 */
  /** 参考图：用户指定的参考图、引用角色的参考图（按角色分组）、品牌 Logo、涂抹区域 */
  private async loadReferences(task: TaskRow): Promise<ReferenceInput[]> {
    const ctx = task.context;
    const refs: { asset_id: string; role: ReferenceInput['role']; group?: string }[] = [
      ...(task.input_refs ?? []),
      ...(ctx?.characters ?? []).flatMap((c) => c.ref_asset_ids.map((asset_id) => ({ asset_id, role: 'character' as const, group: c.id }))),
      ...(ctx?.place_logo && ctx.brand_kit?.logo_asset_id ? [{ asset_id: ctx.brand_kit.logo_asset_id, role: 'logo' as const }] : []),
    ];
    if (!refs.length && !task.mask_key) return [];
    // 文件已被清理的作品（删除超过宽限期）跳过
    const rows = await this.db.query<{ id: string; mime_type: string; storage_key: string; raw_storage_key: string | null; width: number | null; height: number | null }>(
      'SELECT id, mime_type, storage_key, raw_storage_key, width, height FROM assets WHERE id = ANY($1::text[]) AND user_id = $2 AND files_purged_at IS NULL',
      [refs.map((r) => r.asset_id), task.user_id],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ReferenceInput[] = [];
    for (const r of refs) {
      const a = byId.get(r.asset_id);
      if (!a) continue;
      out.push({ role: r.role, group: r.group, mime: a.mime_type, data: await this.storage.read(a.raw_storage_key ?? a.storage_key), width: a.width ?? undefined, height: a.height ?? undefined });
    }
    if (task.mask_key) out.push({ role: 'mask', mime: 'image/png', data: await this.storage.read(task.mask_key) });
    return out;
  }

  private async insertAsset(q: { query: Db['query'] }, task: TaskRow, id: string, out: LabeledOutput, raw: RawOutput, modelName: string, i: number, n: number) {
    const title = `${task.prompt.slice(0, 16)}${task.prompt.length > 16 ? '…' : ''}${n > 1 ? ` · ${i + 1}` : ''}`;
    await q.query(
      `INSERT INTO assets (id, user_id, task_id, kind, title, prompt, model_name, storage_key, raw_storage_key, mime_type, width, height, duration_ms, size_bytes, text_content, content_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        task.user_id,
        task.id,
        out.kind,
        title,
        task.prompt,
        modelName,
        StorageService.keyFor('public', task.user_id, id, out.mime),
        StorageService.keyFor('private', task.user_id, id, raw.mime),
        out.mime,
        out.width ?? null,
        out.height ?? null,
        out.durationMs ?? null,
        out.data.length,
        out.text ?? null,
        out.contentId,
      ],
    );
  }

  private async fail(task: TaskRow, status: 'failed' | 'blocked' | 'canceled', code: string, message: string) {
    const changed = await this.db.tx(async (q) => {
      const rows = await q.query(
        `UPDATE generation_tasks SET status = $2, error_code = $3, error_message = $4, finished_at = now()
         WHERE id = $1 AND status IN ('running', 'post_processing') AND attempt = $5 RETURNING id`,
        [task.id, status, code, message, task.attempt],
      );
      if (!rows.length) return false;
      const reason = { blocked: '审核拦截', canceled: '停止生成', failed: '生成失败' }[status];
      await this.credits.refund(q, task.account_id, task.id, `${reason}返还 · ${findModel(task.model_code)?.name ?? task.model_code}`);
      return true;
    });
    if (!changed) return;
    await this.finished(task, status, code);
    const dto = await this.generations.toDTO((await this.generations.row(task.user_id, task.id))!);
    this.bus.emit(task.user_id, { type: 'task.failed', task: dto });
    await this.credits.notify(task.account_id);
  }

  /** 任务结束：计数与端到端耗时（从提交到结束，含排队），并记录埋点 */
  private async finished(task: TaskRow, status: string, errorCode?: string) {
    const labels = { modality: task.modality, status };
    const durationMs = Date.now() - new Date(task.created_at).getTime();
    this.metrics.inc('creature_tasks_finished_total', '结束的生成任务数', labels);
    this.metrics.observe('creature_task_duration_seconds', '生成任务从提交到结束的耗时', { modality: task.modality }, durationMs / 1000);
    await this.analytics.track(task.user_id, status === 'succeeded' ? 'task_succeeded' : 'task_failed', {
      task_id: task.id,
      task_type: task.modality,
      operation: task.operation,
      model: task.model_code,
      duration_ms: durationMs,
      error_code: errorCode ?? null,
      retry_count: Math.max(0, task.attempt - 1),
      source: task.source,
      template_id: task.template_id,
    });
  }

  private async setProgress(task: TaskRow, pct: number) {
    await this.db.query(`UPDATE generation_tasks SET progress = $2 WHERE id = $1 AND status = 'running' AND attempt = $3`, [task.id, pct, task.attempt]);
    await this.publish(task.id, task.user_id, 'running');
  }

  /** 推送进度：本实例有该用户的连接时读取任务并推送（同时通知其他实例），否则只通知其他实例 */
  private async publish(taskId: string, userId: string, status: TaskStatus) {
    if (!this.bus.listenerCount(userId)) return this.bus.broadcastTask(userId, 'task.progress', { id: taskId, status });
    const row = await this.generations.row(userId, taskId);
    if (row) this.bus.emit(userId, { type: 'task.progress', task: await this.generations.toDTO(row) });
  }

  /** 处理卡死的任务：未超过重试次数则重新排队，否则判定失败并返还 */
  async recoverStale(now = Date.now()) {
    const rows = await this.db.query<TaskRow>(`SELECT * FROM generation_tasks WHERE status IN ('running', 'post_processing')`);
    for (const t of rows) {
      if (!t.started_at || now - new Date(t.started_at).getTime() < STALE_MS[t.modality]) continue;
      if (t.stop_requested) {
        await this.fail(t, 'canceled', 'CANCELED', `已停止生成，返还 ${t.estimated_credits} 积分`);
      } else if (t.attempt < MAX_ATTEMPTS) {
        await this.db.query(`UPDATE generation_tasks SET status = 'queued', progress = 0 WHERE id = $1 AND status IN ('running', 'post_processing') AND attempt = $2`, [t.id, t.attempt]);
        this.logger.warn(`[${t.id}] 处理超时，重新排队（第 ${t.attempt} 次）`);
      } else {
        await this.fail(t, 'failed', 'TIMEOUT', `生成超时，已返还 ${t.estimated_credits} 积分`);
      }
    }
  }
}
