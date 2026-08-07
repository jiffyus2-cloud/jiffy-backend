import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import Stripe from 'stripe';
import { getFirestore } from '../firebase/firebase-admin';

/**
 * Estados en los que un pedido NO se puede volver a cobrar.
 *
 * Se usa lista negra y no lista blanca a propósito: si mañana aparece un estado
 * nuevo preferimos permitir el cobro (y detectarlo) antes que romper el checkout
 * de un cliente por un estado que no habíamos previsto.
 */
const NON_PAYABLE_STATUSES = new Set([
  'paid',
  'mock_paid',
  'en_produccion',
  'enviado',
  'entregado',
]);

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.VITE_STRIPE_SECRET_KEY;

    // Antes había un fallback a 'sk_test_fallback': el servicio arrancaba con una
    // clave inválida y el fallo aparecía en el primer intento de pago, como un
    // error opaco de Stripe. Mejor no arrancar.
    if (!stripeKey) {
      throw new Error(
        'Falta STRIPE_SECRET_KEY (o VITE_STRIPE_SECRET_KEY). El servidor no puede procesar pagos.'
      );
    }

    this.stripe = new Stripe(stripeKey, {
      apiVersion: '2026-02-25.clover',
    });

    // La inicialización de Firebase Admin se movió a src/firebase/firebase-admin.ts
    // y ocurre en el arranque (main.ts). Antes vivía aquí y, si faltaban las
    // credenciales, solo avisaba por consola: el servicio quedaba en pie pero
    // incapaz de verificar tokens ni de leer pedidos.
  }

  /**
   * Crea la sesión de pago de un pedido.
   *
   * El importe se lee del pedido en Firestore y NO del cuerpo de la petición.
   * Antes se pasaba `orderDetails.amount` directamente a Stripe como
   * `unit_amount`, así que bastaba un POST con `amount: 100` para pagar 1 COP
   * por un álbum de 280.000.
   *
   * `uid` viene de FirebaseAuthGuard, que ya validó el ID token.
   */
  async createCheckoutSession(params: {
    orderId: string;
    uid: string;
    /** Importe que dice el cliente. Solo se usa para detectar discrepancias. */
    clientAmount?: number;
    /** Título que dice el cliente. Solo se usa como último recurso. */
    clientTitle?: string;
  }) {
    const { orderId, uid, clientAmount, clientTitle } = params;

    if (typeof orderId !== 'string' || orderId.trim() === '') {
      throw new HttpException('Falta orderId', HttpStatus.BAD_REQUEST);
    }

    const snapshot = await getFirestore().collection('orders').doc(orderId).get();
    if (!snapshot.exists) {
      throw new HttpException('El pedido no existe', HttpStatus.NOT_FOUND);
    }

    const order = snapshot.data() as any;

    // Solo puedes pagar tus propios pedidos.
    if (order.userId !== uid) {
      console.warn(`[stripe] Usuario ${uid} intentó pagar el pedido ${orderId} de ${order.userId}.`);
      throw new HttpException('El pedido no te pertenece', HttpStatus.FORBIDDEN);
    }

    if (NON_PAYABLE_STATUSES.has(order.status)) {
      throw new HttpException(
        `El pedido ya está en estado "${order.status}" y no admite un nuevo pago`,
        HttpStatus.CONFLICT
      );
    }

    const total = Number(order.total);
    if (!Number.isFinite(total) || total <= 0) {
      throw new HttpException(
        'El pedido no tiene un total válido. Vuelve al checkout y confirma la dirección.',
        HttpStatus.BAD_REQUEST
      );
    }

    // COP se cobra en unidades menores, igual que venía haciendo el frontend.
    const unitAmount = Math.round(total * 100);

    if (typeof clientAmount === 'number' && clientAmount !== unitAmount) {
      // No es motivo de rechazo (el cliente puede ir un paso por detrás), pero
      // una discrepancia sistemática es señal de manipulación.
      console.warn(
        `[stripe] Importe distinto en el pedido ${orderId}: cliente=${clientAmount}, ` +
        `servidor=${unitAmount}. Se usa el del servidor.`
      );
    }

    const title = order.product?.name || clientTitle || 'Pedido Jiffy';
    const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || 'http://localhost:5173';

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'cop',
            product_data: { name: title },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      // Guardamos el ID del pedido de forma invisible para recuperarlo en el webhook.
      metadata: { orderId },
      success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/checkout`,
    });

    return {
      sessionId: session.id,
      url: session.url,
    };
  }

  // --- WEBHOOK SEGURO DE STRIPE ---
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
          await getFirestore().collection('orders').doc(orderId).update({
            status: 'paid',
            updatedAt: new Date().toISOString(),
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
}
