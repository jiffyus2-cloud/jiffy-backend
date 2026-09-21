import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/** Gestión de almacenamiento: uso del bucket y limpieza de borradores vencidos. */
@Module({
  providers: [StorageService],
  controllers: [StorageController],
})
export class StorageModule {}
