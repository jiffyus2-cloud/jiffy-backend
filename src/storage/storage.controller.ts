import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../middleware/owner.guard';
import { CleanupAuthGuard } from './cleanup-auth.guard';
import { StorageService } from './storage.service';
import { readStoragePolicy } from './storage-policy';

/**
 * Gestión de almacenamiento (panel del dueño → pestaña "Gestión de almacenamiento").
 *
 * La política (máximo de borradores, días de retención, capacidad de
 * referencia) la escribe el panel directamente en Firestore
 * (`settings/storage_policy`, solo el dueño según firestore.rules); aquí solo
 * se lee. Lo que el navegador no puede hacer es recorrer el bucket ni borrar
 * en nombre de otros usuarios: para eso están estas rutas.
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  /** Política vigente, tal como la ve el backend (útil para depurar). */
  @Get('policy')
  @UseGuards(OwnerGuard)
  policy() {
    return readStoragePolicy();
  }

  /**
   * Uso del bucket: totales, desglose, proyectos y usuarios que más ocupan,
   * carpetas huérfanas y borradores vencidos. Cacheado unos minutos; `?refresh=1`
   * fuerza el recálculo.
   */
  @Get('stats')
  @UseGuards(OwnerGuard)
  stats(@Query('refresh') refresh?: string) {
    return this.storageService.getStats(refresh === '1' || refresh === 'true');
  }

  /**
   * Borra los borradores que llevan más de `draftRetentionDays` sin editarse y,
   * opcionalmente, las carpetas de Storage sin pedido. Con `dryRun: true` solo
   * informa. Lo llama el panel (dueño) o Cloud Scheduler (`x-cleanup-token`).
   */
  @Post('cleanup')
  @UseGuards(CleanupAuthGuard)
  cleanup(
    @Req() request: { cleanupTrigger?: 'panel' | 'scheduler' },
    @Body() body?: { dryRun?: boolean; expiredDrafts?: boolean; orphans?: boolean },
  ) {
    return this.storageService.cleanup({
      dryRun: body?.dryRun === true,
      expiredDrafts: body?.expiredDrafts !== false,
      orphans: body?.orphans !== false,
      trigger: request.cleanupTrigger ?? 'panel',
    });
  }
}
