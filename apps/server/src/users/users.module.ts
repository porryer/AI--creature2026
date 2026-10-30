import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Module, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { PLANS, type DeletionRequestDTO, type MeDTO, type PlanCode } from '@creature/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AssetsModule } from '../assets/assets.module';
import { AuthGuard } from '../auth/auth.guard';
import { AuthModule } from '../auth/auth.module';
import { decryptPhone, maskPhone } from '../auth/crypto';
import { AppConfig, CONFIG } from '../config';
import { Errors } from '../common/errors';
import { parse, UserId } from '../common/http';
import { CreditsModule } from '../credits/credits.module';
import { CreditsService } from '../credits/credits.service';
import { Db, DB } from '../db/db';
import { AccountService } from './account.service';

const PatchBody = z.object({ nickname: z.string().trim().min(1).max(20) }).strict();
const DeleteBody = z.object({ code: z.string().regex(/^\d{6}$/, '请输入 6 位验证码') }).strict();

interface UserRow {
  id: string;
  nickname: string;
  phone_enc: string;
  plan_code: PlanCode;
  plan_expires_at: Date | null;
  role: 'user' | 'admin';
}

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly credits: CreditsService,
    private readonly account: AccountService,
  ) {}

  /** 当前用户；每天首次访问时发放当日赠送积分 */
  @Get()
  async me(@UserId() userId: string): Promise<MeDTO> {
    await this.credits.ensureDailyGrant(userId);
    return this.dto(userId);
  }

  @Patch()
  async update(@UserId() userId: string, @Body() body: unknown): Promise<MeDTO> {
    const { nickname } = parse(PatchBody, body);
    await this.db.query('UPDATE users SET nickname = $2, updated_at = now() WHERE id = $1', [userId, nickname]);
    return this.dto(userId);
  }

  /** 注销确认：向账号绑定的手机号发送验证码 */
  @Post('deletion/code')
  @HttpCode(200)
  deletionCode(@UserId() userId: string) {
    return this.account.sendDeletionCode(userId);
  }

  /** 申请注销：进入 15 天冷静期，所有会话立即失效；期间重新登录即撤销 */
  @Delete()
  @HttpCode(200)
  async remove(@UserId() userId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<DeletionRequestDTO> {
    const r = await this.account.requestDeletion(userId, parse(DeleteBody, body).code);
    res.clearCookie('crt_rt', { path: '/v1/auth' });
    return r;
  }

  /** 导出个人信息副本（JSON 附件） */
  @Get('export')
  @Header('cache-control', 'no-store')
  async export(@UserId() userId: string, @Res({ passthrough: true }) res: Response) {
    const data = await this.account.export(userId);
    res.setHeader('content-disposition', `attachment; filename="creature-personal-data-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  }

  private async dto(userId: string): Promise<MeDTO> {
    const [u] = await this.db.query<UserRow>('SELECT id, nickname, phone_enc, plan_code, plan_expires_at, role FROM users WHERE id = $1', [userId]);
    if (!u) throw Errors.unauthenticated();
    const plan = PLANS[u.plan_code] ?? PLANS.free;
    return {
      id: u.id,
      nickname: u.nickname,
      phone_masked: maskPhone(decryptPhone(u.phone_enc, this.config.phoneEncKey)),
      plan: { code: plan.code, name: plan.name, expires_at: u.plan_expires_at ? new Date(u.plan_expires_at).toISOString() : null },
      credits: await this.credits.balanceForUser(userId),
      role: u.role,
    };
  }
}

@Module({
  imports: [CreditsModule, AuthModule, AssetsModule],
  controllers: [MeController],
  providers: [AccountService],
  exports: [AccountService],
})
export class UsersModule {}
