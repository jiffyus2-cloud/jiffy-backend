import { Module } from '@nestjs/common';
import { OneclicController } from './oneclic.controller';
import { OneclicService } from './oneclic.service';

/**
 * Conexión con 1clic.ai (módulo aislado).
 *
 * No depende de ningún otro módulo del backend ni ninguno depende de él: se
 * puede quitar de AppModule y el resto sigue igual. Lee ONECLIC_API_KEY y
 * ONECLIC_CONNECTION_ID del entorno; sin ellas responde 503 en vez de fallar
 * en el arranque, porque el checkout no debe caer por una integración opcional.
 */
@Module({
  controllers: [OneclicController],
  providers: [OneclicService],
  exports: [OneclicService],
})
export class OneclicModule {}
