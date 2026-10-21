/**
 * Fotos sueltas: archivos dentro de la carpeta de un pedido VIVO que ya no
 * aparecen en ningún pedido de Firestore.
 *
 * Nacen cuando el cliente quita o cambia una foto en el editor: al guardar, el
 * documento deja de nombrarla, pero el archivo se queda en Storage (cada subida
 * tiene ruta única, así que nada lo pisa ni lo borra). La limpieza de carpetas
 * huérfanas no las ve porque la carpeta sigue teniendo pedido.
 *
 * Todo aquí es puro para poder testearlo sin bucket ni Firestore.
 */

export interface BucketFile {
  /** Ruta completa del objeto: `orders/{uid}/{orderId}/...`. */
  path: string;
  bytes: number;
  updatedMs: number;
}

export interface LooseFolder {
  orderId: string;
  userId: string;
  status: string | null;
  customerName: string | null;
  customerEmail: string | null;
  files: number;
  bytes: number;
  /** Archivos que se borrarían. Solo viaja en la respuesta de la limpieza. */
  paths?: string[];
}

export interface SkippedFolder {
  orderId: string;
  userId: string;
  files: number;
  bytes: number;
  reason: string;
}

export interface LooseScan {
  folders: LooseFolder[];
  skipped: SkippedFolder[];
}

/**
 * Margen antes de dar una foto por suelta. El editor guarda en memoria (y en el
 * borrador de invitado en IndexedDB) la equivalencia `blob:` → URL de Storage de
 * lo que ya subió; si el cliente quita una foto y luego la vuelve a poner, el
 * siguiente guardado reutiliza esa URL sin resubir. Un archivo recién dejado de
 * usar puede volver, así que solo se toca pasado este tiempo sin escribirse.
 */
export const LOOSE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rutas de objeto (`orders/uid/id/...`) a las que apunta un pedido. Las URLs de
 * descarga llevan la ruta codificada (`/o/orders%2Fuid%2Fid%2Fphotos%2Fx?alt=...`);
 * las rutas `gs://` o relativas van sin codificar.
 */
export function referencedFiles(order: Record<string, unknown>): Set<string> {
  const json = JSON.stringify(order);
  const paths = new Set<string>();
  // La ruta termina en el query string, en el cierre de la cadena JSON o en un espacio.
  const pattern = /orders(?:%2F|\\?\/)[^?"&#\s]+/g;
  for (const m of json.matchAll(pattern)) {
    const raw = m[0].replace(/\\\//g, '/');
    try {
      paths.add(decodeURIComponent(raw));
    } catch {
      paths.add(raw);
    }
  }
  return paths;
}

interface FolderMeta {
  status: string | null;
  customerName: string | null;
  customerEmail: string | null;
}

/**
 * Busca las fotos sueltas de las carpetas vivas.
 *
 * @param folders   archivos de cada carpeta `uid/orderId` del bucket.
 * @param live      carpetas que NO son huérfanas (tienen pedido o las usa otro
 *                  pedido vivo), con los datos del pedido para informar.
 * @param referenced rutas nombradas por cualquier pedido de Firestore.
 */
export function findLooseFiles(
  folders: Map<string, BucketFile[]>,
  live: Map<string, FolderMeta>,
  referenced: Set<string>,
  nowMs: number,
  graceMs = LOOSE_GRACE_MS,
): LooseScan {
  const result: LooseScan = { folders: [], skipped: [] };

  for (const [key, files] of folders) {
    const meta = live.get(key);
    if (!meta) continue; // huérfana: la cubre la limpieza de carpetas
    const [userId, orderId] = key.split('/');

    const unreferenced = files.filter(f => !referenced.has(f.path));
    if (unreferenced.length === 0) continue;

    // Freno de seguridad: si NINGÚN archivo de la carpeta de un pedido vivo está
    // referenciado, lo más probable es que no estemos leyendo bien sus URLs
    // (formato nuevo, otro bucket...). Ante la duda, no se toca nada.
    if (unreferenced.length === files.length) {
      result.skipped.push({
        orderId,
        userId,
        files: files.length,
        bytes: files.reduce((sum, f) => sum + f.bytes, 0),
        reason: 'ningún archivo de la carpeta aparece en los pedidos',
      });
      continue;
    }

    const loose = unreferenced.filter(f => nowMs - f.updatedMs > graceMs);
    if (loose.length === 0) continue;

    result.folders.push({
      orderId,
      userId,
      status: meta.status,
      customerName: meta.customerName,
      customerEmail: meta.customerEmail,
      files: loose.length,
      bytes: loose.reduce((sum, f) => sum + f.bytes, 0),
      paths: loose.map(f => f.path).sort(),
    });
  }

  result.folders.sort((a, b) => b.bytes - a.bytes);
  return result;
}
