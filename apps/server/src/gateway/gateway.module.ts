import { Body, Controller, Get, Module, Post, Query, UseGuards } from '@nestjs/common';
import { estimateCredits, normalizeParams, type GenerationParams } from '@creature/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AppConfig, CONFIG } from '../config';
import { Errors } from '../common/errors';
import { parse } from '../common/http';
import { MockProvider } from './mock.provider';
import { ModelGateway } from './model-gateway.service';
import { PROVIDER_ADAPTERS, ProviderAdapter } from './provider';

const Modality = z.enum(['image', 'video', 'text', 'audio']);
export const ParamsSchema = z
  .object({
    ratio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(),
    resolution: z.enum(['1k', '2k', '4k', '720p', '1080p']).optional(),
    count: z.number().int().min(1).max(12).optional(),
    duration: z.number().int().min(1).max(60).optional(),
    audio: z.boolean().optional(),
    camera: z.string().max(20).optional(),
    chars: z.number().int().min(1).max(20000).optional(),
    voice: z.string().max(20).optional(),
    seconds: z.number().int().min(1).max(120).optional(),
    template: z.enum(['xhs', 'script', 'ad', 'article', 'storyboard']).optional(),
    tone: z.string().max(10).optional(),
    transform: z.enum(['改写', '扩写', '缩写', '换语气']).optional(),
  })
  .strict();
export const RoutingSchema = z.object({ strategy: z.enum(['auto', 'cheap', 'best']).default('auto'), pinned_model: z.string().nullish() }).default({ strategy: 'auto' });
const RouteBody = z.object({ modality: Modality, prompt: z.string().max(4000).default(''), params: ParamsSchema.default({}), routing: RoutingSchema });

@Controller('models')
export class ModelsController {
  constructor(private readonly gateway: ModelGateway) {}

  /** 当前可用模型（已配置适配器且未熔断） */
  @Get()
  list(@Query('modality') modality?: string) {
    const m = modality ? parse(Modality, modality) : undefined;
    return { data: this.gateway.available(m) };
  }

  /** 路由预览：返回推荐模型、理由与积分预估，不创建任务 */
  @Post('route')
  @UseGuards(AuthGuard)
  route(@Body() body: unknown) {
    const b = parse(RouteBody, body);
    const pinned = b.routing.pinned_model ? this.gateway.resolvePinned(b.routing.pinned_model, b.modality) : null;
    if (b.routing.pinned_model && !pinned) throw Errors.invalid('所选模型不可用');
    const r = pinned ? { model: pinned, reason: `已手动指定 ${pinned.name}` } : this.gateway.route(b.modality, b.prompt, b.routing.strategy);
    if (!r) throw Errors.modelUnavailable();
    const params = normalizeParams(r.model, b.params as GenerationParams);
    return { model: r.model, reason: r.reason, params, estimated_credits: estimateCredits(r.model, params) };
  }
}

@Module({
  controllers: [ModelsController],
  providers: [
    ModelGateway,
    {
      provide: PROVIDER_ADAPTERS,
      inject: [CONFIG],
      // live 模式下在这里注册各供应商适配器（火山方舟、可灵、百炼……），未注册的模型会被自动停用
      useFactory: (config: AppConfig): ProviderAdapter[] => (config.providerMode === 'mock' ? [new MockProvider(config.mockLatencyMs)] : []),
    },
  ],
  exports: [ModelGateway],
})
export class GatewayModule {}
