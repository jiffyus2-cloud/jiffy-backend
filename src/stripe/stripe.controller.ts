import { Controller, Post, Body } from '@nestjs/common';
import { StripeService } from './stripe.service';

@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('create-checkout')
  async createCheckout(@Body() orderDetails: { title: string; amount: number }) {
    return this.stripeService.createCheckoutSession(orderDetails);
  }
}
