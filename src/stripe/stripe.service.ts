import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
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

  // --- NUEVA FUNCIÓN DE VERIFICACIÓN ---
  async confirmPayment(sessionId: string, orderId: string) {
    try {
      // 1. Le pedimos a Stripe el recibo oficial de esta sesión
      const session = await this.stripe.checkout.sessions.retrieve(sessionId);

      // 2. Evaluamos el estado real del dinero
      if (session.payment_status === 'paid') {
        
        // [NOTA ARQUITECTÓNICA FUTURA]
        // Aquí es donde conectarías Firebase Admin SDK a tu Backend 
        // para buscar el 'orderId' en Firestore y actualizar su status a 'paid'.
        // Por ahora, le daremos luz verde al Frontend para que limpie el carrito.

        return { 
          success: true, 
          message: 'Pago verificado exitosamente con Stripe',
          orderId: orderId 
        };
      } else {
        // Si el usuario canceló o la tarjeta falló
        throw new HttpException(
          'El pago aún no se ha procesado correctamente.', 
          HttpStatus.PAYMENT_REQUIRED
        );
      }
    } catch (error) {
      console.error('Error validando con Stripe:', error);
      throw new HttpException(
        'Error interno al intentar verificar el pago.', 
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}