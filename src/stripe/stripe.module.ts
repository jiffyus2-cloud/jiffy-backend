import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeController } from './stripe.controller';
import { DiscountsModule } from '../discounts/discounts.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [DiscountsModule, EmailModule],
  providers: [StripeService],
  controllers: [StripeController],
  exports: [StripeService],
})
export class StripeModule {}