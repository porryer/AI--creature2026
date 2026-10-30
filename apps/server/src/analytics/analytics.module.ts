import { Body, Controller, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import type { ClientEvent } from '@creature/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { parse, UserId } from '../common/http';
import { AnalyticsService } from './analytics.service';

const count = z.number().int().min(0).max(100_000);
// 客户端只能上报白名单中的界面行为，属性逐个校验（未知字段拒绝）
const ClientEventSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('page_view'), props: z.object({ page: z.string().min(1).max(32) }).strict() }).strict(),
  z.object({ name: z.literal('paywall_shown'), props: z.object({ trigger: z.enum(['library', 'insufficient_credits', 'pricing']) }).strict() }).strict(),
  z.object({ name: z.literal('agent_plan_shown'), props: z.object({ step_count: count, estimated_credits: count }).strict() }).strict(),
  z.object({ name: z.literal('agent_plan_confirmed'), props: z.object({ step_count: count, estimated_credits: count, edited_steps: count }).strict() }).strict(),
  z
    .object({
      name: z.literal('asset_export'),
      props: z.object({ channel: z.enum(['copy', 'share']), asset_type: z.enum(['image', 'video', 'text', 'audio']), asset_id: z.string().min(1).max(64).optional() }).strict(),
    })
    .strict(),
]);
const TrackBody = z.object({ events: z.array(ClientEventSchema).min(1).max(20) }).strict();

@Controller('analytics')
@UseGuards(AuthGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** 客户端批量上报界面行为（每次最多 20 条） */
  @Post('events')
  @HttpCode(202)
  async track(@UserId() userId: string, @Body() body: unknown) {
    const { events } = parse(TrackBody, body);
    return { accepted: await this.analytics.trackClient(userId, events as ClientEvent[]) };
  }
}

/** AnalyticsService 由 CoreModule 全局提供；这里只注册客户端上报接口 */
@Module({ controllers: [AnalyticsController] })
export class AnalyticsModule {}
