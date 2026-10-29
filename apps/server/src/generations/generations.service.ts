import { Inject, Injectable } from '@nestjs/common';
import {
  composePrompt,
  contextSummary,
  EDIT_MODEL,
  EDIT_TOOLS,
  editLabel,
  estimateCredits,
  findModel,
  normalizeParams,
  PLANS,
  QUEUE_POSITION_CAP,
  TIER_LABEL,
  type ContextSnapshot,
  type GenerationParams,
  type Modality,
  type Operation,
  type PlanCode,
  type ReferenceDTO,
  type ReferenceRole,
  type TaskDTO,
  type TaskStatus,
} from '@creature/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssetsService } from '../assets/assets.service';
import { imageInfo } from '../assets/image-info';
import { Errors } from '../common/errors';
import { newId } from '../common/ids';
import { parse } from '../common/http';
import { CreditsService } from '../credits/credits.service';
import { Db, DB, isUniqueViolation } from '../db/db';
import { EventBus } from '../events/event-bus';
import { ParamsSchema, RoutingSchema } from '../gateway/gateway.module';
import { ModelGateway } from '../gateway/model-gateway.service';
import { LibraryService } from '../library/library.service';
import { ModerationService } from '../safety/moderation.service';
import { StorageService } from '../storage/storage.service';
import { AppConfig, CONFIG } from '../config';

/** 涂抹区域（PNG data URL）的长度上限，约 730 KB 的图片 */
const MAX_MASK_CHARS = 1_000_000;
/** 超分后的最大边长 */
const MAX_UPSCALED_SIDE = 8192;

export const CreateSchema = z.object({
  modality: z.enum(['image', 'video', 'text', 'audio']),
  operation: z.enum(['generate', 'edit']).default('generate'),
  // 图像编辑中只有局部重绘必须填写描述，其余创作的必填校验在 create() 中完成
  prompt: z.string().trim().max(4000).default(''),
  params: ParamsSchema.default({}),
  routing: RoutingSchema,
  source: z.enum(['studio', 'canvas', 'agent', 'template']).default('studio'),
  references: z
    .array(z.object({ asset_id: z.string().max(64), role: z.enum(['style', 'subject', 'character', 'first_frame', 'last_frame', 'source']) }).strict())
    .max(4, '最多引用 4 张参考图')
    .default([]),
  /** 局部重绘 / 消除的涂抹区域：PNG data URL，白色为要修改的部分 */
  mask: z.string().max(MAX_MASK_CHARS, '涂抹区域图片过大').optional(),
  /** 引用角色库与品牌套件（docs/02-prd.md 4.7） */
  context: z
    .object({
      character_ids: z.array(z.string().min(1).max(64)).max(4).optional(),
      brand_kit_id: z.string().min(1).max(64).nullable().optional(),
      place_logo: z.boolean().optional(),
    })
    .strict()
    .optional(),
});
type CreateBody = z.infer<typeof CreateSchema>;

/** 各模态允许的参考图用途 */
const REF_ROLES: Record<Modality, ReferenceRole[]> = { image: ['style', 'subject', 'character'], video: ['first_frame', 'last_frame'], text: [], audio: [] };

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
  input_refs: ReferenceDTO[];
  mask_key: string | null;
  context: ContextSnapshot | null;
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
  if (p.tool) return `图像编辑 · ${editLabel(p)}`;
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
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly gateway: ModelGateway,
    private readonly credits: CreditsService,
    private readonly moderation: ModerationService,
    private readonly assets: AssetsService,
    private readonly bus: EventBus,
    private readonly storage: StorageService,
    private readonly library: LibraryService,
  ) {
    // 其他实例广播任务事件时，本实例据此读取任务推送给自己的连接
    bus.setTaskLoader(async (userId, taskId) => {
      const r = await this.row(userId, taskId);
      return r ? this.toDTO(r) : null;
    });
  }

  async create(userId: string, rawBody: unknown, idemKey: string | undefined): Promise<{ task: TaskDTO; replay: boolean }> {
    if (!idemKey || !/^[\w-]{8,100}$/.test(idemKey)) throw Errors.invalid('请求头缺少有效的 Idempotency-Key（8–100 位字母、数字、- 或 _）');
    const body = parse(CreateSchema, rawBody);
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');

    const existing = await this.byIdemKey(userId, idemKey);
    if (existing) {
      if (existing.request_hash !== requestHash) throw Errors.idempotencyConflict();
      return { task: await this.toDTO(existing), replay: true };
    }

    await this.checkRate(userId);

    const imageEdit = body.modality === 'image' && body.operation === 'edit';
    const edit = imageEdit ? await this.checkEdit(userId, body) : null;
    if (!edit) {
      if (!body.prompt) throw Errors.invalid('请输入提示词');
      if (body.mask || body.params.tool || body.params.scale) throw Errors.invalid('tool、scale 与 mask 只用于图像编辑（modality = image，operation = edit）');
    }
    const prompt = edit ? edit.prompt : body.prompt;
    if (edit && (body.context?.character_ids?.length || body.context?.brand_kit_id || body.context?.place_logo)) throw Errors.invalid('图像编辑不支持引用角色或品牌套件');
    // 角色与品牌套件：校验并生成快照（失败不冻结积分）
    const context = edit ? null : await this.library.snapshot(userId, body.modality, body.context);

    // 输入审核（含注入的角色设定与品牌规范）：不通过直接拒绝，不冻结积分
    const verdict = this.moderation.checkText(composePrompt(prompt, body.modality, context));
    if (verdict.verdict === 'block') {
      await this.moderation.record({ userId, targetType: 'prompt', targetId: null, result: verdict });
      throw Errors.contentRejected(verdict.labels[0] ?? 'policy');
    }

    if (!edit) await this.checkReferences(userId, body.modality, body.references);

    // 图像编辑固定由编辑模型处理；其余按手动指定或智能路由
    let routed: { model: NonNullable<ReturnType<typeof findModel>>; reason: string } | null;
    let strategy: string = body.routing.strategy;
    if (edit) {
      if (body.routing.pinned_model && body.routing.pinned_model !== EDIT_MODEL) throw Errors.invalid('图像编辑只能使用图像编辑模型');
      const m = findModel(EDIT_MODEL)!;
      if (!this.gateway.configured(EDIT_MODEL)) throw Errors.modelUnavailable();
      routed = { model: m, reason: `${editLabel(body.params)}由 ${m.name} 处理` };
      strategy = 'pinned';
    } else {
      const pinned = body.routing.pinned_model ? this.gateway.resolvePinned(body.routing.pinned_model, body.modality) : null;
      if (body.routing.pinned_model && !pinned) throw Errors.invalid('所选模型不可用或与创作类型不匹配');
      if (pinned) strategy = 'pinned';
      routed = pinned ? { model: pinned, reason: `已手动指定 ${pinned.name}` } : this.gateway.route(body.modality, prompt, body.routing.strategy);
    }
    if (!routed) throw Errors.modelUnavailable();
    const model = routed.model;
    const params = normalizeParams(model, body.params as GenerationParams);
    const estimate = estimateCredits(model, params);

    const [user] = await this.db.query<{ plan_code: PlanCode; plan_expires_at: Date | null }>('SELECT plan_code, plan_expires_at FROM users WHERE id = $1', [userId]);
    const planActive = user && (!user.plan_expires_at || new Date(user.plan_expires_at).getTime() > Date.now());
    const queue = PLANS[planActive ? user.plan_code : 'free']?.queue ?? 'p2';
    const accountId = await this.credits.accountIdFor(userId);
    const id = newId('tsk');
    let maskKey: string | null = null;
    if (edit?.mask) {
      maskKey = StorageService.keyFor('private', userId, `${id}-mask`, 'image/png');
      await this.storage.put(maskKey, edit.mask);
    }

    try {
      await this.db.tx(async (q) => {
        // 先冻结（对积分账户加 FOR UPDATE 锁），再插入任务：插入时的外键检查会对账户加 KEY SHARE 锁，
        // 顺序反过来会在并发提交时互相等待锁升级而死锁
        await this.credits.freeze(q, accountId, estimate, id, `冻结 · ${ledgerMemo({ modality: body.modality, params }, model.name)}`);
        await q.query(
          `INSERT INTO generation_tasks (id, user_id, account_id, modality, operation, model_code, routing_strategy, routing_reason, prompt, params,
             status, queue, estimated_credits, idempotency_key, request_hash, source, input_refs, mask_key, context)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            id,
            userId,
            accountId,
            body.modality,
            body.operation,
            model.code,
            strategy,
            routed.reason,
            prompt,
            JSON.stringify(params),
            queue,
            estimate,
            idemKey,
            requestHash,
            body.source,
            JSON.stringify(body.references),
            maskKey,
            context ? JSON.stringify(context) : null,
          ],
        );
        if (context) await this.library.markUsed(q, context);
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

  /**
   * 防刷：近 1 分钟创建的任务数与同时进行中的任务数（按数据库计数，多实例共享；重放与被拒绝的提交不计入）。
   * 先查后插，并发提交时可能略超上限，属于软限制。
   */
  private async checkRate(userId: string) {
    const [r] = await this.db.query<{ inflight: number; recent: number; wait: number | null }>(
      `SELECT COUNT(*) FILTER (WHERE status IN ('queued', 'running', 'post_processing'))::int AS inflight,
              COUNT(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS recent,
              EXTRACT(EPOCH FROM MIN(created_at) FILTER (WHERE created_at > now() - interval '1 minute') + interval '1 minute' - now())::float AS wait
         FROM generation_tasks
        WHERE user_id = $1 AND (status IN ('queued', 'running', 'post_processing') OR created_at > now() - interval '1 minute')`,
      [userId],
    );
    if (r.recent >= this.config.generationRatePerMin) {
      const wait = Math.max(1, Math.ceil(r.wait ?? 60));
      throw Errors.rateLimited(`提交太频繁，请 ${wait} 秒后再试`, wait);
    }
    if (r.inflight >= this.config.maxInflightTasks) throw Errors.rateLimited(`进行中的任务已有 ${r.inflight} 个，请等部分完成后再提交`, 10);
  }

  /**
   * 图像编辑校验：一张本人的源图；局部重绘 / 消除需要 PNG 涂抹区域，局部重绘还要描述；
   * 扩图需要与原图不同的比例；超分后的边长不超过 8192。返回任务提示词与解码后的遮罩。
   */
  private async checkEdit(userId: string, body: CreateBody): Promise<{ prompt: string; mask?: Buffer }> {
    const tool = body.params.tool;
    if (!tool) throw Errors.invalid('请选择编辑工具（params.tool）');
    const spec = EDIT_TOOLS[tool];
    const source = body.references.find((r) => r.role === 'source');
    if (!source || body.references.length !== 1) throw Errors.invalid('图像编辑需要且只能指定一张源图（role = source）');
    const [src] = await this.db.query<{ title: string; width: number | null; height: number | null }>(
      `SELECT title, width, height FROM assets WHERE id = $1 AND user_id = $2 AND kind = 'image' AND deleted_at IS NULL`,
      [source.asset_id, userId],
    );
    if (!src) throw Errors.invalid('源图不存在或不是图像');
    if (spec.needsPrompt && !body.prompt) throw Errors.invalid('请描述要把涂抹区域改成什么');

    let mask: Buffer | undefined;
    if (spec.needsMask) {
      const m = body.mask ? /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.mask) : null;
      if (!body.mask) throw Errors.invalid('请先涂抹要修改的区域');
      mask = m ? Buffer.from(m[1], 'base64') : undefined;
      if (!mask || imageInfo(mask)?.mime !== 'image/png') throw Errors.invalid('涂抹区域必须是 PNG 图片');
    } else if (body.mask) {
      throw Errors.invalid(`${spec.label}不需要涂抹区域`);
    }
    if (tool === 'outpaint') {
      const ratio = body.params.ratio;
      if (!ratio) throw Errors.invalid('请选择扩图后的比例');
      const [a, b] = ratio.split(':').map(Number);
      if (src.width && src.height && Math.abs(a / b - src.width / src.height) / (src.width / src.height) < 0.03) throw Errors.invalid('扩图比例与原图相同，请选择其他比例');
    }
    if (tool === 'upscale' && Math.max(src.width ?? 0, src.height ?? 0) * (body.params.scale ?? 2) > MAX_UPSCALED_SIDE) {
      throw Errors.invalid(`超分后边长会超过 ${MAX_UPSCALED_SIDE} 像素，请选择较小的倍数`);
    }
    return { prompt: body.prompt || `${editLabel(body.params)} · ${src.title}`, mask };
  }

  /** 参考图只能是本人未删除的图像，且用途要与创作类型匹配（首帧、尾帧各至多一张） */
  private async checkReferences(userId: string, modality: Modality, refs: ReferenceDTO[]) {
    if (!refs.length) return;
    const bad = refs.find((r) => !REF_ROLES[modality].includes(r.role));
    if (bad) throw Errors.invalid(`${modality === 'video' ? '视频' : modality === 'image' ? '图像' : '该类型'}创作不支持「${bad.role}」用途的参考图`);
    for (const role of ['first_frame', 'last_frame'] as const) {
      if (refs.filter((r) => r.role === role).length > 1) throw Errors.invalid(`${role === 'first_frame' ? '首帧' : '尾帧'}只能指定一张`);
    }
    const ids = [...new Set(refs.map((r) => r.asset_id))];
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM assets WHERE id = ANY($1::text[]) AND user_id = $2 AND kind = 'image' AND deleted_at IS NULL`, [ids, userId]);
    if (rows.length !== ids.length) throw Errors.invalid('参考图不存在或不是图像');
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
      // 每个模态有独立的 Worker 槽位，只数同一模态排在前面的任务；计数设上限，积压很大时耗时不随之增长
      const [p] = await this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT 1 FROM generation_tasks WHERE status = 'queued' AND modality = $1 AND (queue < $2 OR (queue = $2 AND created_at < $3)) LIMIT $4
         ) ahead`,
        [r.modality, r.queue, r.created_at, QUEUE_POSITION_CAP],
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
      references: r.input_refs ?? [],
      context: contextSummary(r.context),
      error: r.error_code ? { code: r.error_code, message: r.error_message ?? '' } : null,
      source: r.source as TaskDTO['source'],
      created_at: new Date(r.created_at).toISOString(),
      finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    };
  }
}
