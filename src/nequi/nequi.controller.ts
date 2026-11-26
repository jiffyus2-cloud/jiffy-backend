import {
  Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Post, Req, UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { FirebaseAuthGuard } from '../middleware/firebase-auth.guard';
import { OwnerGuard } from '../middleware/owner.guard';
import { readNequiConfig } from './nequi.config';
import { NequiService } from './nequi.service';
import { CheckoutGroupError, parseOrderIds } from '../stripe/checkout-group';

type AuthedRequest = Request & { user?: { uid: string } };

@Controller('nequi')
export class NequiController {
  constructor(private readonly nequi: NequiService) {}

  /** Público: el checkout lo usa para decidir si muestra la opción Nequi. */
  @Get('config')
  config() {
    return this.nequi.publicConfig();
  }

  /** Envía la notificación de cobro al celular Nequi del cliente. */
  @Post('create-payment')
  @UseGuards(FirebaseAuthGuard)
  createPayment(@Body() body: { orderId?: string; orderIds?: string[]; phone?: string }, @Req() req: AuthedRequest) {
    // `orderIds` (compra de varios productos) o `orderId` (pedido suelto, como siempre).
    let orderIds: string[];
    try {
      orderIds = parseOrderIds(body);
    } catch (err) {
      if (err instanceof CheckoutGroupError) throw new HttpException(err.message, err.status);
      throw err;
    }
    return this.nequi.createPayment({
      orderIds,
      uid: req.user!.uid,
      phone: body?.phone,
    });
  }

  /** El navegador pregunta cada pocos segundos mientras espera la aprobación. */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(FirebaseAuthGuard)
  status(@Body() body: { orderId?: string }, @Req() req: AuthedRequest) {
    return this.nequi.getStatus({ orderId: String(body?.orderId ?? ''), uid: req.user!.uid });
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(FirebaseAuthGuard)
  cancel(@Body() body: { orderId?: string }, @Req() req: AuthedRequest) {
    return this.nequi.cancel({ orderId: String(body?.orderId ?? ''), uid: req.user!.uid });
  }

  /** Solo el dueño: devuelve al cliente un pago Nequi ya cobrado (pedido en "Pagado"). */
  @Post('reverse')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OwnerGuard)
  reverse(@Body() body: { orderId?: string }, @Req() req: Request & { user?: { email?: string } }) {
    return this.nequi.reversePayment({
      orderId: String(body?.orderId ?? ''),
      ownerEmail: String(req.user?.email ?? ''),
    });
  }

  /**
   * Para Cloud Scheduler. Sin Firebase: se autentica con el header
   * `x-reconcile-secret`, que debe coincidir con NEQUI_RECONCILE_SECRET.
   * Sin ese secreto configurado el endpoint no existe (404).
   */
  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  reconcile(@Headers('x-reconcile-secret') provided: string | undefined) {
    const expected = readNequiConfig().reconcileSecret;
    if (!expected) throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    const a = Buffer.from(String(provided ?? ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpException('Secreto inválido', HttpStatus.UNAUTHORIZED);
    }
    return this.nequi.reconcilePending();
  }
}
