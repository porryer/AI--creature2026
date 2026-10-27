import { Inject, Injectable } from '@nestjs/common';
import { estimateCredits, findModel, normalizeParams, PLANS, TIER_LABEL, type GenerationParams, type Modality, type Operation, type PlanCode, type TaskDTO, type TaskStatus } from '@creature/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssetsService } from '../assets/assets.service';
import { Errors } from '../common/errors';
import { newId } from '../common/ids';
import { parse } from '../common/http';
import { CreditsService } from '../credits/credits.service';
import { Db, DB, isUniqueViolation } from '../db/db';
import { EventBus } from '../events/event-bus';
import { ParamsSchema, RoutingSchema } from '../gateway/gateway.module';
import { ModelGateway } from '../gateway/model-gateway.service';
import { ModerationService } from '../safety/moderation.service';

export const CreateSchema = z.object({
  modality: z.enum(['image', 'video', 'text', 'audio']),
  operation: z.enum(['generate', 'edit']).default('generate'),
  prompt: z.string().trim().min(1, '请输入提示词').max(4000),
  params: ParamsSchema.default({}),
  routing: RoutingSchema,
  source: z.enum(['studio', 'canvas', 'agent', 'template']).default('studio'),
});

export interface TaskRow {
  id: string;
  user_id: string;
  account_id: string;
  modality: Modality;
  operation: Operation;
  model_code: string;
  used_model_code: string | null;
  routing_strategy: string;
  routing_reason: string;
  prompt: string;
  params: GenerationParams;
  status: TaskStatus;
  queue: 'p0' | 'p1' | 'p2';
  progress: number;
  estimated_credits: number;
  actual_credits: number | null;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  request_hash: string;
  source: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const KIND_LABEL: Record<Modality, string> = { image: '图像生成', video: '视频生成', text: '写作', audio: '音频生成' };

export function ledgerMemo(t: Pick<TaskRow, 'modality' | 'params'>, modelName: string): string {
  const p = t.params;
  const spec =
    t.modality === 'image'
      ? `${String(p.resolution ?? '1k').toUpperCase()} ×${p.count ?? 1}`
      : t.modality === 'video'
        ? `${p.duration} 秒 ${p.resolution}${p.audio ? ' 含音频' : ''}`
        : t.modality === 'audio'
          ? `${p.seconds ?? ''} 秒`.trim()
          : `${p.chars ?? 800} 字`;
  return `${KIND_LABEL[t.modality]} · ${modelName} · ${spec}`;
}

@Injectable()
export class GenerationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly gateway: ModelGateway,
    private readonly credits: CreditsService,
    private readonly moderation: ModerationService,
    private readonly assets: AssetsService,
    private readonly bus: EventBus,
  ) {}

  async create(userId: string, rawBody: unknown, idemKey: string | undefined): Promise<{ task: TaskDTO; replay: boolean }> {
    if (!idemKey || !/^[\w-]{8,100}$/.test(idemKey)) throw Errors.invalid('请求头缺少有效的 Idempotency-Key（8–100 位字母、数字、- 或 _）');
    const body = parse(CreateSchema, rawBody);
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');

    const existing = await this.byIdemKey(userId, idemKey);
    if (existing) {
      if (existing.request_hash !== requestHash) throw Errors.idempotencyConflict();
      return { task: await this.toDTO(existing), replay: true };
    }

    // 输入审核：不通过直接拒绝，不冻结积分
    const verdict = this.moderation.checkText(body.prompt);
    if (verdict.verdict === 'block') {
      await this.moderation.record({ userId, targetType: 'prompt', targetId: null, result: verdict });
      throw Errors.contentRejected(verdict.labels[0] ?? 'policy');
    }

    const pinned = body.routing.pinned_model ? this.gateway.resolvePinned(body.routing.pinned_model, body.modality) : null;
    if (body.routing.pinned_model && !pinned) throw Errors.invalid('所选模型不可用或与创作类型不匹配');
    const routed = pinned ? { model: pinned, reason: `已手动指定 ${pinned.name}` } : this.gateway.route(body.modality, body.prompt, body.routing.strategy);
    if (!routed) throw Errors.modelUnavailable();
    const model = routed.model;
    const params = normalizeParams(model, body.params as GenerationParams);
    const estimate = estimateCredits(model, params);

    const [user] = await this.db.query<{ plan_code: PlanCode; plan_expires_at: Date | null }>('SELECT plan_code, plan_expires_at FROM users WHERE id = $1', [userId]);
    const planActive = user && (!user.plan_expires_at || new Date(user.plan_expires_at).getTime() > Date.now());
    const queue = PLANS[planActive ? user.plan_code : 'free']?.queue ?? 'p2';
    const accountId = await this.credits.accountIdFor(userId);
    const id = newId('tsk');

    try {
      await this.db.tx(async (q) => {
        // 先冻结（对积分账户加 FOR UPDATE 锁），再插入任务：插入时的外键检查会对账户加 KEY SHARE 锁，
        // 顺序反过来会在并发提交时互相等待锁升级而死锁
        await this.credits.freeze(q, accountId, estimate, id, `冻结 · ${ledgerMemo({ modality: body.modality, params }, model.name)}`);
        await q.query(
          `INSERT INTO generation_tasks (id, user_id, account_id, modality, operation, model_code, routing_strategy, routing_reason, prompt, params,
             status, queue, estimated_credits, idempotency_key, request_hash, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11, $12, $13, $14, $15)`,
          [id, userId, accountId, body.modality, body.operation, model.code, pinned ? 'pinned' : body.routing.strategy, routed.reason, body.prompt, JSON.stringify(params), queue, estimate, idemKey, requestHash, body.source],
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        // 并发重复提交：以先到的请求为准
        const again = await this.byIdemKey(userId, idemKey);
        if (again && again.request_hash === requestHash) return { task: await this.toDTO(again), replay: true };
        if (again) throw Errors.idempotencyConflict();
      }
      throw e;
    }

    const task = await this.toDTO((await this.row(userId, id))!);
    this.bus.emit(userId, { type: 'task.progress', task });
    await this.credits.notify(accountId);
    return { task, replay: false };
  }

  async get(userId: string, id: string): Promise<TaskDTO> {
    const r = await this.row(userId, id);
    if (!r) throw Errors.notFound('任务');
    return this.toDTO(r);
  }

  async list(userId: string, f: { modality?: Modality; cursor: string | null; limit: number }) {
    const rows = await this.db.query<TaskRow>(
      `SELECT * FROM generation_tasks WHERE user_id = $1 AND ($2::text IS NULL OR modality = $2) AND ($3::text IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
      [userId, f.modality ?? null, f.cursor, f.limit + 1],
    );
    const page = rows.slice(0, f.limit);
    const outputs = await this.assets.outputsFor(page.filter((r) => r.status === 'succeeded').map((r) => r.id));
    return { data: await Promise.all(page.map((r) => this.toDTO(r, outputs.get(r.id) ?? []))), next_cursor: rows.length > f.limit ? page[page.length - 1].id : null };
  }

  /** 取消排队中的任务并全额返还 */
  async cancel(userId: string, id: string): Promise<TaskDTO> {
    const r = await this.row(userId, id);
    if (!r) throw Errors.notFound('任务');
    const canceled = await this.db.tx(async (q) => {
      const rows = await q.query<TaskRow>(`UPDATE generation_tasks SET status = 'canceled', finished_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`, [id]);
      if (!rows.length) return null;
      await this.credits.refund(q, r.account_id, id, `取消任务返还 · ${findModel(r.model_code)?.name ?? r.model_code}`);
      return rows[0];
    });
    if (!canceled) throw Errors.conflict('TASK_NOT_CANCELABLE', '任务已开始生成，无法取消');
    const task = await this.toDTO(canceled);
    this.bus.emit(userId, { type: 'task.failed', task });
    await this.credits.notify(r.account_id);
    return task;
  }

  async row(userId: string, id: string): Promise<TaskRow | undefined> {
    return (await this.db.query<TaskRow>('SELECT * FROM generation_tasks WHERE id = $1 AND user_id = $2', [id, userId]))[0];
  }

  private async byIdemKey(userId: string, key: string): Promise<TaskRow | undefined> {
    return (await this.db.query<TaskRow>('SELECT * FROM generation_tasks WHERE user_id = $1 AND idempotency_key = $2', [userId, key]))[0];
  }

  async toDTO(r: TaskRow, outputs?: TaskDTO['outputs']): Promise<TaskDTO> {
    const model = findModel(r.used_model_code ?? r.model_code);
    let position: number | null = null;
    if (r.status === 'queued') {
      const [p] = await this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM generation_tasks WHERE status = 'queued' AND (queue < $1 OR (queue = $1 AND created_at < $2))`,
        [r.queue, r.created_at],
      );
      position = (p?.n ?? 0) + 1;
    }
    const outs = outputs ?? (r.status === 'succeeded' ? ((await this.assets.outputsFor([r.id])).get(r.id) ?? []) : []);
    return {
      id: r.id,
      modality: r.modality,
      operation: r.operation,
      status: r.status,
      progress: r.progress,
      prompt: r.prompt,
      params: r.params,
      model: { code: model?.code ?? r.model_code, name: model?.name ?? r.model_code, tier: model?.tier ?? 'standard' },
      routing_reason: r.used_model_code && r.used_model_code !== r.model_code ? `${r.routing_reason}；主模型不可用，已自动切换到 ${model?.name}（${TIER_LABEL[model?.tier ?? 'standard']}）` : r.routing_reason,
      estimated_credits: r.estimated_credits,
      actual_credits: r.actual_credits,
      queue: { name: r.queue, position },
      outputs: outs,
      error: r.error_code ? { code: r.error_code, message: r.error_message ?? '' } : null,
      source: r.source as TaskDTO['source'],
      created_at: new Date(r.created_at).toISOString(),
      finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    };
  }
}
