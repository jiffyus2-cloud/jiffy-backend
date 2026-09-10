import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeController } from './stripe.controller';
import { DiscountsModule } from '../discounts/discounts.module';

@Module({
  imports: [DiscountsModule],
  providers: [StripeService],
  controllers: [StripeController],
  exports: [StripeService],
})
export class StripeModule {}