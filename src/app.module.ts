import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { StripeModule } from './stripe/stripe.module';

@Module({
  imports: [StripeModule],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
