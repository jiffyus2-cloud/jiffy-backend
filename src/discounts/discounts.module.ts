import { Module } from '@nestjs/common';
import { DiscountsService } from './discounts.service';
import { DiscountsController } from './discounts.controller';

@Module({
  providers: [DiscountsService],
  controllers: [DiscountsController],
  // StripeModule lo necesita para contar el canje cuando el pago se confirma.
  exports: [DiscountsService],
})
export class DiscountsModule {}
