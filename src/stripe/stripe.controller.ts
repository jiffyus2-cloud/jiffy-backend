import { Controller, Post, Body } from '@nestjs/common';
import { StripeService } from './stripe.service';

@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('create-checkout')
  async createCheckout(@Body() orderDetails: { title: string; amount: number; orderId: string }) {
    return this.stripeService.createCheckoutSession(orderDetails);
  }

  // --- NUEVO ENDPOINT DE VERIFICACIÓN ---
  @Post('confirm-payment')
  async confirmPayment(@Body() body: { sessionId: string; orderId: string }) {
    return this.stripeService.confirmPayment(body.sessionId, body.orderId);
  }
}