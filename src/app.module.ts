import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { StripeModule } from './stripe/stripe.module';
import { AiModule } from './ai/ai.module'; // <-- 1. Importamos el nuevo módulo de IA

@Module({
  imports: [
    StripeModule, 
    AiModule // <-- 2. Lo registramos en la aplicación
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}