import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildDownloadUrl,
  destinationPath,
  fileNameInFolder,
  referencedFilesInFolder,
  rewriteFileReferences,
} from './folder-retire';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

const BUCKET = 'jiffy-photos-app.firebasestorage.app';
const url = (path: string, token = 'tok') => buildDownloadUrl(BUCKET, path, token);

describe('referencedFilesInFolder', () => {
  it('encuentra los archivos de la carpeta a los que apunta el documento (URL codificada)', () => {
    const order = {
      photos: [{ url: url('orders/u1/A/photo_1.jpg') }, { url: url('orders/u1/A/photo_2.jpg') }],
      coverData: { image: url('orders/u1/A/cover.jpg') },
      // De otra carpeta: no cuenta.
      extra: url('orders/u1/B/photo_9.jpg'),
    };
    assert.deepEqual([...referencedFilesInFolder(order, 'u1', 'A')].sort(), [
      'orders/u1/A/cover.jpg',
      'orders/u1/A/photo_1.jpg',
      'orders/u1/A/photo_2.jpg',
    ]);
  });

  it('acepta rutas sin codificar y nombres con caracteres codificados', () => {
    const order = { pages: [{ img: 'gs://b/orders/u1/A/p 1.jpg' }], cover: url('orders/u1/A/foto ñ.jpg') };
    assert.deepEqual([...referencedFilesInFolder(order, 'u1', 'A')].sort(), ['orders/u1/A/foto ñ.jpg', 'orders/u1/A/p 1.jpg']);
  });

  it('no confunde ids que son prefijo de otros', () => {
    const order = { a: url('orders/u1/AB/photo.jpg') };
    assert.equal(referencedFilesInFolder(order, 'u1', 'A').size, 0);
  });

  it('un documento sin referencias devuelve vacío', () => {
    assert.equal(referencedFilesInFolder({ status: 'draft' }, 'u1', 'A').size, 0);
  });
});

describe('rewriteFileReferences', () => {
  it('reescribe la ruta en las URLs codificadas y deja el token intacto', () => {
    const order = { photos: [{ url: url('orders/u1/A/photo_1.jpg', 'abc') }], n: 3 };
    const { value, changed } = rewriteFileReferences(order, 'orders/u1/A/photo_1.jpg', 'orders/u1/B/photo_1.jpg');
    assert.equal(changed, true);
    assert.equal(value.photos[0].url, url('orders/u1/B/photo_1.jpg', 'abc'));
    assert.equal(value.n, 3);
  });

  it('reescribe también rutas sin codificar y en cualquier profundidad', () => {
    const order = { pages: [{ slots: { 0: { src: 'gs://b/orders/u1/A/p.jpg' } } }] };
    const { value } = rewriteFileReferences(order, 'orders/u1/A/p.jpg', 'orders/u1/B/p.jpg');
    assert.equal(value.pages[0].slots[0].src, 'gs://b/orders/u1/B/p.jpg');
  });

  it('no toca otros archivos ni otros tipos, y devuelve una copia', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const order = { a: url('orders/u1/A/other.jpg'), when: date, nested: { list: [1, null] } };
    const { value, changed } = rewriteFileReferences(order, 'orders/u1/A/p.jpg', 'orders/u1/B/p.jpg');
    assert.equal(changed, false);
    assert.equal(value.a, order.a);
    assert.equal(value.when, date); // misma instancia: no es un objeto plano
    assert.deepEqual(value.nested, { list: [1, null] });
    assert.notEqual(value, order);
  });
});

describe('destinationPath', () => {
  it('conserva el nombre si no hay conflicto', () => {
    assert.equal(destinationPath('orders/u1/A/p.jpg', 'u1', 'B', () => false), 'orders/u1/B/p.jpg');
  });

  it('antepone el id de origen si el nombre ya existe en el destino', () => {
    assert.equal(destinationPath('orders/u1/A/p.jpg', 'u1', 'B', p => p === 'orders/u1/B/p.jpg'), 'orders/u1/B/from-A-p.jpg');
  });
});

describe('fileNameInFolder', () => {
  it('devuelve lo que sigue a orders/uid/orderId/, con subcarpetas', () => {
    assert.equal(fileNameInFolder('orders/u1/A/p.jpg'), 'p.jpg');
    assert.equal(fileNameInFolder('orders/u1/A/sub/p.jpg'), 'sub/p.jpg');
  });
});
