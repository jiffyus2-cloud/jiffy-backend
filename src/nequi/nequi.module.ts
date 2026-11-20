import { Module } from '@nestjs/common';
import { DiscountsModule } from '../discounts/discounts.module';
import { NequiController } from './nequi.controller';
import { NequiService } from './nequi.service';

/**
 * Cobro con Nequi (API Nequi Conecta, pagos push). Aislado: sin credenciales
 * queda apagado y quitarlo de AppModule no afecta a nada más.
 */
@Module({
  imports: [DiscountsModule],
  providers: [NequiService],
  controllers: [NequiController],
})
export class NequiModule {}
