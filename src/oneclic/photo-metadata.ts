import * as exifr from 'exifr';

/**
 * Metadatos de las fotos de un álbum, para que un agente proponga un orden.
 *
 * Los álbumes solo guardan URLs de Storage: ni nombre original ni fecha. Lo
 * que sí se puede recuperar es lo que va dentro del JPEG: la fecha de captura
 * y la cámara (EXIF, cuando el navegador no lo descartó al reescribir la
 * imagen) y las dimensiones (marcador SOF, siempre). Para no descargar
 * álbumes enteros de cientos de MB, se pide solo la cabecera del archivo con
 * una petición Range: el EXIF vive en los primeros KB.
 *
 * Todo aquí es de SOLO LECTURA: no toca Firestore ni Storage.
 */

export interface PhotoRef {
  /** Posición en el álbum actual (orden plano de páginas y huecos). */
  index: number;
  page: number;
  slot: number;
  url: string;
}

export interface PhotoMetadata extends PhotoRef {
  /** Fecha de captura ISO, o null si el archivo no la trae. */
  takenAt: string | null;
  width: number | null;
  height: number | null;
  /** 'H' horizontal, 'V' vertical, 'S' cuadrada, null si no se sabe. */
  orientation: 'H' | 'V' | 'S' | null;
  camera: string | null;
  /** Tamaño total del archivo en bytes (de Content-Range), o null. */
  bytes: number | null;
  /** Por qué faltan datos, si faltan (para la pantalla). */
  note: string | null;
}

/** Bytes que se piden de cada archivo: el EXIF cabe de sobra; el SOF también. */
export const HEADER_BYTES = 131_072;
/** Descargas simultáneas: suficiente para 200 fotos en ~30 s sin castigar a Storage. */
export const METADATA_CONCURRENCY = 8;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Fotos reales (no huecos) de `pages`, en el orden en que están en el álbum. */
export function flattenAlbumPhotos(pages: unknown): PhotoRef[] {
  const out: PhotoRef[] = [];
  if (!Array.isArray(pages)) return out;
  pages.forEach((page: any, pageIdx: number) => {
    const images = Array.isArray(page?.images) ? page.images : [];
    images.forEach((url: unknown, slot: number) => {
      if (typeof url === 'string' && url.trim()) {
        out.push({ index: out.length, page: typeof page?.pageIndex === 'number' ? page.pageIndex : pageIdx, slot, url });
      }
    });
  });
  return out;
}

/** Dimensiones desde el marcador SOF de un JPEG; null si no es JPEG o no aparece en la cabecera. */
export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // Marcadores sin longitud: relleno, RSTn, SOI, TEM.
    if (marker === 0xff || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda) return null; // empieza la imagen: ya no habrá SOF
    i += 2 + length;
  }
  return null;
}

export function orientationOf(width: number | null, height: number | null, exifOrientation?: number | null): PhotoMetadata['orientation'] {
  if (!width || !height) return null;
  // Orientaciones EXIF 5-8 giran 90°: el ancho visible es el alto del archivo.
  const rotated = typeof exifOrientation === 'number' && exifOrientation >= 5;
  const w = rotated ? height : width;
  const h = rotated ? width : height;
  if (Math.abs(w - h) / Math.max(w, h) < 0.02) return 'S';
  return w > h ? 'H' : 'V';
}

/** Lee la cabecera de una foto y saca lo que haya. Nunca lanza: los fallos van en `note`. */
export async function readPhotoMetadata(photo: PhotoRef, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<PhotoMetadata> {
  const base: PhotoMetadata = { ...photo, takenAt: null, width: null, height: null, orientation: null, camera: null, bytes: null, note: null };
  let response: Response;
  try {
    response = await fetchImpl(photo.url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
  } catch (error) {
    return { ...base, note: `no se pudo descargar: ${(error as Error)?.message ?? 'error de red'}` };
  }
  if (!response.ok) return { ...base, note: `Storage respondió HTTP ${response.status}` };

  const buf = Buffer.from(await response.arrayBuffer());
  const total = Number((response.headers.get('content-range') || '').split('/')[1] || response.headers.get('content-length') || 0);
  const bytes = Number.isFinite(total) && total > 0 ? total : null;

  const sof = jpegDimensions(buf);
  let exif: any = null;
  try {
    exif = await exifr.parse(buf, {
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'Orientation', 'ExifImageWidth', 'ExifImageHeight'],
    });
  } catch {
    exif = null;
  }

  const takenRaw = exif?.DateTimeOriginal ?? exif?.CreateDate ?? null;
  const takenAt = takenRaw instanceof Date && !Number.isNaN(takenRaw.getTime()) ? takenRaw.toISOString() : null;
  const width = sof?.width ?? (typeof exif?.ExifImageWidth === 'number' ? exif.ExifImageWidth : null);
  const height = sof?.height ?? (typeof exif?.ExifImageHeight === 'number' ? exif.ExifImageHeight : null);
  const camera = [exif?.Make, exif?.Model].filter((v: unknown) => typeof v === 'string' && v.trim()).map((v: string) => v.trim()).join(' ') || null;
  const exifOrientation = typeof exif?.Orientation === 'number' ? exif.Orientation : null;

  return {
    ...base,
    takenAt,
    width,
    height,
    orientation: orientationOf(width, height, exifOrientation),
    camera: dedupeCameraName(camera),
    bytes,
    note: takenAt ? null : (exif ? 'sin fecha de captura en el EXIF' : 'sin EXIF (la imagen se reescribió al subirla)'),
  };
}

/** "NIKON CORPORATION NIKON D850" → "NIKON D850"; "Canon Canon EOS 6D" → "Canon EOS 6D". */
export function dedupeCameraName(camera: string | null): string | null {
  if (!camera) return null;
  const words = camera.split(/\s+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out.join(' ').replace(/\bCORPORATION\b/i, '').replace(/\s+/g, ' ').trim() || null;
}

/** Ejecuta `fn` sobre todos los elementos con como mucho `limit` en vuelo, conservando el orden. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Contexto para el agente ──────────────────────────────────────────────────

/** Límite del contrato de 1clic para `context` (manifest.limits.context_chars). */
export const CONTEXT_MAX_CHARS = 8000;

export interface AgentContext {
  /** Leyenda de cámaras: letra → nombre. */
  cameras: Record<string, string>;
  /** Formato de cada línea de `photos`. */
  format: string;
  /** Una entrada por foto: "índice|fecha|orientación|cámara". */
  photos: string[];
  /** Cuántas fotos se han omitido para caber en el límite (0 normalmente). */
  omitted: number;
}

/**
 * Contexto compacto: con 200+ fotos por álbum, un JSON por foto no cabe en
 * 8000 caracteres. Cada foto es una cadena corta y las cámaras van en una
 * leyenda. Si aun así no cabe, se recortan campos y, en último término, fotos.
 */
export function buildAgentContext(photos: PhotoMetadata[], maxChars: number = CONTEXT_MAX_CHARS): AgentContext {
  const cameraNames = Array.from(new Set(photos.map(p => p.camera).filter((c): c is string => Boolean(c))));
  const cameraKey = new Map(cameraNames.map((name, i) => [name, String.fromCharCode(97 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '')]));
  const cameras = Object.fromEntries(Array.from(cameraKey.entries()).map(([name, key]) => [key, name]));

  const line = (p: PhotoMetadata, withCamera: boolean) => {
    const date = p.takenAt ? p.takenAt.slice(0, 16).replace('T', ' ') : '-';
    const parts = [String(p.index), date, p.orientation ?? '-'];
    if (withCamera) parts.push(p.camera ? cameraKey.get(p.camera) ?? '-' : '-');
    return parts.join('|');
  };

  const attempt = (withCamera: boolean, keep: number): AgentContext => ({
    cameras: withCamera ? cameras : {},
    format: withCamera ? 'index|fecha_captura(YYYY-MM-DD HH:MM o -)|orientación(H/V/S)|cámara(letra de la leyenda)' : 'index|fecha_captura(YYYY-MM-DD HH:MM o -)|orientación(H/V/S)',
    photos: photos.slice(0, keep).map(p => line(p, withCamera)),
    omitted: photos.length - keep,
  });

  let ctx = attempt(true, photos.length);
  if (JSON.stringify(ctx).length <= maxChars) return ctx;
  ctx = attempt(false, photos.length);
  if (JSON.stringify(ctx).length <= maxChars) return ctx;
  // Último recurso: menos fotos. Las omitidas se colocan al final sin cambiar.
  let keep = photos.length;
  while (keep > 0 && JSON.stringify(ctx).length > maxChars) {
    keep -= Math.max(1, Math.floor(keep * 0.1));
    ctx = attempt(false, keep);
  }
  return ctx;
}

/**
 * El agente devuelve una lista de índices. Se convierte en una permutación
 * válida: se descartan los que no existen o se repiten y los que falten se
 * añaden al final en su orden actual. `repaired` dice si hubo que tocarla.
 */
export function normalizeOrder(proposed: unknown, count: number): { order: number[]; repaired: boolean; issues: string[] } {
  const issues: string[] = [];
  const order: number[] = [];
  const seen = new Set<number>();
  if (!Array.isArray(proposed)) {
    issues.push('el agente no devolvió una lista de índices');
  } else {
    for (const raw of proposed) {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 0 || n >= count) { issues.push(`índice fuera de rango descartado: ${String(raw)}`); continue; }
      if (seen.has(n)) { issues.push(`índice repetido descartado: ${n}`); continue; }
      seen.add(n);
      order.push(n);
    }
  }
  const missing: number[] = [];
  for (let i = 0; i < count; i += 1) if (!seen.has(i)) missing.push(i);
  if (missing.length) issues.push(`${missing.length} foto(s) sin colocar por el agente, añadidas al final`);
  return { order: [...order, ...missing], repaired: issues.length > 0, issues };
}
