import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { getFirestore } from '../firebase/firebase-admin';
import { OneclicService } from './oneclic.service';
import {
  AgentContext,
  METADATA_CONCURRENCY,
  PhotoMetadata,
  buildAgentContext,
  flattenAlbumPhotos,
  mapLimit,
  normalizeOrder,
  readPhotoMetadata,
} from './photo-metadata';

/**
 * Laboratorio: pedirle a un agente de 1clic un orden para las fotos de un
 * álbum a partir de sus metadatos.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ SOLO LECTURA. Este servicio lee pedidos de Firestore y cabeceras de   │
 * │ Storage, y devuelve una PROPUESTA de orden. No escribe en ningún      │
 * │ sitio: el orden real de las fotos de los álbumes no se toca.          │
 * └──────────────────────────────────────────────────────────────────────┘
 */

export interface AlbumSummary {
  id: string;
  productName: string | null;
  productType: string | null;
  customerName: string | null;
  status: string | null;
  createdAt: string | null;
  size: string | null;
  photoCount: number;
  pageCount: number;
  cover: string | null;
}

export interface AlbumOrderProposal {
  album: AlbumSummary;
  photos: PhotoMetadata[];
  /** Cuántas fotos traían fecha de captura. */
  withDate: number;
  context: AgentContext;
  proposal: {
    order: number[];
    groups: { title: string; indices: number[] }[];
    rationale: string;
    repaired: boolean;
    issues: string[];
  };
  agent: { id: string; name: string };
  mode: 'default' | 'dry_run';
  run_id: string | null;
  cost_usd: number;
  duration_ms: number | null;
  dry_run: boolean;
  deduplicated: boolean;
  typed_valid: boolean | null;
  timings_ms: { metadata: number; agent: number };
}

/** Lo que se le pide al agente que devuelva. */
export const ALBUM_ORDER_SCHEMA = {
  type: 'object',
  required: ['order', 'rationale'],
  properties: {
    order: {
      type: 'array',
      description: 'Todos los índices de las fotos, en el nuevo orden. Cada índice exactamente una vez.',
      items: { type: 'integer' },
    },
    groups: {
      type: ['array', 'null'],
      description: 'Bloques del álbum en orden, con un título corto y los índices que van en cada uno.',
      items: {
        type: 'object',
        required: ['title', 'indices'],
        properties: {
          title: { type: 'string' },
          indices: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    rationale: { type: 'string', description: 'Dos o tres frases: qué criterio se ha seguido y qué se ha hecho con las fotos sin fecha.' },
  },
} as const;

export function buildOrderingMessage(album: AlbumSummary, photos: PhotoMetadata[], withDate: number): string {
  return [
    `Eres el diseñador de un álbum de fotos impreso (${album.productName ?? 'álbum'}${album.size ? `, ${album.size}` : ''}) con ${photos.length} fotos.`,
    'En el contexto tienes una línea por foto con su índice actual, la fecha y hora de captura (si el archivo la trae), la orientación (H horizontal, V vertical, S cuadrada) y la cámara.',
    `${withDate} de las ${photos.length} fotos tienen fecha; ${photos.length - withDate} no.`,
    'Propón el orden en que deberían ir en el álbum: ESTRICTAMENTE por fecha y hora de captura ascendente (la más antigua primero, la más reciente al final), sin conservar el orden actual salvo que coincida con el cronológico. Después agrupa la secuencia en momentos (mismo día, franjas de hora cercanas); dentro de un mismo minuto puedes alternar orientaciones para equilibrar las páginas.',
    'Las fotos sin fecha colócalas junto a las de la misma cámara y orientación que encajen, o al final si no hay pista.',
    'Devuelve todos los índices exactamente una vez, los grupos con un título corto en español y una explicación breve.',
  ].join(' ');
}

const ALBUM_LIST_LIMIT = 150;

@Injectable()
export class AlbumOrderingService {
  private readonly logger = new Logger('1clic:albums');

  constructor(private readonly oneclic: OneclicService) {}

  /** Álbumes con fotos, los más recientes primero. Solo lectura. */
  async listAlbums(): Promise<AlbumSummary[]> {
    const snap = await getFirestore()
      .collection('orders')
      .orderBy('createdAt', 'desc')
      .limit(ALBUM_LIST_LIMIT)
      .select('productType', 'product.name', 'product.type', 'customerName', 'status', 'createdAt', 'customization.size', 'pages')
      .get();

    const albums: AlbumSummary[] = [];
    snap.forEach(doc => {
      const d = doc.data() as Record<string, any>;
      const photos = flattenAlbumPhotos(d.pages);
      if (photos.length === 0) return;
      albums.push(toSummary(doc.id, d, photos.length));
    });
    return albums;
  }

  /**
   * Lee el álbum, extrae metadatos de cada foto y pide el orden al agente.
   * Devuelve la propuesta; no guarda nada.
   */
  async organize(params: { orderId: string; agentId: string; mode?: 'default' | 'dry_run'; uid: string }): Promise<AlbumOrderProposal> {
    const orderId = String(params.orderId || '').trim();
    if (!orderId) throw new BadRequestException('Falta el id del álbum.');

    const doc = await getFirestore().collection('orders').doc(orderId).get();
    if (!doc.exists) throw new NotFoundException('Ese álbum no existe.');
    const data = doc.data() as Record<string, any>;

    const refs = flattenAlbumPhotos(data.pages);
    if (refs.length < 2) throw new BadRequestException('El álbum no tiene fotos suficientes para ordenar.');
    const album = toSummary(doc.id, data, refs.length);

    const t0 = Date.now();
    const photos = await mapLimit(refs, METADATA_CONCURRENCY, ref => readPhotoMetadata(ref));
    const metadataMs = Date.now() - t0;
    const withDate = photos.filter(p => p.takenAt).length;
    this.logger.log(`Álbum ${orderId}: ${photos.length} fotos, ${withDate} con fecha, metadatos en ${metadataMs} ms.`);

    const context = buildAgentContext(photos);
    const t1 = Date.now();
    const { result, agent, mode } = await this.oneclic.runTyped({
      uid: params.uid,
      agentId: params.agentId,
      mode: params.mode,
      message: buildOrderingMessage(album, photos, withDate),
      context,
      responseSchema: ALBUM_ORDER_SCHEMA as unknown as Record<string, unknown>,
      recordId: `album-order-${orderId}`,
    });
    const agentMs = Date.now() - t1;

    const typed = result.typed_response;
    const doc2 = typed?.valid && typed.data && typeof typed.data === 'object' ? (typed.data as Record<string, unknown>) : null;
    const normalized = normalizeOrder(doc2?.order, photos.length);
    const groups = Array.isArray(doc2?.groups)
      ? (doc2!.groups as any[])
          .filter(g => g && typeof g === 'object')
          .map(g => ({
            title: typeof g.title === 'string' ? g.title : '',
            indices: Array.isArray(g.indices) ? g.indices.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < photos.length) : [],
          }))
      : [];
    if (!doc2) normalized.issues.unshift('el agente no devolvió un documento válido; se muestra el orden actual');

    this.logger.log(`Álbum ${orderId}: propuesta de ${agent.name} en ${agentMs} ms (${mode}), reparada=${normalized.repaired}.`);

    return {
      album,
      photos,
      withDate,
      context,
      proposal: {
        order: normalized.order,
        groups,
        rationale: typeof doc2?.rationale === 'string' ? doc2.rationale : (result.reply ?? ''),
        repaired: normalized.repaired,
        issues: normalized.issues,
      },
      agent,
      mode,
      run_id: result.run_id ?? null,
      cost_usd: Number(result.cost_usd) || 0,
      duration_ms: result.duration_ms ?? null,
      dry_run: Boolean(result.dry_run),
      deduplicated: Boolean(result.deduplicated),
      typed_valid: typed?.valid ?? null,
      timings_ms: { metadata: metadataMs, agent: agentMs },
    };
  }
}

function toSummary(id: string, d: Record<string, any>, photoCount: number): AlbumSummary {
  const pages = Array.isArray(d.pages) ? d.pages : [];
  const cover = flattenAlbumPhotos(pages)[0]?.url ?? null;
  return {
    id,
    productName: d.product?.name ?? null,
    productType: d.productType ?? d.product?.type ?? null,
    customerName: d.customerName ?? null,
    status: d.status ?? null,
    createdAt: toIso(d.createdAt),
    size: d.customization?.size ?? null,
    photoCount,
    pageCount: pages.length,
    cover,
  };
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof (value as any).toDate === 'function') return (value as any).toDate().toISOString();
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
  if (typeof (value as any).seconds === 'number') return new Date((value as any).seconds * 1000).toISOString();
  return null;
}
