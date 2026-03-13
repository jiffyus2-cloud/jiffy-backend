import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover', // Best practice to use latest or a fixed version
    });
  }

  async createCheckoutSession(orderDetails: { title: string; amount: number }) {
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: orderDetails.title,
            },
            unit_amount: orderDetails.amount,
          },
          quantity: 1,
        },
      ],
      success_url: 'http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'http://localhost:5173/checkout',
    });

    // ¡Aquí está la magia! Devolvemos la URL al frontend
    return { 
      sessionId: session.id,
      url: session.url 
    };
  }
}