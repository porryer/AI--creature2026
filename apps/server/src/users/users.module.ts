import { Body, Controller, Get, Inject, Module, Patch, UseGuards } from '@nestjs/common';
import { PLANS, type MeDTO, type PlanCode } from '@creature/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { decryptPhone, maskPhone } from '../auth/crypto';
import { AppConfig, CONFIG } from '../config';
import { Errors } from '../common/errors';
import { parse, UserId } from '../common/http';
import { CreditsModule } from '../credits/credits.module';
import { CreditsService } from '../credits/credits.service';
import { Db, DB } from '../db/db';

const PatchBody = z.object({ nickname: z.string().trim().min(1).max(20) }).strict();

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
  imports: [CreditsModule],
  controllers: [MeController],
})
export class UsersModule {}
