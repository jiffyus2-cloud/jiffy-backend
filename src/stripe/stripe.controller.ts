import {
  Controller, Post, Body, Headers, Req, HttpCode, HttpStatus, RawBodyRequest, UseGuards,
} from '@nestjs/common';
import { StripeService } from './stripe.service';
import { Request } from 'express';
import { FirebaseAuthGuard } from '../middleware/firebase-auth.guard';

/** Request con el usuario ya resuelto por FirebaseAuthGuard. */
type AuthedRequest = Request & { user?: { uid: string } };

@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('create-checkout')
  @UseGuards(FirebaseAuthGuard)
  async createCheckout(
    @Body() body: { title?: string; amount?: number; orderId?: string },
    @Req() req: AuthedRequest,
  ) {
    // `amount` y `title` llegan del cliente pero ya no deciden nada: el servicio
    // toma el importe del pedido en Firestore. Se siguen pasando solo para poder
    // registrar discrepancias y para usar el título como último recurso.
    return this.stripeService.createCheckoutSession({
      orderId: String(body?.orderId ?? ''),
      uid: req.user!.uid,
      clientAmount: typeof body?.amount === 'number' ? body.amount : undefined,
      clientTitle: typeof body?.title === 'string' ? body.title : undefined,
    });
  }

  // --- ENDPOINT PARA EL WEBHOOK ---
  // Sin guard a propósito: lo llama Stripe, no el navegador. Su autenticación es
  // la firma criptográfica que valida handleStripeWebhook.
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() req: RawBodyRequest<Request>
  ) {
    // Le pasamos la firma y el cuerpo crudo de la petición para la validación
    if (!req.rawBody) {
      throw new Error('Raw body no está disponible. Asegúrate de habilitarlo en main.ts');
    }
    return this.stripeService.handleStripeWebhook(signature, req.rawBody);
  }
}
