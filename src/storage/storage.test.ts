import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { INITIAL_STORAGE_POLICY, mergeStoragePolicy } from './storage-policy';
import { isExpired, referencedFolders, toIso } from './storage.service';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

const DAY = 24 * 60 * 60 * 1000;

describe('mergeStoragePolicy', () => {
  it('sin documento devuelve los valores iniciales', () => {
    assert.deepEqual(mergeStoragePolicy(null), INITIAL_STORAGE_POLICY);
    assert.deepEqual(mergeStoragePolicy({}), INITIAL_STORAGE_POLICY);
  });

  it('lo guardado manda aunque sea distinto del inicial', () => {
    const merged = mergeStoragePolicy({ maxDraftsPerUser: 2, draftRetentionDays: 30, storageCapacityGb: 0.5 });
    assert.deepEqual(merged, { maxDraftsPerUser: 2, draftRetentionDays: 30, storageCapacityGb: 0.5, retentionAppliesFrom: null });
  });

  it('rellena solo lo que falta o no es válido', () => {
    const merged = mergeStoragePolicy({ maxDraftsPerUser: '7', draftRetentionDays: 0, storageCapacityGb: 'x' });
    assert.equal(merged.maxDraftsPerUser, 7);
    assert.equal(merged.draftRetentionDays, INITIAL_STORAGE_POLICY.draftRetentionDays);
    assert.equal(merged.storageCapacityGb, INITIAL_STORAGE_POLICY.storageCapacityGb);
  });

  it('la fecha de activación solo se acepta si es una fecha válida', () => {
    assert.equal(mergeStoragePolicy({ retentionAppliesFrom: '2026-09-20T00:00:00.000Z' }).retentionAppliesFrom, '2026-09-20T00:00:00.000Z');
    assert.equal(mergeStoragePolicy({ retentionAppliesFrom: 'ayer' }).retentionAppliesFrom, null);
    assert.equal(mergeStoragePolicy({ retentionAppliesFrom: 42 }).retentionAppliesFrom, null);
  });

  it('los enteros se truncan', () => {
    assert.equal(mergeStoragePolicy({ maxDraftsPerUser: 3.9 }).maxDraftsPerUser, 3);
  });
});

describe('isExpired', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z');
  const cutoff = now - 90 * DAY;
  // La caducidad se activó hace 200 días.
  const appliesFrom = now - 200 * DAY;
  const iso = (ms: number) => new Date(ms).toISOString();

  it('vence un borrador creado tras la activación y sin editar desde antes del corte', () => {
    const project = { createdAt: iso(appliesFrom + 10 * DAY), lastEditedAt: iso(cutoff - DAY), lastFileAt: null };
    assert.equal(isExpired(project, cutoff, appliesFrom), true);
  });

  it('no vence si se editó después del corte', () => {
    const project = { createdAt: iso(appliesFrom + 10 * DAY), lastEditedAt: iso(cutoff + DAY), lastFileAt: null };
    assert.equal(isExpired(project, cutoff, appliesFrom), false);
  });

  it('una subida reciente a Storage lo mantiene vivo', () => {
    const project = { createdAt: iso(appliesFrom + 10 * DAY), lastEditedAt: iso(cutoff - 10 * DAY), lastFileAt: iso(cutoff + DAY) };
    assert.equal(isExpired(project, cutoff, appliesFrom), false);
  });

  it('NUNCA vence un borrador creado antes de activar la caducidad, por viejo que sea', () => {
    const project = { createdAt: iso(appliesFrom - DAY), lastEditedAt: iso(cutoff - 300 * DAY), lastFileAt: null };
    assert.equal(isExpired(project, cutoff, appliesFrom), false);
  });

  it('sin fecha de activación no vence ninguno', () => {
    const project = { createdAt: iso(appliesFrom + 10 * DAY), lastEditedAt: iso(cutoff - 300 * DAY), lastFileAt: null };
    assert.equal(isExpired(project, cutoff, NaN), false);
    assert.equal(isExpired(project, cutoff, Date.parse('')), false);
  });

  it('sin fecha de creación o de edición nunca se borra', () => {
    assert.equal(isExpired({ createdAt: null, lastEditedAt: iso(cutoff - DAY), lastFileAt: null }, cutoff, appliesFrom), false);
    assert.equal(isExpired({ createdAt: iso(appliesFrom + DAY), lastEditedAt: null, lastFileAt: null }, cutoff, appliesFrom), false);
    assert.equal(isExpired({ createdAt: iso(appliesFrom + DAY), lastEditedAt: 'no-es-fecha', lastFileAt: null }, cutoff, appliesFrom), false);
  });
});

describe('toIso', () => {
  it('acepta ISO, Date y Timestamp de Firestore', () => {
    assert.equal(toIso('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z');
    assert.equal(toIso(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
    assert.equal(toIso({ seconds: 1767322000 }), new Date(1767322000 * 1000).toISOString());
    assert.equal(toIso({ toDate: () => new Date('2026-01-02T03:04:05.000Z') }), '2026-01-02T03:04:05.000Z');
  });

  it('rechaza vacíos y basura', () => {
    assert.equal(toIso(null), null);
    assert.equal(toIso(''), null);
    assert.equal(toIso('ayer'), null);
    assert.equal(toIso(42), null);
  });
});

describe('referencedFolders', () => {
  it('encuentra las carpetas a las que apuntan las URLs de descarga (ruta codificada)', () => {
    const order = {
      photos: [{ url: 'https://firebasestorage.googleapis.com/v0/b/x.firebasestorage.app/o/orders%2Fuid1%2ForderA%2Fphoto_1.jpg?alt=media&token=t' }],
      coverData: { image: 'https://firebasestorage.googleapis.com/v0/b/x/o/orders%2Fuid1%2ForderB%2Fcover.jpg?alt=media' },
    };
    assert.deepEqual([...referencedFolders(order)].sort(), ['uid1/orderA', 'uid1/orderB']);
  });

  it('acepta también rutas sin codificar y no confunde otros textos', () => {
    const order = { pages: [{ img: 'gs://x/orders/uid2/orderC/p.jpg' }], note: 'sin orders aquí', other: 'orders/only-two/' };
    assert.deepEqual([...referencedFolders(order)], ['uid2/orderC']);
  });

  it('un pedido sin fotos no referencia nada', () => {
    assert.equal(referencedFolders({ status: 'draft' }).size, 0);
  });
});
