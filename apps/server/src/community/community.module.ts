import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { parse, UserId } from '../common/http';
import { SafetyModule } from '../safety/safety.module';
import { CommunityService } from './community.service';

const FeedQuery = z.object({
  tab: z.enum(['recommend', 'latest', 'hot', 'mine']).default('recommend'),
  kind: z.enum(['image', 'video']).optional(),
  cursor: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(30).default(20),
});
const PublishBody = z
  .object({
    asset_id: z.string().min(1).max(64),
    title: z.string().trim().min(1, '请输入标题').max(40),
    tags: z.array(z.string().trim().min(1).max(12)).max(5).default([]),
    show_prompt: z.boolean().default(true),
  })
  .strict();
const ReportBody = z
  .object({
    target_type: z.literal('post'),
    target_id: z.string().min(1).max(64),
    reason: z.enum(['porn', 'violence', 'politics', 'infringement', 'ad', 'other']),
    detail: z.string().trim().max(200).optional(),
  })
  .strict();

@Controller()
@UseGuards(AuthGuard)
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('feed')
  feed(@UserId() userId: string, @Query() query: Record<string, unknown>) {
    return this.community.feed(userId, parse(FeedQuery, query));
  }

  @Post('posts')
  publish(@UserId() userId: string, @Body() body: unknown) {
    return this.community.publish(userId, parse(PublishBody, body));
  }

  @Get('posts/:id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.community.get(userId, id);
  }

  @Delete('posts/:id')
  @HttpCode(204)
  withdraw(@UserId() userId: string, @Param('id') id: string) {
    return this.community.withdraw(userId, id);
  }

  @Put('posts/:id/like')
  like(@UserId() userId: string, @Param('id') id: string) {
    return this.community.setLike(userId, id, true);
  }

  @Delete('posts/:id/like')
  unlike(@UserId() userId: string, @Param('id') id: string) {
    return this.community.setLike(userId, id, false);
  }

  @Post('posts/:id/remix')
  @HttpCode(200)
  remix(@UserId() userId: string, @Param('id') id: string) {
    return this.community.remix(userId, id);
  }

  @Post('reports')
  report(@UserId() userId: string, @Body() body: unknown) {
    return this.community.report(userId, parse(ReportBody, body));
  }
}

@Module({
  imports: [SafetyModule],
  controllers: [CommunityController],
  providers: [CommunityService],
  exports: [CommunityService],
})
export class CommunityModule {}
