import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BucketFile, findLooseFiles, referencedFiles } from './loose-files';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const META = { status: 'saved_draft', customerName: 'Ana', customerEmail: 'ana@example.com' };

const url = (path: string) =>
  `https://firebasestorage.googleapis.com/v0/b/app.firebasestorage.app/o/${encodeURIComponent(path)}?alt=media&token=abc`;
const file = (path: string, ageDays: number, bytes = 100): BucketFile => ({ path, bytes, updatedMs: NOW - ageDays * DAY });

describe('referencedFiles', () => {
  it('decodifica las URLs de descarga y las rutas sin codificar', () => {
    const paths = referencedFiles({
      pages: [{ images: [url('orders/u1/o1/photos/0_0_a'), null] }],
      coverData: { image: url('orders/u1/o1/cover_image') },
      photos: ['gs://bucket/orders/u1/o1/loose_photos/photo0_x'],
    });
    assert.deepEqual(
      [...paths].sort(),
      ['orders/u1/o1/cover_image', 'orders/u1/o1/loose_photos/photo0_x', 'orders/u1/o1/photos/0_0_a'],
    );
  });

  it('un pedido sin fotos no referencia nada', () => {
    assert.equal(referencedFiles({ pages: [], photos: [], status: 'draft' }).size, 0);
  });
});

describe('findLooseFiles', () => {
  const kept = file('orders/u1/o1/photos/kept', 30);
  const old = file('orders/u1/o1/photos/old', 30, 500);
  const recent = file('orders/u1/o1/photos/recent', 2);
  const folders = new Map([['u1/o1', [kept, old, recent]]]);
  const live = new Map([['u1/o1', META]]);

  it('marca solo lo no referenciado y más viejo que el margen', () => {
    const scan = findLooseFiles(folders, live, new Set([kept.path]), NOW);
    assert.equal(scan.folders.length, 1);
    assert.deepEqual(scan.folders[0].paths, [old.path]);
    assert.equal(scan.folders[0].bytes, 500);
    assert.equal(scan.folders[0].orderId, 'o1');
    assert.equal(scan.skipped.length, 0);
  });

  it('respeta una foto que otro pedido sigue usando', () => {
    // `referenced` es global: incluye las rutas de TODOS los pedidos, también clones.
    const scan = findLooseFiles(folders, live, new Set([kept.path, old.path]), NOW);
    assert.equal(scan.folders.length, 0);
  });

  it('no toca carpetas huérfanas (las cubre otra limpieza)', () => {
    const scan = findLooseFiles(folders, new Map(), new Set([kept.path]), NOW);
    assert.equal(scan.folders.length, 0);
  });

  it('si ningún archivo de una carpeta viva está referenciado, la deja y la informa', () => {
    const scan = findLooseFiles(folders, live, new Set(), NOW);
    assert.equal(scan.folders.length, 0);
    assert.equal(scan.skipped.length, 1);
    assert.equal(scan.skipped[0].files, 3);
  });
});
