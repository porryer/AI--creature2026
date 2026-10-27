import { Body, Controller, Get, HttpCode, Module, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { parse, UserId } from '../common/http';
import { CreditsModule } from '../credits/credits.module';
import { BillingService } from './billing.service';

const OrderBody = z.discriminatedUnion('item_type', [
  z.object({ item_type: z.literal('subscription'), item_ref: z.enum(['basic', 'pro', 'team']), cycle: z.enum(['month', 'year']) }),
  z.object({ item_type: z.literal('credit_pack'), item_ref: z.enum(['100', '500', '2000']) }),
]);

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  create(@UserId() userId: string, @Body() body: unknown) {
    const b = parse(OrderBody, body);
    return this.billing.createOrder(userId, b.item_type, b.item_ref, b.item_type === 'subscription' ? b.cycle : null);
  }

  @Get(':id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.billing.getOrder(userId, id);
  }

  /** 模拟支付成功：仅 PAYMENTS_MODE=mock 时可用 */
  @Post(':id/mock-pay')
  @HttpCode(200)
  mockPay(@UserId() userId: string, @Param('id') id: string) {
    return this.billing.mockPay(userId, id);
  }
}

@Module({
  imports: [CreditsModule],
  controllers: [OrdersController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
