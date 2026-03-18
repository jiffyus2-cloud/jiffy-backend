import { Controller, Post, Body, Headers, Req, HttpCode, HttpStatus, RawBodyRequest } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { Request } from 'express';

@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('create-checkout')
  async createCheckout(@Body() orderDetails: { title: string; amount: number; orderId: string }) {
    return this.stripeService.createCheckoutSession(orderDetails);
  }

  // Mantenemos esto por compatibilidad con Success.tsx
  @Post('confirm-payment')
  async confirmPayment(@Body() body: { sessionId: string; orderId: string }) {
    return this.stripeService.confirmPayment(body.sessionId, body.orderId);
  }

  // --- NUEVO ENDPOINT PARA EL WEBHOOK ---
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