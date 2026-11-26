import { Injectable, HttpException } from '@nestjs/common';
import Stripe from 'stripe';
import { getFirestore } from '../firebase/firebase-admin';
import { DiscountsService } from '../discounts/discounts.service';
import { OrderEmailService } from '../email/order-email.service';
import { CheckoutGroupError, orderIdsFromMetadata, validateGroup } from './checkout-group';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor(
    private readonly discountsService: DiscountsService,
    private readonly orderEmails: OrderEmailService,
  ) {
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
   * Crea la sesión de pago de uno o varios pedidos (carrito).
   *
   * El importe se lee de los pedidos en Firestore y NO del cuerpo de la
   * petición. Antes se pasaba `orderDetails.amount` directamente a Stripe como
   * `unit_amount`, así que bastaba un POST con `amount: 100` para pagar 1 COP
   * por un álbum de 280.000.
   *
   * Con varios pedidos, cada uno es una línea en Stripe con su parte del total
   * (el checkout ya repartió envío y descuentos) y todos deben pertenecer al
   * mismo `checkoutGroup` (ver checkout-group.ts).
   *
   * `uid` viene de FirebaseAuthGuard, que ya validó el ID token.
   */
  async createCheckoutSession(params: {
    /** El primero es el pedido principal (lleva el envío y el código). */
    orderIds: string[];
    uid: string;
    /** Importe que dice el cliente. Solo se usa para detectar discrepancias. */
    clientAmount?: number;
    /** Título que dice el cliente. Solo se usa como último recurso. */
    clientTitle?: string;
  }) {
    const { orderIds, uid, clientAmount, clientTitle } = params;
    const db = getFirestore();
    const snaps = await Promise.all(orderIds.map(id => db.collection('orders').doc(id).get()));

    let group: ReturnType<typeof validateGroup>;
    try {
      group = validateGroup(orderIds, snaps.map(s => (s.exists ? s.data() : null)), uid);
    } catch (err) {
      if (err instanceof CheckoutGroupError) {
        if (err.status === 403) {
          console.warn(`[stripe] Usuario ${uid} intentó pagar pedidos ajenos: ${orderIds.join(', ')}.`);
        }
        throw new HttpException(err.message, err.status);
      }
      throw err;
    }

    if (typeof clientAmount === 'number' && clientAmount !== group.totalMinor) {
      // No es motivo de rechazo (el cliente puede ir un paso por detrás), pero
      // una discrepancia sistemática es señal de manipulación.
      console.warn(
        `[stripe] Importe distinto en ${orderIds.join(', ')}: cliente=${clientAmount}, ` +
        `servidor=${group.totalMinor}. Se usa el del servidor.`
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL || 'http://localhost:5173';
    const single = group.lines.length === 1;

    // Una línea por pedido. Las de 0 (cubiertas por un descuento) no se listan:
    // Stripe cobra igual el total de las demás.
    const lineItems = group.lines
      .filter(l => l.amountMinor > 0)
      .map(l => ({
        price_data: {
          currency: 'cop',
          product_data: { name: single && l.name === 'Pedido Jiffy' && clientTitle ? clientTitle : l.name },
          unit_amount: l.amountMinor,
        },
        quantity: 1,
      }));

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      // Ids de los pedidos, invisibles para el cliente, para recuperarlos en el
      // webhook. `orderId` (el principal) se mantiene por compatibilidad.
      metadata: {
        orderId: group.leadOrderId,
        ...(single ? {} : { orderIds: group.orderIds.join(',') }),
      },
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
      throw new HttpException(`Webhook Error: ${err.message}`, 400);
    }

    // Si el usuario pagó exitosamente
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;

      // Recuperamos los IDs ocultos de los pedidos (uno, o varios si fue un carrito).
      const orderIds = orderIdsFromMetadata(session.metadata);
      const leadOrderId = orderIds[0];
      const now = new Date().toISOString();

      for (const orderId of orderIds) {
        try {
          const orderRef = getFirestore().collection('orders').doc(orderId);
          const orderSnapshot = await orderRef.get();

          // Actualizamos la base de datos DIRECTAMENTE desde el servidor
          await orderRef.update({
            status: 'paid',
            updatedAt: now,
          });

          console.log(`✅ ¡Éxito! Pedido ${orderId} actualizado a 'paid' vía Webhook.`);

          // En un carrito es una sola compra: el correo de confirmación y el
          // canje del código van solo con el pedido principal.
          if (orderId !== leadOrderId) continue;

          // Correo de confirmación de compra (si el dueño lo activó). notify() no
          // lanza y es idempotente: los reintentos de Stripe no lo duplican.
          await this.orderEmails.notify(orderId, 'paid');

          // El canje del código se cuenta AQUÍ, no cuando el cliente lo escribe:
          // así un código no se gasta por abandonar el checkout y nadie puede
          // agotar el código de otro escribiéndolo. redeem() es idempotente por
          // pedido, porque Stripe reintenta sus webhooks.
          const order = orderSnapshot.data() as any;
          if (order?.discountCode) {
            const result = await this.discountsService.redeem(
              order.discountCode,
              order.userId || null,
              orderId
            );
            if (result.overLimit) {
              console.warn(
                `⚠️ El pedido ${orderId} usó ${order.discountCode} por encima de sus límites; ` +
                'el canje queda marcado para revisarlo.'
              );
            }
          }
        } catch (dbError) {
          console.error(`❌ Error actualizando Firebase para el pedido ${orderId}:`, dbError);
        }
      }
    }

    // Le decimos a Stripe que recibimos la notificación
    return { received: true };
  }
}
