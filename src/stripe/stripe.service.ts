import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import Stripe from 'stripe';
import * as admin from 'firebase-admin';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    // 1. Soportamos la variable con prefijo VITE_ o normal
    const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.VITE_STRIPE_SECRET_KEY || 'sk_test_fallback';
    
    this.stripe = new Stripe(stripeKey, {
      apiVersion: '2026-02-25.clover',
    });

    // Inicializamos Firebase Admin protegiéndolo de errores (Crash)
    if (!admin.apps.length) {
      try {
        // 2. Extraemos las variables soportando el formato VITE_ de tu entorno
        const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.VITE_FIREBASE_CLIENT_EMAIL;
        const privateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.VITE_FIREBASE_PRIVATE_KEY;

        // 3. Verificamos que ninguna esté vacía antes de pasarlas a Firebase
        if (!projectId || !clientEmail || !privateKey) {
          console.warn('⚠️ ADVERTENCIA: Faltan variables de Firebase. El servidor arrancará, pero el Webhook no podrá editar la BD.');
        } else {
          // 4. Si existen, inicializamos Firebase
          admin.initializeApp({
            credential: admin.credential.cert({
              projectId: projectId,
              clientEmail: clientEmail,
              privateKey: privateKey.replace(/\\n/g, '\n'),
            }),
          });
          console.log('✅ Firebase Admin inicializado correctamente.');
        }
      } catch (error: any) {
        console.error('❌ CRÍTICO: Falló la configuración de Firebase Admin:', error.message);
      }
    }
  }

  // Se añadió 'orderId' a los parámetros
  async createCheckoutSession(orderDetails: { title: string; amount: number; orderId: string }) {
    const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || 'http://localhost:5173';
    
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
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.VITE_STRIPE_WEBHOOK_SECRET;
    let event: Stripe.Event;

    try {
      if (!webhookSecret) throw new Error('No hay STRIPE_WEBHOOK_SECRET configurado.');
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