import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import {
  checkTemplateInputs,
  findTemplate,
  renderTemplate,
  TEMPLATE_CATALOG,
  templateCredits,
  templateParams,
  type TaskDTO,
  type TemplateDef,
  type TemplateDTO,
} from '@creature/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuthGuard } from '../auth/auth.guard';
import { Errors } from '../common/errors';
import { parse, UserId } from '../common/http';
import { Db, DB } from '../db/db';
import { GenerationsModule } from '../generations/generations.module';
import { GenerationsService } from '../generations/generations.service';

const ListQuery = z.object({ category: z.string().max(10).optional(), kind: z.enum(['single', 'workflow']).optional() });
const GenerateBody = z
  .object({
    /** 文字输入：{ key: 值 } */
    values: z.record(z.string(), z.string().max(400)).default({}),
    /** 图片输入：{ key: 资产 ID } */
    images: z.record(z.string(), z.string().min(1).max(64)).default({}),
  })
  .strict();
const RatingBody = z.object({ score: z.number().int().min(1).max(5) }).strict();

interface StatsRow {
  template_id: string;
  use_count: number;
  rating_sum: number;
  rating_count: number;
}

/**
 * 官方模板（docs/02-prd.md 4.8）：目录随代码发布（packages/shared），这里负责统计与"用模板生成"。
 * 单步模板渲染提示词后走普通的生成链路（审核、计价、冻结积分都一样），任务标记 source = template。
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly generations: GenerationsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async list(userId: string, f: { category?: string; kind?: 'single' | 'workflow' }): Promise<{ data: TemplateDTO[] }> {
    const defs = TEMPLATE_CATALOG.filter((t) => (!f.category || f.category === '全部' || t.category === f.category) && (!f.kind || t.kind === f.kind));
    return { data: await this.withStats(userId, defs) };
  }

  async get(userId: string, id: string): Promise<TemplateDTO> {
    const [dto] = await this.withStats(userId, [this.def(id)]);
    return dto;
  }

  /** 单步模板：按输入渲染提示词并创建生成任务；相同 Idempotency-Key 的重放不重复计数 */
  async generate(userId: string, id: string, b: { values: Record<string, string>; images: Record<string, string> }, idemKey: string | undefined): Promise<{ task: TaskDTO; replay: boolean }> {
    const t = this.def(id);
    if (t.kind !== 'single') throw Errors.invalid('工作流模板请在画布中使用');
    const imageKeys = Object.keys(b.images).filter((k) => t.inputs.some((i) => i.key === k && i.type === 'image'));
    const problem = checkTemplateInputs(t, b.values, imageKeys);
    if (problem) throw Errors.invalid(problem);
    const prompt = renderTemplate(t, b.values);
    const references = t.inputs.flatMap((i) => (i.type === 'image' && b.images[i.key] ? [{ asset_id: b.images[i.key], role: i.role! }] : []));
    const result = await this.generations.create(
      userId,
      {
        modality: t.modality,
        prompt,
        params: templateParams(t, prompt),
        routing: t.model ? { strategy: 'auto', pinned_model: t.model } : { strategy: t.strategy ?? 'auto' },
        source: 'template',
        references,
      },
      idemKey,
      { templateId: t.id },
    );
    if (!result.replay) await this.recordUse(userId, t, result.task.id);
    return result;
  }

  /** 工作流模板：在画布中展开（由前端生成节点），这里只记录使用 */
  async use(userId: string, id: string): Promise<TemplateDTO> {
    const t = this.def(id);
    if (t.kind !== 'workflow') throw Errors.invalid('单步模板请直接填写内容生成');
    await this.recordUse(userId, t, null);
    return this.get(userId, id);
  }

  /** 评分 1–5：用过的模板才能评，重复评分覆盖之前的分数 */
  async rate(userId: string, id: string, score: number): Promise<TemplateDTO> {
    this.def(id);
    await this.db.tx(async (q) => {
      const used = await q.query('SELECT 1 FROM template_uses WHERE user_id = $1 AND template_id = $2', [userId, id]);
      if (!used.length) throw Errors.forbidden('使用过这个模板后才能评分');
      const [old] = await q.query<{ score: number }>('SELECT score FROM template_ratings WHERE user_id = $1 AND template_id = $2 FOR UPDATE', [userId, id]);
      await q.query(
        `INSERT INTO template_ratings (user_id, template_id, score) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, template_id) DO UPDATE SET score = EXCLUDED.score, updated_at = now()`,
        [userId, id, score],
      );
      await q.query(
        `INSERT INTO template_stats (template_id, rating_sum, rating_count) VALUES ($1, $2, $3)
         ON CONFLICT (template_id) DO UPDATE SET rating_sum = template_stats.rating_sum + $2, rating_count = template_stats.rating_count + $3`,
        [id, score - (old?.score ?? 0), old ? 0 : 1],
      );
    });
    return this.get(userId, id);
  }

  private async recordUse(userId: string, t: TemplateDef, taskId: string | null) {
    await this.db.tx(async (q) => {
      await q.query(`INSERT INTO template_stats (template_id, use_count) VALUES ($1, 1) ON CONFLICT (template_id) DO UPDATE SET use_count = template_stats.use_count + 1`, [t.id]);
      await q.query(
        `INSERT INTO template_uses (user_id, template_id) VALUES ($1, $2) ON CONFLICT (user_id, template_id) DO UPDATE SET use_count = template_uses.use_count + 1`,
        [userId, t.id],
      );
    });
    await this.analytics.track(userId, 'template_use', { template_id: t.id, kind: t.kind, task_id: taskId });
  }

  private def(id: string): TemplateDef {
    const t = findTemplate(id);
    if (!t) throw Errors.notFound('模板');
    return t;
  }

  private async withStats(userId: string, defs: TemplateDef[]): Promise<TemplateDTO[]> {
    const ids = defs.map((d) => d.id);
    const [stats, mine, used] = await Promise.all([
      this.db.query<StatsRow>('SELECT * FROM template_stats WHERE template_id = ANY($1::text[])', [ids]),
      this.db.query<{ template_id: string; score: number }>('SELECT template_id, score FROM template_ratings WHERE user_id = $1 AND template_id = ANY($2::text[])', [userId, ids]),
      this.db.query<{ template_id: string }>('SELECT template_id FROM template_uses WHERE user_id = $1 AND template_id = ANY($2::text[])', [userId, ids]),
    ]);
    return defs.map((d) => {
      const s = stats.find((x) => x.template_id === d.id);
      return {
        ...d,
        uses: s?.use_count ?? 0,
        rating: { avg: s?.rating_count ? Math.round((s.rating_sum / s.rating_count) * 10) / 10 : null, count: s?.rating_count ?? 0 },
        my_rating: mine.find((x) => x.template_id === d.id)?.score ?? null,
        used_by_me: used.some((x) => x.template_id === d.id),
        estimated_credits: templateCredits(d),
      };
    });
  }
}

@Controller('templates')
@UseGuards(AuthGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@UserId() userId: string, @Query() query: Record<string, unknown>) {
    return this.templates.list(userId, parse(ListQuery, { category: query.category, kind: query.kind }));
  }

  @Get(':id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.templates.get(userId, id);
  }

  /** 用单步模板生成：首次提交返回 202，相同 Idempotency-Key 的重放返回 200 */
  @Post(':id/generate')
  async generate(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') idem: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { task, replay } = await this.templates.generate(userId, id, parse(GenerateBody, body), idem);
    res.status(replay ? 200 : 202);
    return task;
  }

  @Post(':id/use')
  @HttpCode(200)
  use(@UserId() userId: string, @Param('id') id: string) {
    return this.templates.use(userId, id);
  }

  @Put(':id/rating')
  rate(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.templates.rate(userId, id, parse(RatingBody, body).score);
  }
}

@Module({
  imports: [GenerationsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
})
export class TemplatesModule {}
