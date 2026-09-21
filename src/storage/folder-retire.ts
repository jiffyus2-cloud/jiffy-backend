/**
 * Helpers puros para retirar la carpeta de un pedido sin romper a los demás.
 *
 * Las fotos de un pedido viven en `orders/{uid}/{orderId}/…`, pero otro pedido
 * puede apuntar a ellas: un borrador creado a partir de otro reutiliza sus
 * fotos sin resubirlas (`uploadedUrlMap`), y los pedidos antiguos guardaban
 * las fotos bajo un id distinto al del documento. Antes de borrar una carpeta
 * hay que mirar, archivo por archivo, quién más la usa: esos archivos se
 * MUEVEN a la carpeta del pedido que los necesita y se reescribe su URL en el
 * documento; el resto se borra.
 *
 * Todo lo de aquí es puro (sin Firestore ni Storage) para poder probarlo.
 */

const SEP = String.raw`(?:%2F|\\?\/)`;

/** Escapa un valor para meterlo literal dentro de una RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rutas (`orders/uid/orderId/archivo`) dentro de la carpeta dada a las que
 * apunta el documento. Las URLs de descarga llevan la ruta codificada
 * (`orders%2Fuid%2Fid%2Farchivo?alt=media…`); una ruta `gs://` o relativa va
 * sin codificar. Devuelve rutas decodificadas y sin duplicados.
 */
export function referencedFilesInFolder(order: Record<string, unknown>, userId: string, orderId: string): Set<string> {
  const json = JSON.stringify(order);
  const prefix = `orders${SEP}${escapeRegExp(userId)}${SEP}${escapeRegExp(orderId)}${SEP}`;
  // El nombre del archivo termina en `?` (query de la URL), `"` (fin de cadena
  // JSON), `\` (escape JSON) o `#`. Puede contener `%2F` si hay subcarpetas.
  const pattern = new RegExp(`${prefix}([^"?#\\\\]+)`, 'g');
  const files = new Set<string>();
  for (const match of json.matchAll(pattern)) {
    let rest = match[1];
    try {
      rest = decodeURIComponent(rest);
    } catch {
      // Una secuencia % suelta no es una URL nuestra: se toma tal cual.
    }
    if (rest) files.add(`orders/${userId}/${orderId}/${rest}`);
  }
  return files;
}

/** Nombre del archivo dentro de su carpeta `orders/uid/orderId/`. */
export function fileNameInFolder(path: string): string {
  return path.split('/').slice(3).join('/');
}

/**
 * Reemplaza en todas las cadenas del documento las referencias a `fromPath`
 * por `toPath`, tanto en forma codificada (URL de descarga) como sin codificar.
 * Devuelve una copia; los valores que no son cadenas (Timestamps, números…)
 * se conservan tal cual. `changed` dice si hubo algún reemplazo.
 */
export function rewriteFileReferences<T>(value: T, fromPath: string, toPath: string): { value: T; changed: boolean } {
  const replacements: Array<[string, string]> = [
    [encodeStoragePath(fromPath), encodeStoragePath(toPath)],
    [fromPath, toPath],
  ];
  let changed = false;

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      let out = node;
      for (const [from, to] of replacements) {
        if (out.includes(from)) {
          out = out.split(from).join(to);
          changed = true;
        }
      }
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = walk(child);
      return out;
    }
    return node; // Timestamp, Date, número, null…
  };

  return { value: walk(value) as T, changed };
}

/** `orders/uid/id/a b.jpg` → `orders%2Fuid%2Fid%2Fa%20b.jpg`, como en las URLs de descarga. */
export function encodeStoragePath(path: string): string {
  return encodeURIComponent(path);
}

/** URL de descarga de Firebase Storage para una ruta y su token. */
export function buildDownloadUrl(bucket: string, path: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeStoragePath(path)}?alt=media&token=${token}`;
}

/**
 * Destino de un archivo que se muda a la carpeta de otro pedido. Si allí ya
 * hay uno con el mismo nombre, se antepone el id de origen para no pisarlo.
 */
export function destinationPath(fromPath: string, toUserId: string, toOrderId: string, existsAtDestination: (path: string) => boolean): string {
  const name = fileNameInFolder(fromPath);
  const plain = `orders/${toUserId}/${toOrderId}/${name}`;
  if (!existsAtDestination(plain)) return plain;
  const fromOrderId = fromPath.split('/')[2];
  return `orders/${toUserId}/${toOrderId}/from-${fromOrderId}-${name}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
