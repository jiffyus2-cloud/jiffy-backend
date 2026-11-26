import {
  Controller, Post, Body, Headers, Req, HttpCode, HttpStatus, HttpException, RawBodyRequest, UseGuards,
} from '@nestjs/common';
import { StripeService } from './stripe.service';
import { CheckoutGroupError, parseOrderIds } from './checkout-group';
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
    @Body() body: { title?: string; amount?: number; orderId?: string; orderIds?: string[] },
    @Req() req: AuthedRequest,
  ) {
    // `amount` y `title` llegan del cliente pero ya no deciden nada: el servicio
    // toma el importe de los pedidos en Firestore. Se siguen pasando solo para
    // registrar discrepancias y para usar el título como último recurso.
    // `orderIds` (carrito) o `orderId` (pedido suelto, como siempre).
    let orderIds: string[];
    try {
      orderIds = parseOrderIds(body);
    } catch (err) {
      if (err instanceof CheckoutGroupError) throw new HttpException(err.message, err.status);
      throw err;
    }
    return this.stripeService.createCheckoutSession({
      orderIds,
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
