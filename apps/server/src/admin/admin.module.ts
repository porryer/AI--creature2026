import { Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Module, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { Errors } from '../common/errors';
import { parse, UserId, type AuthedRequest } from '../common/http';
import { CommunityModule } from '../community/community.module';
import { Db, DB } from '../db/db';
import { GatewayModule } from '../gateway/gateway.module';
import { SafetyModule } from '../safety/safety.module';
import { AdminService } from './admin.service';

/** 管理后台权限：需在 AuthGuard 之后使用；每次请求查库，撤销权限立即生效 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw Errors.unauthenticated();
    const [u] = await this.db.query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1', [req.user.id]);
    if (u?.role !== 'admin' || u.status !== 'active') throw Errors.forbidden('需要管理员权限');
    return true;
  }
}

const DecisionBody = z.object({ action: z.enum(['approve', 'remove']), note: z.string().trim().max(200).optional() }).strict();

@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('models')
  models() {
    return this.admin.models();
  }

  @Get('review-queue')
  queue(@UserId() userId: string) {
    return this.admin.reviewQueue(userId);
  }

  @Post('posts/:id/decision')
  @HttpCode(200)
  decide(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(DecisionBody, body);
    return this.admin.decide(userId, id, b.action, b.note);
  }
}

@Module({
  imports: [CommunityModule, GatewayModule, SafetyModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
