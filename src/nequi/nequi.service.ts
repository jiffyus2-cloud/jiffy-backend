import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { getFirestore } from '../firebase/firebase-admin';
import { DiscountsService } from '../discounts/discounts.service';
import { OrderEmailService } from '../email/order-email.service';
import { readNequiConfig } from './nequi.config';
import { CheckoutGroupError, NON_PAYABLE_STATUSES, validateGroup } from '../stripe/checkout-group';
import {
  NequiApiError,
  NequiClient,
  NequiNotConfiguredError,
  NequiPaymentState,
  generateMessageId,
  isAmbiguousSendFailure,
  normalizeNequiPhone,
} from './nequi.client';

/**
 * El cobro vive en `nequi_payments/{orderId}` y NO dentro del pedido. En una
 * compra de varios productos (carrito) el id es el del pedido principal y el
 * registro lista en `orderIds` todos los pedidos que cubre.
 *
 * firestore.rules deja que el cliente edite su propio pedido; si el
 * transactionId estuviera ahí, alguien podría pegar el id de un cobro ya pagado
 * de otro pedido y hacer que el backend marcara el suyo como pagado. Esta
 * colección no tiene regla en firestore.rules, así que desde el navegador ni se
 * lee ni se escribe: solo el backend (Admin SDK).
 *
 * En el pedido solo se reflejan `paymentMethod` y `nequiState`, para que el
 * panel del dueño lo vea; nunca se leen de vuelta para decidir nada.
 */
const PAYMENTS = 'nequi_payments';

export interface NequiPaymentRecord {
  orderId: string;
  /** Compra de varios productos: todos los pedidos que cubre (el primero es `orderId`). */
  orderIds?: string[];
  userId: string;
  transactionId: string;
  /**
   * MessageID de la petición `unregisteredPayment`: es lo que identifica el
   * cobro al reversarlo. Los registros anteriores a la reversión no lo tienen.
   */
  messageId?: string | null;
  reversedAt?: string | null;
  reversedBy?: string | null;
  /** Completo porque `cancelUnregisteredPayment` lo pide; al navegador sale enmascarado. */
  phoneNumber: string;
  value: number;
  state: NequiPaymentState;
  rawStatus: string | null;
  nequiTrnId?: string | null;
  paidValue?: number | null;
  createdAt: string;
  updatedAt: string;
  checkedAt: string | null;
}

/** Lo que ve el navegador. */
export interface NequiPaymentView {
  state: NequiPaymentState;
  phone: string;
  value: number;
  createdAt: string;
  orderStatus: string;
}

/** No consultar a Nequi más de una vez cada tantos ms por pedido. */
const MIN_CHECK_INTERVAL_MS = 3_000;

@Injectable()
export class NequiService {
  private readonly logger = new Logger('Nequi');
  private readonly config = readNequiConfig();
  private readonly client: NequiClient;
  /** Última consulta a Nequi por pedido (memoria del proceso; basta como freno). */
  private readonly lastCheck = new Map<string, number>();

  constructor(
    private readonly discountsService: DiscountsService,
    private readonly orderEmails: OrderEmailService,
  ) {
    this.client = new NequiClient(this.config);
    this.logger.log(
      this.client.configured
        ? `Nequi configurado (entorno ${this.config.env}).`
        : 'Nequi sin configurar: la opción de pago queda oculta en el checkout.',
    );
  }

  publicConfig() {
    return { enabled: this.client.configured, env: this.config.env };
  }

  /**
   * Envía el cobro push al celular del cliente.
   *
   * Igual que con Stripe, el importe sale del pedido en Firestore, nunca del
   * cuerpo de la petición. Si el pedido ya tenía un cobro pendiente se anula
   * antes de mandar otro, para que el cliente no tenga dos notificaciones
   * abiertas y acabe pagando dos veces.
   */
  async createPayment(params: { orderIds: string[]; uid: string; phone: unknown }): Promise<NequiPaymentView> {
    this.assertConfigured();
    const phoneNumber = normalizeNequiPhone(params.phone);
    if (!phoneNumber) {
      throw new HttpException('El celular de Nequi debe tener 10 dígitos y empezar por 3.', HttpStatus.BAD_REQUEST);
    }

    // Uno o varios pedidos (carrito): mismas comprobaciones que Stripe. El
    // cobro se guarda con el id del pedido principal (el primero).
    const db = getFirestore();
    const snaps = await Promise.all(params.orderIds.map(id => db.collection('orders').doc(id).get()));
    let group: ReturnType<typeof validateGroup>;
    try {
      group = validateGroup(params.orderIds, snaps.map(s => (s.exists ? s.data() : null)), params.uid);
    } catch (err) {
      if (err instanceof CheckoutGroupError) {
        if (err.status === 403) {
          this.logger.warn(`Usuario ${params.uid} intentó pagar pedidos ajenos: ${params.orderIds.join(', ')}.`);
        }
        throw new HttpException(err.message, err.status);
      }
      throw err;
    }
    const orderId = group.leadOrderId;
    const total = Math.round(group.totalMinor / 100);

    // ¿Había un cobro anterior? Primero saber si ya se pagó; si sigue
    // pendiente, anularlo antes de mandar el nuevo.
    const previous = await this.loadRecord(orderId);
    if (previous?.state === 'pending') {
      const refreshed = await this.refresh(orderId, true);
      if (refreshed.state === 'paid') return refreshed;
      if (refreshed.state === 'pending') {
        try {
          await this.client.cancelPushPayment({
            phoneNumber: previous.phoneNumber,
            transactionId: previous.transactionId,
          });
        } catch (err) {
          // Si no se pudo anular puede ser porque el cliente lo acaba de
          // aceptar: una última consulta antes de decidir.
          const last = await this.refresh(orderId, true);
          if (last.state === 'paid') return last;
          if (last.state === 'pending') {
            this.logger.warn(`No se pudo anular el cobro previo del pedido ${orderId}: ${describe(err)}`);
            throw new HttpException(
              'Tienes un cobro de Nequi pendiente para este pedido. Acéptalo o recházalo en tu app, o espera unos minutos.',
              HttpStatus.CONFLICT,
            );
          }
        }
      }
    }

    // El MessageID se fija antes de enviar: si la respuesta no llega, es lo
    // único con lo que se puede reversar un cobro que Nequi sí procesó.
    const messageId = generateMessageId();
    let transactionId: string;
    try {
      ({ transactionId } = await this.client.sendPushPayment({
        phoneNumber,
        value: total,
        reference1: orderId,
        reference2: 'Jiffy Photos',
        messageId,
      }));
    } catch (err) {
      if (isAmbiguousSendFailure(err)) {
        // Sin respuesta clara no sabemos si al cliente le llegó (o si ya
        // pagó) un cobro del que no tenemos transactionId. Nequi pide
        // reversarlo para que no quede un pago huérfano.
        try {
          await this.client.reverseTransaction({ phoneNumber, value: total, messageId });
          this.logger.warn(`Cobro sin respuesta del pedido ${orderId} reversado (MessageID ${messageId}).`);
        } catch (revErr) {
          this.logger.error(
            `⚠️ Cobro sin respuesta del pedido ${orderId} y la reversión falló ` +
            `(MessageID ${messageId}, celular ${maskPhone(phoneNumber)}, ${total} COP): ${describe(revErr)}. Revisar a mano.`,
          );
        }
      }
      throw this.toHttp(err, 'No pudimos enviar el cobro a tu Nequi.');
    }

    const now = new Date().toISOString();
    const record: NequiPaymentRecord = {
      orderId: orderId,
      userId: params.uid,
      transactionId,
      messageId,
      phoneNumber,
      value: total,
      state: 'pending',
      rawStatus: null,
      createdAt: now,
      updatedAt: now,
      checkedAt: null,
      ...(group.orderIds.length > 1 ? { orderIds: group.orderIds } : {}),
    };
    await db.collection(PAYMENTS).doc(orderId).set(record);
    const batch = db.batch();
    for (const id of group.orderIds) {
      batch.update(db.collection('orders').doc(id), { paymentMethod: 'nequi', nequiState: 'pending', updatedAt: now });
    }
    await batch.commit();
    this.logger.log(
      `Cobro push enviado: pedido ${orderId}${group.orderIds.length > 1 ? ` (+${group.orderIds.length - 1} de la compra)` : ''}, ` +
      `${total} COP, tx ${transactionId}.`,
    );

    return toView(record, (snaps[0].data() as any)?.status);
  }

  /** Estado del cobro del pedido (consulta a Nequi si sigue pendiente). */
  async getStatus(params: { orderId: string; uid: string }): Promise<NequiPaymentView> {
    this.assertConfigured();
    await this.loadOwnOrder(params.orderId, params.uid);
    return this.refresh(params.orderId, false);
  }

  /** El cliente se arrepiente (o cambia a tarjeta): anular el cobro pendiente. */
  async cancel(params: { orderId: string; uid: string }): Promise<NequiPaymentView> {
    this.assertConfigured();
    const { order } = await this.loadOwnOrder(params.orderId, params.uid);
    const rec = await this.loadRecord(params.orderId);
    if (!rec) throw new HttpException('Este pedido no tiene un cobro de Nequi', HttpStatus.NOT_FOUND);
    if (rec.state !== 'pending') return toView(rec, order.status);

    try {
      await this.client.cancelPushPayment({ phoneNumber: rec.phoneNumber, transactionId: rec.transactionId });
    } catch (err) {
      // Puede que ya lo hubiera aceptado: la consulta lo decide.
      const after = await this.refresh(params.orderId, true);
      if (after.state !== 'pending') return after;
      throw this.toHttp(err, 'No pudimos anular el cobro de Nequi.');
    }

    const now = new Date().toISOString();
    await this.closeRecord(params.orderId, 'cancelled', rec.rawStatus, now);
    return toView({ ...rec, state: 'cancelled', updatedAt: now }, order.status);
  }

  /**
   * Reversa (devuelve) un pago Nequi ya cobrado. Solo el dueño de la tienda,
   * desde el panel, y solo mientras el pedido sigue en "pagado": si ya está en
   * producción, primero hay que sacarlo de ahí a propósito.
   *
   * El pedido vuelve a "pending_payment": la plata se devolvió, así que el
   * pedido ya no está pagado. El canje del código de descuento no se descuenta
   * (redeem() es idempotente por pedido, así que si vuelve a pagar no se cuenta
   * dos veces).
   */
  async reversePayment(params: { orderId: string; ownerEmail: string }): Promise<NequiPaymentView> {
    this.assertConfigured();
    const { orderId } = params;
    if (typeof orderId !== 'string' || orderId.trim() === '') {
      throw new HttpException('Falta orderId', HttpStatus.BAD_REQUEST);
    }
    const db = getFirestore();
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) throw new HttpException('El pedido no existe', HttpStatus.NOT_FOUND);
    const order = orderSnap.data() as any;

    // En una compra de varios productos el cobro vive con el pedido principal:
    // la devolución se puede pedir desde cualquiera de ellos y los cubre a todos.
    const payKey = nequiRecordKey(orderId, order);
    const rec = await this.loadRecord(payKey);
    if (!rec || !recordOrderIds(rec).includes(orderId)) {
      throw new HttpException('Este pedido no se pagó con Nequi', HttpStatus.NOT_FOUND);
    }
    if (rec.state === 'reversed') return toView(rec, order.status);
    if (rec.state !== 'paid') {
      throw new HttpException(`El cobro de Nequi está "${rec.state}", no "paid": no hay nada que reversar.`, HttpStatus.CONFLICT);
    }

    const ids = recordOrderIds(rec);
    const refs = ids.map(id => db.collection('orders').doc(id));
    const all = await Promise.all(refs.map(r => r.get()));
    const notPaid = ids.filter((_, i) => (all[i].data() as any)?.status !== 'paid');
    if (notPaid.length > 0) {
      throw new HttpException(
        ids.length > 1
          ? `La devolución cubre los ${ids.length} pedidos de la compra y no todos están en "Pagado" ` +
            `(${notPaid.map(id => `#${id.slice(0, 8)}`).join(', ')}). Solo se reversan compras con todos sus pedidos en "Pagado".`
          : `El pedido está en "${order.status}". Solo se reversan pedidos en "Pagado".`,
        HttpStatus.CONFLICT,
      );
    }
    if (!rec.messageId) {
      throw new HttpException(
        'Este cobro es anterior a la reversión automática y no guardó su MessageID: hay que reversarlo desde el portal de Nequi Negocios.',
        HttpStatus.CONFLICT,
      );
    }

    try {
      await this.client.reverseTransaction({ phoneNumber: rec.phoneNumber, value: rec.value, messageId: rec.messageId });
    } catch (err) {
      throw this.toHttp(err, 'Nequi no aceptó la reversión.');
    }

    const now = new Date().toISOString();
    await db.runTransaction(async tx => {
      const fresh = await Promise.all(refs.map(r => tx.get(r)));
      tx.update(db.collection(PAYMENTS).doc(payKey), {
        state: 'reversed',
        reversedAt: now,
        reversedBy: params.ownerEmail,
        updatedAt: now,
      });
      refs.forEach((ref, i) => {
        tx.update(ref, {
          // Si mientras tanto alguien lo movió de "paid", no se le cambia el estado.
          ...((fresh[i].data() as any)?.status === 'paid' ? { status: 'pending_payment' } : {}),
          nequiState: 'reversed',
          updatedAt: now,
        });
      });
    });
    this.logger.log(
      `↩️ Pago Nequi de ${ids.length > 1 ? `la compra ${ids.join(', ')}` : `el pedido ${payKey}`} ` +
      `reversado por ${params.ownerEmail} (${rec.value} COP).`,
    );
    return toView({ ...rec, state: 'reversed', updatedAt: now }, 'pending_payment');
  }

/**
   * Revisa todos los cobros pendientes. Lo llama Cloud Scheduler para cerrar
   * los pedidos cuyo cliente pagó y cerró la pestaña antes de que el navegador
   * lo viera.
   */
  async reconcilePending(limit = 50): Promise<{ checked: number; paid: number; closed: number }> {
    this.assertConfigured();
    const snap = await getFirestore().collection(PAYMENTS).where('state', '==', 'pending').limit(limit).get();

    let paid = 0;
    let closed = 0;
    for (const doc of snap.docs) {
      try {
        const view = await this.refresh(doc.id, true);
        if (view.state === 'paid') paid++;
        else if (view.state !== 'pending') closed++;
      } catch (err) {
        this.logger.warn(`Reconciliación: el pedido ${doc.id} falló: ${describe(err)}`);
      }
    }
    return { checked: snap.size, paid, closed };
  }

  // ---------------------------------------------------------------------------

  /**
   * Consulta a Nequi y aplica el resultado. Si el pago se completó, marca el
   * pedido como pagado (una sola vez) y cuenta el canje del código.
   */
  private async refresh(orderId: string, force: boolean): Promise<NequiPaymentView> {
    const db = getFirestore();
    const orderRef = db.collection('orders').doc(orderId);
    const payRef = db.collection(PAYMENTS).doc(orderId);
    const [orderSnap, rec] = await Promise.all([orderRef.get(), this.loadRecord(orderId)]);
    const order = (orderSnap.data() as any) ?? {};
    if (!rec) throw new HttpException('Este pedido no tiene un cobro de Nequi', HttpStatus.NOT_FOUND);
    if (rec.state !== 'pending') return toView(rec, order.status);

    const last = this.lastCheck.get(orderId) ?? 0;
    if (!force && Date.now() - last < MIN_CHECK_INTERVAL_MS) return toView(rec, order.status);
    this.lastCheck.set(orderId, Date.now());

    let result: Awaited<ReturnType<NequiClient['getPaymentStatus']>>;
    try {
      result = await this.client.getPaymentStatus(rec.transactionId);
    } catch (err) {
      // Un fallo al consultar no cambia nada: el cobro sigue pendiente.
      this.logger.warn(`No se pudo consultar el cobro ${rec.transactionId} (pedido ${orderId}): ${describe(err)}`);
      return toView(rec, order.status);
    }

    const now = new Date().toISOString();
    if (result.state === 'pending') {
      await payRef.update({ checkedAt: now, rawStatus: result.rawStatus });
      return toView({ ...rec, checkedAt: now, rawStatus: result.rawStatus }, order.status);
    }

    if (result.state !== 'paid') {
      await this.closeRecord(orderId, result.state, result.rawStatus, now);
      this.logger.log(`Cobro ${rec.transactionId} (pedido ${orderId}) terminó como ${result.state}.`);
      return toView({ ...rec, state: result.state, rawStatus: result.rawStatus, updatedAt: now }, order.status);
    }

    if (result.value != null && Math.round(result.value) !== Math.round(rec.value)) {
      // No debería pasar (el monto lo fijamos nosotros), pero si pasa que quede a la vista.
      this.logger.warn(`⚠️ Pedido ${orderId}: Nequi reporta ${result.value} COP pagados y se cobraron ${rec.value}.`);
    }

    // Transacción: dos consultas simultáneas (navegador + reconciliación) no
    // deben marcar el pedido dos veces ni contar dos canjes.
    // Todos los pedidos que cubre el cobro (varios si fue una compra de carrito).
    const orderRefs = recordOrderIds(rec).map(id => db.collection('orders').doc(id));
    const firstTime = await db.runTransaction(async tx => {
      const [freshPay, ...freshOrders] = await Promise.all([tx.get(payRef), ...orderRefs.map(r => tx.get(r))]);
      if ((freshPay.data() as any)?.state === 'paid') return false;
      tx.update(payRef, {
        state: 'paid',
        rawStatus: result.rawStatus,
        nequiTrnId: result.trnId,
        paidValue: result.value,
        checkedAt: now,
        updatedAt: now,
      });
      orderRefs.forEach((ref, i) => {
        const currentStatus = (freshOrders[i].data() as any)?.status;
        tx.update(ref, {
          // Si el dueño ya lo pasó a producción no se le retrocede el estado.
          status: NON_PAYABLE_STATUSES.has(currentStatus) ? currentStatus : 'paid',
          paymentMethod: 'nequi',
          nequiState: 'paid',
          updatedAt: now,
        });
      });
      return true;
    });

    if (firstTime) {
      this.logger.log(
        `✅ Pedido ${orderId}${orderRefs.length > 1 ? ` y los otros ${orderRefs.length - 1} de su compra` : ''} ` +
        `pagado con Nequi (tx ${rec.transactionId}).`,
      );
      // En una compra de varios productos, correo y canje van solo con el principal.
      // Correo de confirmación de compra (si está activado; notify() no lanza).
      await this.orderEmails.notify(orderId, 'paid');
      // Igual que en el webhook de Stripe: el canje se cuenta al confirmar el
      // pago. redeem() es idempotente por pedido.
      if (order.discountCode) {
        try {
          const r = await this.discountsService.redeem(order.discountCode, order.userId || null, orderId);
          if (r.overLimit) {
            this.logger.warn(`⚠️ El pedido ${orderId} usó ${order.discountCode} por encima de sus límites.`);
          }
        } catch (err) {
          this.logger.error(`No se pudo contar el canje de ${order.discountCode} en ${orderId}: ${describe(err)}`);
        }
      }
    }

    return toView({ ...rec, state: 'paid', updatedAt: now }, 'paid');
  }

  private async closeRecord(orderId: string, state: NequiPaymentState, rawStatus: string | null, now: string) {
    const db = getFirestore();
    const rec = await this.loadRecord(orderId);
    await db.collection(PAYMENTS).doc(orderId).update({ state, rawStatus, checkedAt: now, updatedAt: now });
    const batch = db.batch();
    for (const id of rec ? recordOrderIds(rec) : [orderId]) {
      batch.update(db.collection('orders').doc(id), { nequiState: state, updatedAt: now });
    }
    await batch.commit();
  }

  private async loadRecord(orderId: string): Promise<NequiPaymentRecord | null> {
    const snap = await getFirestore().collection(PAYMENTS).doc(orderId).get();
    const rec = snap.data() as NequiPaymentRecord | undefined;
    return rec?.transactionId ? rec : null;
  }

  private async loadOwnOrder(orderId: string, uid: string) {
    if (typeof orderId !== 'string' || orderId.trim() === '') {
      throw new HttpException('Falta orderId', HttpStatus.BAD_REQUEST);
    }
    const snap = await getFirestore().collection('orders').doc(orderId).get();
    if (!snap.exists) throw new HttpException('El pedido no existe', HttpStatus.NOT_FOUND);
    const order = snap.data() as any;
    if (order.userId !== uid) {
      this.logger.warn(`Usuario ${uid} intentó operar el pedido ${orderId} de ${order.userId}.`);
      throw new HttpException('El pedido no te pertenece', HttpStatus.FORBIDDEN);
    }
    return { order };
  }

  private assertConfigured() {
    if (!this.client.configured) {
      throw new HttpException('El pago con Nequi no está disponible por ahora.', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  private toHttp(err: unknown, fallback: string): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof NequiNotConfiguredError) {
      return new HttpException('El pago con Nequi no está disponible por ahora.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (err instanceof NequiApiError) {
      this.logger.warn(`Nequi: ${err.message} (código ${err.statusCode ?? '-'}, HTTP ${err.httpStatus ?? '-'})`);
      // Error de negocio (p. ej. "el celular no tiene Nequi"): el texto de
      // Nequi le sirve al cliente. Error técnico: mensaje genérico.
      if (err.statusCode && err.statusCode !== '0') {
        return new HttpException(`${fallback} Nequi dice: ${err.message}`, HttpStatus.BAD_REQUEST);
      }
      return new HttpException(`${fallback} Inténtalo de nuevo en unos minutos.`, HttpStatus.BAD_GATEWAY);
    }
    this.logger.error(`${fallback} ${describe(err)}`);
    return new HttpException(`${fallback} Inténtalo de nuevo en unos minutos.`, HttpStatus.BAD_GATEWAY);
  }
}

/** Pedidos que cubre un cobro: los de la compra, o solo el suyo (registros de un pedido). */
export function recordOrderIds(rec: Pick<NequiPaymentRecord, 'orderId' | 'orderIds'>): string[] {
  return Array.isArray(rec.orderIds) && rec.orderIds.length > 0 ? rec.orderIds : [rec.orderId];
}

/**
 * Dónde buscar el cobro de un pedido: en una compra de varios productos, con el
 * pedido principal. `checkoutGroup` lo escribe el cliente, así que es solo una
 * pista: quien la usa debe comprobar que el registro incluye el pedido.
 */
export function nequiRecordKey(orderId: string, order: Record<string, any> | null | undefined): string {
  const lead = order?.checkoutGroup?.leadOrderId;
  return typeof lead === 'string' && lead.trim() !== '' && !lead.includes('/') ? lead : orderId;
}

export function maskPhone(phone: string): string {
  return phone.length >= 4 ? `${phone.slice(0, 3)} *** ${phone.slice(-4)}` : '***';
}

function toView(rec: NequiPaymentRecord, orderStatus: string): NequiPaymentView {
  return {
    state: rec.state,
    phone: maskPhone(rec.phoneNumber),
    value: rec.value,
    createdAt: rec.createdAt,
    orderStatus,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
