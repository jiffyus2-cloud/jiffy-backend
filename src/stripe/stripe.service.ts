import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import Stripe from 'stripe';
import * as admin from 'firebase-admin';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
    });

    // Inicializamos Firebase Admin para poder editar la BD desde el backend
    if (!admin.apps.length) {
      admin.initializeApp({
        // Asegúrate de poner esto en tu .env del backend
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          // Reemplazamos los saltos de línea escapados si vienen en un string
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }
  }

  // Se añadió 'orderId' a los parámetros
  async createCheckoutSession(orderDetails: { title: string; amount: number; orderId: string }) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
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
      // ✨ LA MAGIA: Guardamos el ID del pedido de forma invisible para que Stripe nos lo devuelva
      metadata: {
        orderId: orderDetails.orderId 
      },
      success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/checkout`,
    });

    return { 
      sessionId: session.id,
      url: session.url 
    };
  }

  // --- NUEVA FUNCIÓN QUE MANEJA EL WEBHOOK SEGURO DE STRIPE ---
  async handleStripeWebhook(signature: string, rawBody: Buffer) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event: Stripe.Event;

    try {
      // Verificamos matemáticamente que la firma coincida para evitar hackeos
      event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      console.error(`⚠️ Webhook signature verification failed.`, err.message);
      throw new HttpException(`Webhook Error: ${err.message}`, HttpStatus.BAD_REQUEST);
    }

    // Si el usuario pagó exitosamente
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      
      // Recuperamos el ID oculto del pedido
      const orderId = session.metadata?.orderId;

      if (orderId) {
        try {
          // Actualizamos la base de datos DIRECTAMENTE desde el servidor
          const db = admin.firestore();
          await db.collection('orders').doc(orderId).update({
            status: 'paid',
            updatedAt: new Date().toISOString()
          });
          
          console.log(`✅ ¡Éxito! Pedido ${orderId} actualizado a 'paid' vía Webhook.`);
        } catch (dbError) {
          console.error(`❌ Error actualizando Firebase para el pedido ${orderId}:`, dbError);
        }
      }
    }

    // Le decimos a Stripe que recibimos la notificación
    return { received: true };
  }

  // Mantenemos esta función para que el Frontend no rompa si llama al endpoint viejo
  async confirmPayment(sessionId: string, orderId: string) {
    return { 
      success: true, 
      message: 'Pago delegado al Webhook exitosamente',
      orderId: orderId 
    };
  }
}