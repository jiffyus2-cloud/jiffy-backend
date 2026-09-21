import { getFirestore } from '../firebase/firebase-admin';

/**
 * Política de almacenamiento: cuántos borradores puede tener a la vez un
 * cliente y cuánto tiempo sobreviven sin editarse.
 *
 * Vive en `settings/storage_policy` y la edita el dueño desde el panel
 * ("Gestión de almacenamiento"). Los valores de aquí abajo son SOLO el punto de
 * partida mientras nadie haya guardado nada: en cuanto existe el documento,
 * manda el documento. Este servicio nunca escribe los iniciales en Firestore
 * (misma filosofía que `settings/store_config` en el frontend).
 *
 * El frontend tiene una copia idéntica de los iniciales en
 * `src/app/utils/storagePolicyState.ts`; si cambian aquí deben cambiar allí.
 */

export interface StoragePolicy {
  /** Borradores simultáneos que puede tener un mismo usuario. */
  maxDraftsPerUser: number;
  /** Días desde la última edición tras los cuales un borrador se borra solo. */
  draftRetentionDays: number;
  /**
   * Capacidad de referencia del bucket, en GB. Cloud Storage no tiene un tope
   * real (es pago por uso), así que "disponible" se calcula contra esta cifra.
   */
  storageCapacityGb: number;
  /**
   * Fecha (ISO) desde la que rige la caducidad. La fija el panel la primera vez
   * que el dueño guarda la política. Solo vencen los borradores CREADOS después
   * de esta fecha: los que ya existían cuando se activó la regla no se tocan
   * nunca, y sin fecha no vence ninguno.
   */
  retentionAppliesFrom: string | null;
}

export const STORAGE_POLICY_DOC = 'settings/storage_policy';

export const INITIAL_STORAGE_POLICY: StoragePolicy = {
  maxDraftsPerUser: 5,
  draftRetentionDays: 90,
  storageCapacityGb: 5,
  retentionAppliesFrom: null,
};

/** Estados que cuentan como "borrador" a efectos de retención. */
export const DRAFT_STATUSES: readonly string[] = ['draft', 'saved_draft'];

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Lo guardado manda siempre que sea válido; el inicial rellena lo que falte. */
export function mergeStoragePolicy(stored: Record<string, unknown> | null | undefined): StoragePolicy {
  const data = stored ?? {};
  return {
    maxDraftsPerUser: positiveInt(data.maxDraftsPerUser, INITIAL_STORAGE_POLICY.maxDraftsPerUser),
    draftRetentionDays: positiveInt(data.draftRetentionDays, INITIAL_STORAGE_POLICY.draftRetentionDays),
    storageCapacityGb: positiveNumber(data.storageCapacityGb, INITIAL_STORAGE_POLICY.storageCapacityGb),
    retentionAppliesFrom: isoOrNull(data.retentionAppliesFrom),
  };
}

export async function readStoragePolicy(): Promise<StoragePolicy & { exists: boolean }> {
  const snap = await getFirestore().doc(STORAGE_POLICY_DOC).get();
  return { ...mergeStoragePolicy(snap.exists ? snap.data() : null), exists: snap.exists };
}
