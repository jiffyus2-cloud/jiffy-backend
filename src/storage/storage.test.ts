import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { INITIAL_STORAGE_POLICY, mergeStoragePolicy } from './storage-policy';
import { isExpired, toIso } from './storage.service';

// Se ejecutan sobre el JS compilado (ver el script `test` de package.json).

const DAY = 24 * 60 * 60 * 1000;

describe('mergeStoragePolicy', () => {
  it('sin documento devuelve los valores iniciales', () => {
    assert.deepEqual(mergeStoragePolicy(null), INITIAL_STORAGE_POLICY);
    assert.deepEqual(mergeStoragePolicy({}), INITIAL_STORAGE_POLICY);
  });

  it('lo guardado manda aunque sea distinto del inicial', () => {
    const merged = mergeStoragePolicy({ maxDraftsPerUser: 2, draftRetentionDays: 30, storageCapacityGb: 0.5 });
    assert.deepEqual(merged, { maxDraftsPerUser: 2, draftRetentionDays: 30, storageCapacityGb: 0.5 });
  });

  it('rellena solo lo que falta o no es válido', () => {
    const merged = mergeStoragePolicy({ maxDraftsPerUser: '7', draftRetentionDays: 0, storageCapacityGb: 'x' });
    assert.equal(merged.maxDraftsPerUser, 7);
    assert.equal(merged.draftRetentionDays, INITIAL_STORAGE_POLICY.draftRetentionDays);
    assert.equal(merged.storageCapacityGb, INITIAL_STORAGE_POLICY.storageCapacityGb);
  });

  it('los enteros se truncan', () => {
    assert.equal(mergeStoragePolicy({ maxDraftsPerUser: 3.9 }).maxDraftsPerUser, 3);
  });
});

describe('isExpired', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z');
  const cutoff = now - 90 * DAY;

  it('vence cuando la última edición es anterior al corte', () => {
    const edited = new Date(cutoff - DAY).toISOString();
    assert.equal(isExpired({ lastEditedAt: edited, lastFileAt: null }, cutoff), true);
  });

  it('no vence si se editó después del corte', () => {
    const edited = new Date(cutoff + DAY).toISOString();
    assert.equal(isExpired({ lastEditedAt: edited, lastFileAt: null }, cutoff), false);
  });

  it('una subida reciente a Storage lo mantiene vivo', () => {
    const edited = new Date(cutoff - 10 * DAY).toISOString();
    const file = new Date(cutoff + DAY).toISOString();
    assert.equal(isExpired({ lastEditedAt: edited, lastFileAt: file }, cutoff), false);
  });

  it('sin fecha de edición nunca se borra', () => {
    assert.equal(isExpired({ lastEditedAt: null, lastFileAt: null }, cutoff), false);
    assert.equal(isExpired({ lastEditedAt: 'no-es-fecha', lastFileAt: null }, cutoff), false);
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
