import { Controller, Post, Body, Headers, Req, HttpCode, HttpStatus, RawBodyRequest, UseGuards } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { Request } from 'express';
import { FirebaseAuthGuard } from '../middleware/firebase-auth.guard';

@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('create-checkout')
  @UseGuards(FirebaseAuthGuard)
  async createCheckout(@Body() orderDetails: { title: string; amount: number; orderId: string }) {
    return this.stripeService.createCheckoutSession(orderDetails);
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