import { Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { Errors } from '../common/errors';
import { pageParams, parse, UserId, type AuthedRequest } from '../common/http';
import { CreditsModule } from '../credits/credits.module';
import { CommunityModule } from '../community/community.module';
import { Db, DB } from '../db/db';
import { GatewayModule } from '../gateway/gateway.module';
import { SafetyModule } from '../safety/safety.module';
import { ReconcileService } from '../credits/reconcile.service';
import { newId } from '../common/ids';
import { AdminUsersService, MAX_ADJUST } from './admin-users.service';
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
const UserQuery = z.object({ q: z.string().max(64).optional(), status: z.enum(['active', 'frozen', 'banned']).optional() });
const Reason = z.string().trim().min(2, '请填写原因').max(200);
const StatusBody = z.object({ status: z.enum(['active', 'frozen', 'banned']), reason: Reason }).strict();
const CreditsBody = z
  .object({
    delta: z.number().int().refine((n) => n !== 0, '调整数量不能为 0').refine((n) => Math.abs(n) <= MAX_ADJUST, `单次调整不超过 ${MAX_ADJUST} 积分`),
    reason: Reason,
    request_id: z.string().regex(/^[\w-]{8,64}$/, '缺少有效的 request_id'),
  })
  .strict();

@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly users: AdminUsersService,
    private readonly reconcile: ReconcileService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('reconcile')
  async reconcileRuns() {
    return { data: await this.reconcile.recent(10) };
  }

  /** 立即执行一次全量对账（只读），写审计日志 */
  @Post('reconcile/run')
  @HttpCode(200)
  async runReconcile(@UserId() adminId: string) {
    const run = await this.reconcile.run('manual', adminId);
    await this.db.query('INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6)', [
      newId('aud'),
      adminId,
      'credits.reconcile',
      'reconcile_run',
      run.id,
      JSON.stringify({ accounts: run.accounts, mismatches: run.mismatches, stale_holds: run.stale_holds }),
    ]);
    return run;
  }

  @Get('users')
  listUsers(@Query() query: Record<string, unknown>) {
    const f = parse(UserQuery, { q: query.q, status: query.status });
    return this.users.list({ ...f, ...pageParams(query) });
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.users.detail(id);
  }

  @Post('users/:id/status')
  @HttpCode(200)
  setStatus(@UserId() adminId: string, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(StatusBody, body);
    return this.users.setStatus(adminId, id, b.status, b.reason);
  }

  @Post('users/:id/credits')
  @HttpCode(200)
  adjust(@UserId() adminId: string, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(CreditsBody, body);
    return this.users.adjustCredits(adminId, id, b.delta, b.reason, b.request_id);
  }

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
  imports: [CommunityModule, GatewayModule, SafetyModule, CreditsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminUsersService, AdminGuard],
})
export class AdminModule {}
