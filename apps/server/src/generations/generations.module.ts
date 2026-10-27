import { Body, Controller, Get, Headers, HttpCode, MessageEvent, Module, Param, Post, Query, Res, Sse, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { interval, map, merge, Observable } from 'rxjs';
import { z } from 'zod';
import { AssetsModule } from '../assets/assets.module';
import { AllowQueryToken, AuthGuard } from '../auth/auth.guard';
import { pageParams, parse, UserId } from '../common/http';
import { CreditsModule } from '../credits/credits.module';
import { EventBus } from '../events/event-bus';
import { GatewayModule } from '../gateway/gateway.module';
import { SafetyModule } from '../safety/safety.module';
import { GenerationsService } from './generations.service';
import { GenerationWorker } from './worker.service';

const ListQuery = z.object({ modality: z.enum(['image', 'video', 'text', 'audio']).optional() });

@Controller('generations')
@UseGuards(AuthGuard)
export class GenerationsController {
  constructor(private readonly generations: GenerationsService) {}

  /** 创建任务：首次提交返回 202，相同 Idempotency-Key 的重放返回 200 */
  @Post()
  async create(@UserId() userId: string, @Body() body: unknown, @Headers('idempotency-key') idem: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { task, replay } = await this.generations.create(userId, body, idem);
    res.status(replay ? 200 : 202);
    return task;
  }

  @Get()
  list(@UserId() userId: string, @Query() query: Record<string, unknown>) {
    return this.generations.list(userId, { ...parse(ListQuery, { modality: query.modality }), ...pageParams(query) });
  }

  @Get(':id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.generations.get(userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@UserId() userId: string, @Param('id') id: string) {
    return this.generations.cancel(userId, id);
  }
}

/** 服务端推送：任务进度与积分变化（EventSource 通过 ?access_token= 认证） */
@Controller('events')
export class EventsController {
  constructor(private readonly bus: EventBus) {}

  @Sse()
  @UseGuards(AuthGuard)
  @AllowQueryToken()
  stream(@UserId() userId: string): Observable<MessageEvent> {
    return merge(
      this.bus.stream(userId).pipe(map((e) => ({ data: e }) as MessageEvent)),
      interval(25_000).pipe(map(() => ({ type: 'ping', data: '' }) as MessageEvent)),
    );
  }
}

@Module({
  imports: [CreditsModule, GatewayModule, AssetsModule, SafetyModule],
  controllers: [GenerationsController, EventsController],
  providers: [GenerationsService, GenerationWorker],
  exports: [GenerationWorker],
})
export class GenerationsModule {}
