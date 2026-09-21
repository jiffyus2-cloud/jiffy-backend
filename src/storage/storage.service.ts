import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase-admin';
import { DRAFT_STATUSES, StoragePolicy, readStoragePolicy } from './storage-policy';

/**
 * Gestión de almacenamiento: cuánto ocupa el bucket, quién lo consume y
 * limpieza de borradores vencidos.
 *
 * Las fotos viven en Cloud Storage bajo `orders/{uid}/{orderId}/...` y las
 * imágenes de la tienda bajo `system_images/`. Firestore solo guarda las URLs,
 * así que el tamaño real hay que sumarlo recorriendo el bucket, cosa que solo
 * puede hacer el SDK de administrador (las reglas no dejan listar a nadie que
 * no sea el dueño, y desde el navegador sería lentísimo).
 *
 * El recorrido completo es la operación cara, por eso el resultado se cachea
 * unos minutos en memoria; el panel puede forzar un recálculo con `refresh`.
 */

export interface ProjectUsage {
  orderId: string;
  userId: string;
  bytes: number;
  files: number;
  /** null cuando la carpeta existe en Storage pero el pedido ya no está en Firestore. */
  status: string | null;
  productType: string | null;
  productName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  createdAt: string | null;
  /** Última edición del pedido (updatedAt, o createdAt si no hay). */
  lastEditedAt: string | null;
  /** Última escritura en Storage dentro de la carpeta. */
  lastFileAt: string | null;
}

export interface UserUsage {
  userId: string;
  name: string | null;
  email: string | null;
  bytes: number;
  files: number;
  projects: number;
  drafts: number;
}

interface Usage {
  bytes: number;
  files: number;
}

export interface StorageStats {
  computedAt: string;
  fromCache: boolean;
  bucket: string;
  policy: StoragePolicy & { exists: boolean };
  totals: {
    bytes: number;
    files: number;
    capacityBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
  breakdown: {
    drafts: Usage & { count: number };
    orders: Usage & { count: number };
    systemImages: Usage;
    orphans: Usage & { count: number };
    inProgress: Usage & { count: number };
    other: Usage;
  };
  expiredDrafts: {
    count: number;
    bytes: number;
    cutoff: string;
    retentionDays: number;
    /** null = caducidad no activada: no vence ningún borrador. */
    appliesFrom: string | null;
  };
  topProjects: ProjectUsage[];
  topUsers: UserUsage[];
  orphans: ProjectUsage[];
  lastCleanup: CleanupSummary | null;
}

export interface CleanupOptions {
  dryRun: boolean;
  expiredDrafts: boolean;
  orphans: boolean;
  trigger: 'panel' | 'scheduler';
}

export interface CleanupSummary {
  at: string;
  dryRun: boolean;
  trigger: string;
  retentionDays: number;
  cutoff: string;
  appliesFrom: string | null;
  expiredDrafts: { count: number; bytes: number };
  orphans: { count: number; bytes: number };
  errors: string[];
}

export interface CleanupResult extends CleanupSummary {
  expiredDrafts: { count: number; bytes: number; items: ProjectUsage[] };
  orphans: { count: number; bytes: number; items: ProjectUsage[] };
}

const STORAGE_STATUS_DOC = 'settings/storage_status';
const STATS_CACHE_MS = 5 * 60 * 1000;
const TOP_N = 10;
/**
 * Una carpeta sin pedido en Firestore puede ser una subida en curso:
 * `createDraftOrder` sube las fotos ANTES de crear el documento. Solo se
 * considera huérfana si nadie ha escrito en ella desde hace más de esto.
 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;

interface OrderMeta {
  userId: string | null;
  status: string | null;
  productType: string | null;
  productName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  createdAt: string | null;
  lastEditedAt: string | null;
}

interface FolderUsage extends Usage {
  lastFileMs: number;
}

type StorageBucket = ReturnType<admin.storage.Storage['bucket']>;

@Injectable()
export class StorageService {
  private cache: { stats: StorageStats; at: number } | null = null;
  private inFlight: Promise<StorageStats> | null = null;

  async getStats(refresh = false): Promise<StorageStats> {
    if (!refresh && this.cache && Date.now() - this.cache.at < STATS_CACHE_MS) {
      return { ...this.cache.stats, fromCache: true };
    }
    // Dos peticiones a la vez no deben recorrer el bucket dos veces.
    if (!this.inFlight) {
      this.inFlight = this.computeStats().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  invalidate(): void {
    this.cache = null;
  }

  // ── Recorrido del bucket ────────────────────────────────────────────────────

  private resolveBucket(): StorageBucket {
    const explicit = (process.env.FIREBASE_STORAGE_BUCKET || process.env.VITE_FIREBASE_STORAGE_BUCKET || '').trim();
    const projectId = (process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '').trim();
    const name = explicit || (projectId ? `${projectId}.firebasestorage.app` : '');
    if (!name) {
      throw new ServiceUnavailableException(
        'No sé qué bucket recorrer: define FIREBASE_STORAGE_BUCKET (o FIREBASE_PROJECT_ID) en el backend.',
      );
    }
    return admin.storage().bucket(name);
  }

  private async computeStats(): Promise<StorageStats> {
    const bucket = this.resolveBucket();
    const [policy, orders, users] = await Promise.all([
      readStoragePolicy(),
      this.loadOrders(),
      this.loadUsers(),
    ]);

    const folders = new Map<string, FolderUsage>(); // `${uid}/${orderId}`
    const systemImages: Usage = { bytes: 0, files: 0 };
    const other: Usage = { bytes: 0, files: 0 };

    let pageToken: string | undefined;
    do {
      const [files, nextQuery] = await bucket.getFiles({
        autoPaginate: false,
        maxResults: PAGE_SIZE,
        pageToken,
      });
      for (const file of files) {
        const size = Number(file.metadata?.size ?? 0) || 0;
        const updatedMs = Date.parse(String(file.metadata?.updated ?? '')) || 0;
        const parts = file.name.split('/');
        if (parts[0] === 'orders' && parts.length >= 4 && parts[1] && parts[2]) {
          const key = `${parts[1]}/${parts[2]}`;
          const folder = folders.get(key) ?? { bytes: 0, files: 0, lastFileMs: 0 };
          folder.bytes += size;
          folder.files += 1;
          folder.lastFileMs = Math.max(folder.lastFileMs, updatedMs);
          folders.set(key, folder);
        } else if (parts[0] === 'system_images') {
          systemImages.bytes += size;
          systemImages.files += 1;
        } else {
          other.bytes += size;
          other.files += 1;
        }
      }
      pageToken = (nextQuery as { pageToken?: string } | null)?.pageToken;
    } while (pageToken);

    // ── Cruce con Firestore ──────────────────────────────────────────────────
    const now = Date.now();
    const projects: ProjectUsage[] = [];
    const seenOrders = new Set<string>();

    for (const [key, folder] of folders) {
      const [userId, orderId] = key.split('/');
      const meta = orders.get(orderId) ?? null;
      seenOrders.add(orderId);
      projects.push({
        orderId,
        userId: meta?.userId ?? userId,
        bytes: folder.bytes,
        files: folder.files,
        status: meta?.status ?? null,
        productType: meta?.productType ?? null,
        productName: meta?.productName ?? null,
        customerName: meta?.customerName ?? null,
        customerEmail: meta?.customerEmail ?? null,
        createdAt: meta?.createdAt ?? null,
        lastEditedAt: meta?.lastEditedAt ?? null,
        lastFileAt: folder.lastFileMs ? new Date(folder.lastFileMs).toISOString() : null,
      });
    }
    // Pedidos que existen en Firestore pero no tienen carpeta (o quedaron sin fotos).
    for (const [orderId, meta] of orders) {
      if (seenOrders.has(orderId) || !meta.userId) continue;
      projects.push({
        orderId,
        userId: meta.userId,
        bytes: 0,
        files: 0,
        status: meta.status,
        productType: meta.productType,
        productName: meta.productName,
        customerName: meta.customerName,
        customerEmail: meta.customerEmail,
        createdAt: meta.createdAt,
        lastEditedAt: meta.lastEditedAt,
        lastFileAt: null,
      });
    }

    const drafts = { bytes: 0, files: 0, count: 0 };
    const paid = { bytes: 0, files: 0, count: 0 };
    const orphans = { bytes: 0, files: 0, count: 0 };
    const inProgress = { bytes: 0, files: 0, count: 0 };
    const orphanList: ProjectUsage[] = [];

    const cutoffMs = now - policy.draftRetentionDays * 24 * 60 * 60 * 1000;
    const appliesFromMs = Date.parse(policy.retentionAppliesFrom ?? '');
    const expired = { count: 0, bytes: 0 };

    const byUser = new Map<string, UserUsage>();

    for (const project of projects) {
      const isOrphan = !orders.has(project.orderId);
      if (isOrphan) {
        const lastMs = Date.parse(project.lastFileAt ?? '') || 0;
        const target = now - lastMs > ORPHAN_GRACE_MS ? orphans : inProgress;
        target.bytes += project.bytes;
        target.files += project.files;
        target.count += 1;
        if (target === orphans) orphanList.push(project);
      } else if (DRAFT_STATUSES.includes(project.status ?? '')) {
        drafts.bytes += project.bytes;
        drafts.files += project.files;
        drafts.count += 1;
        if (isExpired(project, cutoffMs, appliesFromMs)) {
          expired.count += 1;
          expired.bytes += project.bytes;
        }
      } else {
        paid.bytes += project.bytes;
        paid.files += project.files;
        paid.count += 1;
      }

      const profile = users.get(project.userId);
      const usage = byUser.get(project.userId) ?? {
        userId: project.userId,
        name: profile?.name ?? project.customerName ?? null,
        email: profile?.email ?? project.customerEmail ?? null,
        bytes: 0,
        files: 0,
        projects: 0,
        drafts: 0,
      };
      usage.bytes += project.bytes;
      usage.files += project.files;
      usage.projects += 1;
      if (DRAFT_STATUSES.includes(project.status ?? '')) usage.drafts += 1;
      if (!usage.name && project.customerName) usage.name = project.customerName;
      if (!usage.email && project.customerEmail) usage.email = project.customerEmail;
      byUser.set(project.userId, usage);
    }

    const totalBytes =
      drafts.bytes + paid.bytes + orphans.bytes + inProgress.bytes + systemImages.bytes + other.bytes;
    const totalFiles =
      drafts.files + paid.files + orphans.files + inProgress.files + systemImages.files + other.files;
    const capacityBytes = Math.round(policy.storageCapacityGb * 1024 ** 3);

    const stats: StorageStats = {
      computedAt: new Date(now).toISOString(),
      fromCache: false,
      bucket: bucket.name,
      policy,
      totals: {
        bytes: totalBytes,
        files: totalFiles,
        capacityBytes,
        availableBytes: Math.max(0, capacityBytes - totalBytes),
        usedPercent: capacityBytes > 0 ? Math.min(100, (totalBytes / capacityBytes) * 100) : 0,
      },
      breakdown: { drafts, orders: paid, systemImages, orphans, inProgress, other },
      expiredDrafts: {
        ...expired,
        cutoff: new Date(cutoffMs).toISOString(),
        retentionDays: policy.draftRetentionDays,
        appliesFrom: policy.retentionAppliesFrom,
      },
      topProjects: projects
        .filter(p => p.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, TOP_N),
      topUsers: [...byUser.values()].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_N),
      orphans: orphanList.sort((a, b) => b.bytes - a.bytes),
      lastCleanup: await this.readLastCleanup(),
    };

    this.cache = { stats, at: now };
    return stats;
  }

  private async loadOrders(): Promise<Map<string, OrderMeta>> {
    // `select` evita traer páginas y fotos: solo los campos que necesitamos.
    const snap = await getFirestore()
      .collection('orders')
      .select('userId', 'status', 'productType', 'product.name', 'customerName', 'customerEmail', 'createdAt', 'updatedAt')
      .get();
    const map = new Map<string, OrderMeta>();
    snap.forEach(doc => {
      const d = doc.data() as Record<string, any>;
      const createdAt = toIso(d.createdAt);
      map.set(doc.id, {
        userId: d.userId ?? null,
        status: d.status ?? null,
        productType: d.productType ?? null,
        productName: d.product?.name ?? null,
        customerName: d.customerName ?? null,
        customerEmail: d.customerEmail ?? null,
        createdAt,
        lastEditedAt: toIso(d.updatedAt) ?? createdAt,
      });
    });
    return map;
  }

  private async loadUsers(): Promise<Map<string, { name: string | null; email: string | null }>> {
    const snap = await getFirestore().collection('users').select('name', 'email').get();
    const map = new Map<string, { name: string | null; email: string | null }>();
    snap.forEach(doc => {
      const d = doc.data() as Record<string, any>;
      map.set(doc.id, { name: d.name ?? null, email: d.email ?? null });
    });
    return map;
  }

  private async readLastCleanup(): Promise<CleanupSummary | null> {
    const snap = await getFirestore().doc(STORAGE_STATUS_DOC).get();
    return snap.exists ? ((snap.data() as Record<string, any>).lastCleanup ?? null) : null;
  }

  // ── Limpieza ────────────────────────────────────────────────────────────────

  async cleanup(options: CleanupOptions): Promise<CleanupResult> {
    const stats = await this.getStats(true);
    const bucket = this.resolveBucket();
    const errors: string[] = [];
    const cutoffMs = Date.parse(stats.expiredDrafts.cutoff);
    const appliesFromMs = Date.parse(stats.expiredDrafts.appliesFrom ?? '');

    // Borradores vencidos: se recalculan desde la lista completa de pedidos,
    // no desde el top-10 que expone `stats`.
    const expiredItems: ProjectUsage[] = [];
    if (options.expiredDrafts) {
      const orders = await this.loadOrders();
      const byFolder = new Map(stats.topProjects.map(p => [p.orderId, p]));
      for (const [orderId, meta] of orders) {
        if (!DRAFT_STATUSES.includes(meta.status ?? '')) continue;
        const candidate: ProjectUsage = byFolder.get(orderId) ?? {
          orderId,
          userId: meta.userId ?? '',
          bytes: 0,
          files: 0,
          status: meta.status,
          productType: meta.productType,
          productName: meta.productName,
          customerName: meta.customerName,
          customerEmail: meta.customerEmail,
          createdAt: meta.createdAt,
          lastEditedAt: meta.lastEditedAt,
          lastFileAt: null,
        };
        if (!byFolder.has(orderId) && candidate.userId) {
          // Fuera del top no conocemos la carpeta: se mide para decidir y para informar.
          const usage = await this.measureFolder(bucket, `orders/${candidate.userId}/${orderId}/`);
          candidate.bytes = usage.bytes;
          candidate.files = usage.files;
          candidate.lastFileAt = usage.lastFileMs ? new Date(usage.lastFileMs).toISOString() : null;
        }
        if (isExpired(candidate, cutoffMs, appliesFromMs)) expiredItems.push(candidate);
      }
    }

    const orphanItems = options.orphans ? stats.orphans : [];

    if (!options.dryRun) {
      const db = getFirestore();
      for (const item of expiredItems) {
        try {
          if (item.userId) {
            await bucket.deleteFiles({ prefix: `orders/${item.userId}/${item.orderId}/`, force: true });
          }
          await db.collection('orders').doc(item.orderId).delete();
        } catch (error: any) {
          errors.push(`borrador ${item.orderId}: ${error?.message ?? error}`);
        }
      }
      for (const item of orphanItems) {
        try {
          await bucket.deleteFiles({ prefix: `orders/${item.userId}/${item.orderId}/`, force: true });
        } catch (error: any) {
          errors.push(`carpeta ${item.userId}/${item.orderId}: ${error?.message ?? error}`);
        }
      }
    }

    const result: CleanupResult = {
      at: new Date().toISOString(),
      dryRun: options.dryRun,
      trigger: options.trigger,
      retentionDays: stats.expiredDrafts.retentionDays,
      cutoff: stats.expiredDrafts.cutoff,
      appliesFrom: stats.expiredDrafts.appliesFrom,
      expiredDrafts: {
        count: expiredItems.length,
        bytes: expiredItems.reduce((sum, p) => sum + p.bytes, 0),
        items: expiredItems,
      },
      orphans: {
        count: orphanItems.length,
        bytes: orphanItems.reduce((sum, p) => sum + p.bytes, 0),
        items: orphanItems,
      },
      errors,
    };

    if (!options.dryRun) {
      this.invalidate();
      // Se guarda el resumen sin la lista detallada: el panel solo necesita
      // saber cuándo corrió y cuánto liberó.
      const summary: CleanupSummary = {
        ...result,
        expiredDrafts: { count: result.expiredDrafts.count, bytes: result.expiredDrafts.bytes },
        orphans: { count: result.orphans.count, bytes: result.orphans.bytes },
      };
      await getFirestore().doc(STORAGE_STATUS_DOC).set({ lastCleanup: summary }, { merge: true });
      console.log(
        `[storage] Limpieza (${options.trigger}): ${result.expiredDrafts.count} borradores y ` +
          `${result.orphans.count} carpetas huérfanas, ${result.expiredDrafts.bytes + result.orphans.bytes} bytes` +
          (errors.length ? `, ${errors.length} errores` : ''),
      );
    }

    return result;
  }

  private async measureFolder(bucket: StorageBucket, prefix: string): Promise<FolderUsage> {
    const [files] = await bucket.getFiles({ prefix });
    const usage: FolderUsage = { bytes: 0, files: 0, lastFileMs: 0 };
    for (const file of files) {
      usage.bytes += Number(file.metadata?.size ?? 0) || 0;
      usage.files += 1;
      usage.lastFileMs = Math.max(usage.lastFileMs, Date.parse(String(file.metadata?.updated ?? '')) || 0);
    }
    return usage;
  }
}

/**
 * Un borrador vence cuando su última edición es anterior al corte, PERO solo si
 * fue creado después de activarse la caducidad (`appliesFromMs`). Los que ya
 * existían al activarla no vencen nunca, y sin fecha de activación, de creación
 * o de edición no se toca ninguno: ante la duda, se conserva.
 */
export function isExpired(
  project: Pick<ProjectUsage, 'createdAt' | 'lastEditedAt' | 'lastFileAt'>,
  cutoffMs: number,
  appliesFromMs: number,
): boolean {
  if (!Number.isFinite(appliesFromMs)) return false;
  const createdMs = Date.parse(project.createdAt ?? '');
  if (!Number.isFinite(createdMs) || createdMs < appliesFromMs) return false;
  const editedMs = Date.parse(project.lastEditedAt ?? '');
  if (!Number.isFinite(editedMs)) return false;
  // Si alguien subió fotos después de la última edición registrada, cuenta la subida.
  const fileMs = Date.parse(project.lastFileAt ?? '') || 0;
  return Math.max(editedMs, fileMs) < cutoffMs;
}

/** ISO string desde un ISO string, un Timestamp de Firestore o un Date. */
export function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return Number.isFinite(Date.parse(value)) ? value : null;
  if (value instanceof Date) return value.toISOString();
  const ts = value as { toDate?: () => Date; seconds?: number };
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000).toISOString();
  return null;
}
