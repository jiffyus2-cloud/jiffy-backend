import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CONTEXT_MAX_CHARS,
  PhotoMetadata,
  buildAgentContext,
  dedupeCameraName,
  flattenAlbumPhotos,
  jpegDimensions,
  mapLimit,
  normalizeOrder,
  orientationOf,
  readPhotoMetadata,
} from './photo-metadata';

/** JPEG mínimo: SOI, un APP0 vacío, SOF0 con las dimensiones dadas y SOS. */
function fakeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(8, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 1;
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, sos, Buffer.alloc(16, 0x11)]);
}

function photo(index: number, extra: Partial<PhotoMetadata> = {}): PhotoMetadata {
  return {
    index, page: Math.floor(index / 2), slot: index % 2, url: `https://s/${index}.jpg`,
    takenAt: null, width: null, height: null, orientation: null, camera: null, bytes: null, note: null,
    ...extra,
  };
}

describe('photo-metadata', () => {
  it('flattenAlbumPhotos: solo fotos reales, en orden de página y hueco', () => {
    const refs = flattenAlbumPhotos([
      { pageIndex: 0, images: ['a', null, 'b'] },
      { pageIndex: 1, images: [] },
      { pageIndex: 2, images: ['c', ''] },
    ]);
    assert.deepEqual(refs.map(r => [r.index, r.page, r.slot, r.url]), [[0, 0, 0, 'a'], [1, 0, 2, 'b'], [2, 2, 0, 'c']]);
    assert.deepEqual(flattenAlbumPhotos(undefined), []);
  });

  it('jpegDimensions lee el SOF y devuelve null si no es JPEG', () => {
    assert.deepEqual(jpegDimensions(fakeJpeg(4032, 3024)), { width: 4032, height: 3024 });
    assert.equal(jpegDimensions(Buffer.from('not a jpeg')), null);
  });

  it('orientationOf respeta las orientaciones EXIF giradas', () => {
    assert.equal(orientationOf(4000, 3000), 'H');
    assert.equal(orientationOf(3000, 4000), 'V');
    assert.equal(orientationOf(2000, 2010), 'S');
    assert.equal(orientationOf(4000, 3000, 6), 'V');
    assert.equal(orientationOf(null, 3000), null);
  });

  it('dedupeCameraName quita repeticiones y CORPORATION', () => {
    assert.equal(dedupeCameraName('NIKON CORPORATION NIKON D850'), 'NIKON D850');
    assert.equal(dedupeCameraName('Canon Canon EOS 6D'), 'Canon EOS 6D');
    assert.equal(dedupeCameraName('Apple iPhone 15 Pro'), 'Apple iPhone 15 Pro');
    assert.equal(dedupeCameraName(null), null);
  });

  it('readPhotoMetadata pide solo la cabecera y no lanza aunque falle', async () => {
    const calls: RequestInit[] = [];
    const ok = async (_url: string, init?: RequestInit) => {
      calls.push(init!);
      return new Response(new Uint8Array(fakeJpeg(3000, 4000)), { status: 206, headers: { 'content-range': 'bytes 0-131071/7807014' } });
    };
    const meta = await readPhotoMetadata({ index: 0, page: 0, slot: 0, url: 'https://s/0.jpg' }, ok);
    assert.equal((calls[0].headers as Record<string, string>).Range, 'bytes=0-131071');
    assert.equal(meta.width, 3000);
    assert.equal(meta.height, 4000);
    assert.equal(meta.orientation, 'V');
    assert.equal(meta.bytes, 7807014);
    assert.equal(meta.takenAt, null);
    assert.match(meta.note!, /sin EXIF/);

    const boom = async () => { throw new Error('ECONNRESET'); };
    const failed = await readPhotoMetadata({ index: 1, page: 0, slot: 1, url: 'https://s/1.jpg' }, boom);
    assert.equal(failed.width, null);
    assert.match(failed.note!, /ECONNRESET/);

    const denied = async () => new Response('nope', { status: 403 });
    const forbidden = await readPhotoMetadata({ index: 2, page: 1, slot: 0, url: 'https://s/2.jpg' }, denied);
    assert.match(forbidden.note!, /HTTP 403/);
  });

  it('mapLimit conserva el orden y no supera el límite de concurrencia', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async n => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, n));
      inFlight -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 30, 20, 40]);
    assert.equal(peak, 2);
  });

  it('buildAgentContext: una línea por foto, cámaras en leyenda, y cabe en el límite del contrato', () => {
    const photos = Array.from({ length: 230 }, (_, i) => photo(i, {
      takenAt: i % 5 === 0 ? null : new Date(Date.UTC(2026, 4, 2, 10, i)).toISOString(),
      orientation: i % 3 === 0 ? 'V' : 'H',
      camera: i % 2 === 0 ? 'NIKON D800' : 'Apple iPhone 15 Pro',
    }));
    const ctx = buildAgentContext(photos);
    assert.equal(ctx.photos.length, 230);
    assert.equal(ctx.omitted, 0);
    assert.deepEqual(ctx.cameras, { a: 'NIKON D800', b: 'Apple iPhone 15 Pro' });
    assert.equal(ctx.photos[0], '0|-|V|a');
    assert.equal(ctx.photos[1], '1|2026-05-02 10:01|H|b');
    assert.ok(JSON.stringify(ctx).length <= CONTEXT_MAX_CHARS);
  });

  it('buildAgentContext: si no cabe, primero quita la cámara y después recorta fotos', () => {
    const photos = Array.from({ length: 600 }, (_, i) => photo(i, { takenAt: '2026-05-02T10:00:00.000Z', orientation: 'H', camera: 'NIKON D800' }));
    const ctx = buildAgentContext(photos, 4000);
    assert.ok(JSON.stringify(ctx).length <= 4000);
    assert.deepEqual(ctx.cameras, {});
    assert.ok(ctx.omitted > 0);
    assert.equal(ctx.photos.length + ctx.omitted, 600);
  });

  it('normalizeOrder repara lo que devuelva el agente sin perder ninguna foto', () => {
    assert.deepEqual(normalizeOrder([2, 0, 1], 3), { order: [2, 0, 1], repaired: false, issues: [] });

    const fixed = normalizeOrder([2, 2, 9, '1'], 4);
    assert.deepEqual(fixed.order, [2, 1, 0, 3]);
    assert.equal(fixed.repaired, true);
    assert.equal(fixed.issues.length, 3);

    const none = normalizeOrder(undefined, 3);
    assert.deepEqual(none.order, [0, 1, 2]);
    assert.equal(none.repaired, true);
  });
});
