import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { pageParams, UserId } from '../common/http';
import { AuthGuard } from '../auth/auth.guard';
import { CreditsService } from './credits.service';

@Controller('credits')
@UseGuards(AuthGuard)
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Get('balance')
  balance(@UserId() userId: string) {
    return this.credits.balanceForUser(userId);
  }

  @Get('ledger')
  async ledger(@UserId() userId: string, @Query() query: Record<string, unknown>) {
    const { cursor, limit } = pageParams(query);
    return this.credits.ledger(await this.credits.accountIdFor(userId), cursor, limit);
  }
}

@Module({
  controllers: [CreditsController],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
