import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { OwnerGuard } from '../middleware/owner.guard';
import { AlbumOrderingService } from './album-ordering.service';

type AuthedRequest = Request & { user?: { uid: string; email?: string } };

/**
 * Laboratorio de orden de álbumes con 1clic. SOLO LECTURA: ninguno de estos
 * endpoints escribe en Firestore ni en Storage; la propuesta del agente se
 * devuelve al panel y ahí se queda.
 */
@Controller('oneclic/albums')
@UseGuards(OwnerGuard)
export class AlbumOrderingController {
  constructor(private readonly albums: AlbumOrderingService) {}

  @Get()
  list() {
    return this.albums.listAlbums();
  }

  @Post(':id/organize')
  organize(
    @Param('id') id: string,
    @Body() body: { agentId?: string; mode?: 'default' | 'dry_run' },
    @Req() req: AuthedRequest,
  ) {
    return this.albums.organize({
      orderId: id,
      agentId: String(body?.agentId ?? ''),
      mode: body?.mode,
      uid: req.user!.uid,
    });
  }
}
