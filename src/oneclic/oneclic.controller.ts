import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { OwnerGuard } from '../middleware/owner.guard';
import { OneclicService } from './oneclic.service';
import { OneclicAttestation } from './oneclic.client';

type AuthedRequest = Request & { user?: { uid: string; email?: string } };

/**
 * Puente entre el panel del dueño y 1clic.ai.
 *
 * Todo va detrás de OwnerGuard: un run real gasta de la cartera (tope
 * $25/mes), así que solo el dueño puede lanzarlos. La clave de 1clic no sale
 * de aquí: el navegador nunca la ve, solo ve lo que el agente propone.
 */
@Controller('oneclic')
@UseGuards(OwnerGuard)
export class OneclicController {
  constructor(private readonly oneclic: OneclicService) {}

  /** Estado de la conexión, agentes disponibles y qué variable falta, si falta. */
  @Get('status')
  status() {
    return this.oneclic.overview();
  }

  /**
   * La acción de la plataforma: pedir una propuesta a un agente sobre un
   * registro. La respuesta es una PROPUESTA — el frontend la muestra con su
   * coste y no escribe nada hasta que una persona la aprueba.
   */
  @Post('propose')
  propose(
    @Body() body: { agentId?: string; message?: string; recordId?: string; context?: unknown; mode?: 'default' | 'dry_run' },
    @Req() req: AuthedRequest,
  ) {
    return this.oneclic.propose({
      uid: req.user!.uid,
      agentId: String(body?.agentId ?? ''),
      message: String(body?.message ?? ''),
      recordId: String(body?.recordId ?? ''),
      context: body?.context,
      mode: body?.mode,
    });
  }

  /**
   * Paso D: la verificación se dispara desde Jiffyphotos, no desde una shell.
   * Las atestaciones apuntan a archivo:línea del panel que pinta la propuesta.
   */
  @Post('verify')
  verify(@Body() body: { attestations?: { cost_visible?: OneclicAttestation; proposal_only?: OneclicAttestation } }) {
    return this.oneclic.verify(body?.attestations ?? {});
  }
}
