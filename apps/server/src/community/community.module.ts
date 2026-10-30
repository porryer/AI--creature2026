import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { parse, UserId } from '../common/http';
import { SafetyModule } from '../safety/safety.module';
import { COMMENT_MAX_LENGTH } from '@creature/shared';
import { CommunityService } from './community.service';
import { SocialService } from './social.service';

const FeedQuery = z.object({
  tab: z.enum(['recommend', 'latest', 'hot', 'mine', 'following']).default('recommend'),
  author: z.string().min(1).max(64).optional(),
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
    target_type: z.enum(['post', 'comment']),
    target_id: z.string().min(1).max(64),
    reason: z.enum(['porn', 'violence', 'politics', 'infringement', 'ad', 'other']),
    detail: z.string().trim().max(200).optional(),
  })
  .strict();
const PageQuery = z.object({ cursor: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const CommentBody = z
  .object({
    body: z.string().trim().min(1, '请输入评论内容').max(COMMENT_MAX_LENGTH, `评论最多 ${COMMENT_MAX_LENGTH} 字`),
    parent_id: z.string().min(1).max(64).optional(),
  })
  .strict();

@Controller()
@UseGuards(AuthGuard)
export class CommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly social: SocialService,
  ) {}

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
    const b = parse(ReportBody, body);
    return b.target_type === 'comment' ? this.social.reportComment(userId, b) : this.community.report(userId, { ...b, target_type: 'post' });
  }

  @Get('posts/:id/comments')
  comments(@UserId() userId: string, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.social.comments(userId, id, parse(PageQuery, query));
  }

  @Post('posts/:id/comments')
  comment(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.social.comment(userId, id, parse(CommentBody, body));
  }

  @Get('comments/:id/replies')
  replies(@UserId() userId: string, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.social.replies(userId, id, parse(PageQuery, query));
  }

  @Delete('comments/:id')
  @HttpCode(204)
  deleteComment(@UserId() userId: string, @Param('id') id: string) {
    return this.social.deleteComment(userId, id);
  }

  /** 创作者主页：资料与统计；作品用 GET /feed?author= */
  @Get('creators/:id')
  creator(@UserId() userId: string, @Param('id') id: string) {
    return this.social.creator(userId, id);
  }

  @Put('creators/:id/follow')
  follow(@UserId() userId: string, @Param('id') id: string) {
    return this.social.setFollow(userId, id, true);
  }

  @Delete('creators/:id/follow')
  unfollow(@UserId() userId: string, @Param('id') id: string) {
    return this.social.setFollow(userId, id, false);
  }
}

@Module({
  imports: [SafetyModule],
  controllers: [CommunityController],
  providers: [CommunityService, SocialService],
  exports: [CommunityService, SocialService],
})
export class CommunityModule {}
