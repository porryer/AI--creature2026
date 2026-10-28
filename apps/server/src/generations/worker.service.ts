import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { estimateCredits, findModel, type Modality } from '@creature/shared';
import { AppConfig, CONFIG } from '../config';
import { newId } from '../common/ids';
import { CreditsService } from '../credits/credits.service';
import { Db, DB } from '../db/db';
import { EventBus } from '../events/event-bus';
import { GatewayError, ModelGateway } from '../gateway/model-gateway.service';
import type { ReferenceInput } from '../gateway/provider';
import { LabelingService, type LabeledOutput, type RawOutput } from '../safety/labeling.service';
import { ModerationService } from '../safety/moderation.service';
import { StorageService } from '../storage/storage.service';
import { GenerationsService, ledgerMemo, type TaskRow } from './generations.service';

/** 处理中的任务超过该时长视为卡死（含模型超时与余量），会被重新排队或判定失败 */
const STALE_MS: Record<Modality, number> = { image: 5 * 60_000, video: 20 * 60_000, text: 3 * 60_000, audio: 5 * 60_000 };
const MAX_ATTEMPTS = 3;

/**
 * 生成任务 Worker（docs/03-architecture.md 5.2 状态机）：
 * queued → running → post_processing → succeeded / failed / blocked。
 * 以数据库为队列（FOR UPDATE SKIP LOCKED），可水平扩展多个实例；后续可替换为 Temporal 工作流。
 */
@Injectable()
export class GenerationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running?: Promise<unknown>;

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
  ) {}

  onApplicationBootstrap() {
    if (!this.config.worker.enabled) return;
    const loop = async () => {
      if (this.stopped) return;
      this.running = this.runOnce().catch((e) => this.logger.error('Worker 轮询失败', e instanceof Error ? e.stack : String(e)));
      await this.running;
      if (!this.stopped) this.timer = setTimeout(loop, this.config.worker.pollMs);
    };
    this.timer = setTimeout(loop, 0);
    this.logger.log(`已启动：并发 ${this.config.worker.concurrency}，轮询间隔 ${this.config.worker.pollMs}ms`);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** 认领一批排队任务并处理完毕；返回处理的任务数（测试中可直接调用） */
  async runOnce(): Promise<number> {
    await this.recoverStale();
    const claimed = await this.db.query<TaskRow>(
      `UPDATE generation_tasks SET status = 'running', attempt = attempt + 1, started_at = now(), progress = 0
       WHERE id IN (SELECT id FROM generation_tasks WHERE status = 'queued' ORDER BY queue, created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [this.config.worker.concurrency],
    );
    await Promise.all(claimed.map((t) => this.process(t)));
    return claimed.length;
  }

  private async process(task: TaskRow) {
    const primary = findModel(task.model_code);
    try {
      if (!primary) throw new GatewayError('MODEL_NOT_FOUND', `模型 ${task.model_code} 不存在`, []);
      await this.publish(task.id, task.user_id);

      // 进度更新串行写库，每 10% 推送一次
      let last = 0;
      let chain = Promise.resolve();
      const onProgress = (pct: number) => {
        if (pct - last < 10) return;
        last = pct;
        chain = chain.then(() => this.setProgress(task, pct)).catch(() => undefined);
      };
      const references = await this.loadReferences(task);
      const result = await this.gateway.generate(primary, { taskId: task.id, modality: task.modality, operation: task.operation, prompt: task.prompt, params: task.params, references }, onProgress);
      await chain;

      // 只有当前这次尝试仍持有任务时才继续（任务可能已被超时回收并重新排队）
      const owned = await this.db.query(
        `UPDATE generation_tasks SET status = 'post_processing', progress = 90, used_model_code = $2 WHERE id = $1 AND status = 'running' AND attempt = $3 RETURNING id`,
        [task.id, result.model.code, task.attempt],
      );
      if (!owned.length) return;
      await this.publish(task.id, task.user_id);

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
      const actual = Math.min(task.estimated_credits, estimateCredits(result.model, task.params));
      const done = await this.db.tx(async (q) => {
        const rows = await q.query(
          `UPDATE generation_tasks SET status = 'succeeded', progress = 100, actual_credits = $2, vendor_cost_fen = $3, finished_at = now()
           WHERE id = $1 AND status = 'post_processing' AND attempt = $4 RETURNING id`,
          [task.id, actual, result.vendorCostFen, task.attempt],
        );
        if (!rows.length) return false;
        for (const [i, out] of labeled.entries()) await this.insertAsset(q, task, assetIds[i], out, result.outputs[i], result.model.name, i, labeled.length);
        await this.credits.settle(q, task.account_id, task.id, actual, ledgerMemo(task, result.model.name));
        return true;
      });
      if (!done) return;
      const dto = await this.generations.toDTO((await this.generations.row(task.user_id, task.id))!);
      this.bus.emit(task.user_id, { type: 'task.succeeded', task: dto });
      await this.credits.notify(task.account_id);
    } catch (e) {
      const code = e instanceof GatewayError ? e.code : 'INTERNAL';
      const message = e instanceof GatewayError ? e.message : '生成服务异常';
      if (!(e instanceof GatewayError)) this.logger.error(`[${task.id}] 处理失败`, e instanceof Error ? e.stack : String(e));
      await this.fail(task, 'failed', code, `${message}，已返还 ${task.estimated_credits} 积分`);
    }
  }

  /** 读取参考图：生成的作品用内部原始文件（不带角标），上传的素材即原图 */
  private async loadReferences(task: TaskRow): Promise<ReferenceInput[]> {
    const refs = task.input_refs ?? [];
    if (!refs.length && !task.mask_key) return [];
    const rows = await this.db.query<{ id: string; mime_type: string; storage_key: string; raw_storage_key: string | null; width: number | null; height: number | null }>(
      'SELECT id, mime_type, storage_key, raw_storage_key, width, height FROM assets WHERE id = ANY($1::text[]) AND user_id = $2',
      [refs.map((r) => r.asset_id), task.user_id],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ReferenceInput[] = [];
    for (const r of refs) {
      const a = byId.get(r.asset_id);
      if (!a) continue;
      out.push({ role: r.role, mime: a.mime_type, data: await this.storage.read(a.raw_storage_key ?? a.storage_key), width: a.width ?? undefined, height: a.height ?? undefined });
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

  private async fail(task: TaskRow, status: 'failed' | 'blocked', code: string, message: string) {
    const changed = await this.db.tx(async (q) => {
      const rows = await q.query(
        `UPDATE generation_tasks SET status = $2, error_code = $3, error_message = $4, finished_at = now()
         WHERE id = $1 AND status IN ('running', 'post_processing') AND attempt = $5 RETURNING id`,
        [task.id, status, code, message, task.attempt],
      );
      if (!rows.length) return false;
      await this.credits.refund(q, task.account_id, task.id, `${status === 'blocked' ? '审核拦截' : '生成失败'}返还 · ${findModel(task.model_code)?.name ?? task.model_code}`);
      return true;
    });
    if (!changed) return;
    const dto = await this.generations.toDTO((await this.generations.row(task.user_id, task.id))!);
    this.bus.emit(task.user_id, { type: 'task.failed', task: dto });
    await this.credits.notify(task.account_id);
  }

  private async setProgress(task: TaskRow, pct: number) {
    await this.db.query(`UPDATE generation_tasks SET progress = $2 WHERE id = $1 AND status = 'running' AND attempt = $3`, [task.id, pct, task.attempt]);
    await this.publish(task.id, task.user_id);
  }

  private async publish(taskId: string, userId: string) {
    if (!this.bus.listenerCount(userId)) return;
    const row = await this.generations.row(userId, taskId);
    if (row) this.bus.emit(userId, { type: 'task.progress', task: await this.generations.toDTO(row) });
  }

  /** 处理卡死的任务：未超过重试次数则重新排队，否则判定失败并返还 */
  async recoverStale(now = Date.now()) {
    const rows = await this.db.query<TaskRow>(`SELECT * FROM generation_tasks WHERE status IN ('running', 'post_processing')`);
    for (const t of rows) {
      if (!t.started_at || now - new Date(t.started_at).getTime() < STALE_MS[t.modality]) continue;
      if (t.attempt < MAX_ATTEMPTS) {
        await this.db.query(`UPDATE generation_tasks SET status = 'queued', progress = 0 WHERE id = $1 AND status IN ('running', 'post_processing') AND attempt = $2`, [t.id, t.attempt]);
        this.logger.warn(`[${t.id}] 处理超时，重新排队（第 ${t.attempt} 次）`);
      } else {
        await this.fail(t, 'failed', 'TIMEOUT', `生成超时，已返还 ${t.estimated_credits} 积分`);
      }
    }
  }
}
