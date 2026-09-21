import { Module } from '@nestjs/common';
import { OneclicController } from './oneclic.controller';
import { OneclicService } from './oneclic.service';
import { AlbumOrderingController } from './album-ordering.controller';
import { AlbumOrderingService } from './album-ordering.service';

/**
 * Conexión con 1clic.ai (módulo aislado).
 *
 * No depende de ningún otro módulo del backend ni ninguno depende de él: se
 * puede quitar de AppModule y el resto sigue igual. Lee ONECLIC_API_KEY y
 * ONECLIC_CONNECTION_ID del entorno; sin ellas responde 503 en vez de fallar
 * en el arranque, porque el checkout no debe caer por una integración opcional.
 *
 * AlbumOrdering* es el laboratorio de orden de álbumes: solo lectura.
 */
@Module({
  controllers: [OneclicController, AlbumOrderingController],
  providers: [OneclicService, AlbumOrderingService],
  exports: [OneclicService],
})
export class OneclicModule {}
