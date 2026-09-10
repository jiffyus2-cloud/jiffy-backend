import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase-admin';

/**
 * Códigos de descuento: validación y canje.
 *
 * ESTE archivo es la autoridad. El frontend tiene una copia de las reglas para
 * pintar el estado en el panel de administración, pero el descuento que vale es
 * el que devuelve este servicio: el navegador puede mentir sobre cuántas veces
 * ha usado un código, sobre la fecha o sobre el propio código.
 *
 * El canje se cuenta cuando Stripe confirma el pago, no cuando el cliente
 * escribe el código. Así un código no se gasta por abandonar el checkout, y
 * nadie puede agotar un código ajeno a base de escribirlo.
 */

export type DiscountKind = 'percentage' | 'amount';

export interface DiscountCode {
  code: string;
  kind: DiscountKind;
  value: number;
  active: boolean;
  /** `YYYY-MM-DD`; vacío = no vence. */
  expiresOn: string;
  /** 0 = sin límite. */
  maxUses: number;
  /** 0 = sin límite. */
  maxUsesPerUser: number;
  uses: number;
}

export interface ValidationResult {
  ok: boolean;
  /** Descuento en COP, ya topado al subtotal. */
  discount: number;
  code?: string;
  kind?: DiscountKind;
  value?: number;
  reason?: string;
}

const COLLECTION = 'discount_codes';
const REDEMPTIONS = 'redemptions';

/** Mismas reglas de normalización que el panel, para que los ids coincidan. */
export function normalizeCode(raw: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);
}

/** Hoy en `YYYY-MM-DD`, en la zona horaria de Colombia (UTC-5). */
function todayInColombia(): string {
  const now = new Date();
  const bogota = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  return bogota.toISOString().slice(0, 10);
}

function toDiscountCode(id: string, data: any): DiscountCode {
  return {
    code: id,
    kind: data?.kind === 'amount' ? 'amount' : 'percentage',
    value: Number(data?.value) || 0,
    active: data?.active !== false,
    expiresOn: typeof data?.expiresOn === 'string' ? data.expiresOn : '',
    maxUses: Number(data?.maxUses) || 0,
    maxUsesPerUser: Number(data?.maxUsesPerUser) || 0,
    uses: Number(data?.uses) || 0,
  };
}

function computeDiscount(code: DiscountCode, subtotal: number): number {
  const raw = code.kind === 'percentage' ? subtotal * (code.value / 100) : code.value;
  // Nunca más que el subtotal: un código de 50.000 sobre 30.000 descuenta 30.000.
  return Math.max(0, Math.min(Math.round(raw), Math.round(subtotal)));
}

/** Motivo por el que NO se puede canjear, o null si sí se puede. */
function rejectionReason(code: DiscountCode, usesByUser: number, today: string): string | null {
  if (!code.active) return 'Este código ya no está disponible.';
  if (code.expiresOn && code.expiresOn < today) return 'Este código ya venció.';
  if (code.maxUses > 0 && code.uses >= code.maxUses) return 'Este código ya llegó a su límite de usos.';
  if (code.maxUsesPerUser > 0 && usesByUser >= code.maxUsesPerUser) {
    return 'Ya usaste este código el máximo de veces permitido.';
  }
  return null;
}

@Injectable()
export class DiscountsService {
  /**
   * ¿Vale este código, para este cliente, sobre este subtotal?
   *
   * No escribe nada: solo responde. El canje se confirma después, cuando el
   * pago llega.
   */
  async validate(rawCode: string, subtotal: number, uid: string | null): Promise<ValidationResult> {
    const id = normalizeCode(rawCode);
    if (id.length < 3) return { ok: false, discount: 0, reason: 'Escribe un código válido.' };

    const amount = Number(subtotal);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, discount: 0, reason: 'No hay nada a lo que aplicar el descuento.' };
    }

    let snapshot: admin.firestore.DocumentSnapshot;
    let usesByUser = 0;
    try {
      const db = getFirestore();
      snapshot = await db.collection(COLLECTION).doc(id).get();
      // Un fallo de Firestore (credenciales, red, permisos) no puede salir como
      // un 500 sin explicación: el cliente está esperando en la caja.
      if (snapshot.exists && uid) usesByUser = await this.countUserRedemptions(db, id, uid);
    } catch (error: any) {
      console.error('[Códigos] Firestore no respondió al validar:', error.message);
      return { ok: false, discount: 0, reason: 'No pudimos validar el código en este momento.' };
    }

    if (!snapshot.exists) {
      return { ok: false, discount: 0, reason: 'Ese código no existe.' };
    }

    const code = toDiscountCode(snapshot.id, snapshot.data());

    // Sin sesión no se puede llevar la cuenta por cliente, así que un código con
    // ese límite exige iniciar sesión en vez de dejarse canjear sin control.
    if (!uid && code.maxUsesPerUser > 0) {
      return { ok: false, discount: 0, reason: 'Inicia sesión para usar este código.' };
    }

    const reason = rejectionReason(code, usesByUser, todayInColombia());
    if (reason) return { ok: false, discount: 0, reason };

    return {
      ok: true,
      discount: computeDiscount(code, amount),
      code: code.code,
      kind: code.kind,
      value: code.value,
    };
  }

  private async countUserRedemptions(
    db: admin.firestore.Firestore,
    codeId: string,
    uid: string
  ): Promise<number> {
    const doc = await db.collection(COLLECTION).doc(codeId).collection(REDEMPTIONS).doc(uid).get();
    return doc.exists ? Number(doc.data()?.count) || 0 : 0;
  }

  /**
   * Cuenta un canje ya pagado. Lo llama el webhook de Stripe.
   *
   * Va en transacción y es idempotente por pedido: Stripe reintenta sus webhooks
   * y sin esto un mismo pago gastaría dos usos del código. Si el pedido ya está
   * registrado en el canje, no vuelve a sumar.
   */
  async redeem(rawCode: string, uid: string | null, orderId: string): Promise<{ counted: boolean; overLimit: boolean }> {
    const db = getFirestore();
    const id = normalizeCode(rawCode);
    if (id.length < 3) return { counted: false, overLimit: false };

    const codeRef = db.collection(COLLECTION).doc(id);
    const userRef = uid ? codeRef.collection(REDEMPTIONS).doc(uid) : null;
    const orderRef = codeRef.collection('orders').doc(orderId);

    return db.runTransaction(async tx => {
      const [codeSnap, orderSnap, userSnap] = await Promise.all([
        tx.get(codeRef),
        tx.get(orderRef),
        userRef ? tx.get(userRef) : Promise.resolve(null),
      ]);

      if (!codeSnap.exists) return { counted: false, overLimit: false };
      // Este pedido ya se contó: reintento de Stripe, no un canje nuevo.
      if (orderSnap.exists) return { counted: false, overLimit: false };

      const code = toDiscountCode(codeSnap.id, codeSnap.data());
      const usesByUser = userSnap && userSnap.exists ? Number(userSnap.data()?.count) || 0 : 0;

      // El pago ya se cobró con el descuento aplicado, así que el canje se
      // registra igualmente; si se pasó de los topes se marca para que la
      // administración lo vea en lugar de perder el rastro.
      const overLimit = rejectionReason(code, usesByUser, todayInColombia()) !== null;

      tx.update(codeRef, { uses: admin.firestore.FieldValue.increment(1) });
      if (userRef) {
        tx.set(
          userRef,
          {
            count: admin.firestore.FieldValue.increment(1),
            lastOrderId: orderId,
            lastRedeemedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      }
      tx.set(orderRef, {
        uid: uid || null,
        redeemedAt: new Date().toISOString(),
        overLimit,
      });

      return { counted: true, overLimit };
    });
  }
}
