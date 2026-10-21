import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { StripeModule } from './stripe/stripe.module';
import { AiModule } from './ai/ai.module'; // <-- 1. Importamos el nuevo módulo de IA
import { DiscountsModule } from './discounts/discounts.module';
import { OneclicModule } from './oneclic/oneclic.module';
import { StorageModule } from './storage/storage.module';
import { EmailModule } from './email/email.module';

@Module({
  imports: [
    StripeModule,
    AiModule, // <-- 2. Lo registramos en la aplicación
    DiscountsModule,
    OneclicModule, // Conexión con 1clic.ai (aislado: se puede quitar sin tocar nada más)
    StorageModule, // Gestión de almacenamiento (uso del bucket y limpieza de borradores)
    EmailModule, // Correos masivos a usuarios registrados (pestaña Correos) y baja pública
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}