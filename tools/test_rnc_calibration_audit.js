'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const audit = require('./rnc-calibration-audit');

test('ignores duplicate post and splits large gap', () => {
  const proposed = { corredores: [{ nombre: 'Cuernavaca–Acapulco', estado: 'calibrable', detalleAnclas: range(1, 10).map(idKm => ({ idKm })) }] };
  const chain = {
    code: '95', name: 'Cuernavaca - Acapulco', toll: true,
    posts: [[1, 1], [2, 2], [3, 3], [4, 4], [6, 12], [7, 13], [8, 14], [9, 15]]
      .map(([id, km]) => ({ id, km }))
  };
  const result = audit.audit(proposed, { chains: [chain] })[0];
  assert.deepEqual(result.segments.map(x => [x.fromKm, x.toKm]), [[1, 4], [12, 15]]);
  assert.equal(result.segments.every(x => x.status === 'review_required'), true);
});

test('free road and different name are excluded', () => {
  const proposed = { corredores: [{ nombre: 'Zacapalco–Rancho Viejo', estado: 'calibrable', detalleAnclas: range(4, 8).map(idKm => ({ idKm })) }] };
  const chains = [
    { code: '92', name: 'Zacapalco - Taxco', toll: true, posts: [] },
    { code: '92', name: 'Zacapalco - Rancho Viejo', toll: false, posts: [] }
  ];
  assert.deepEqual(audit.audit(proposed, { chains })[0].segments, []);
});

test('key folds punctuation, dashes and accents the way python isalnum does', () => {
  assert.equal(audit.key('Cuernavaca–Acapulco'), 'cuernavaca acapulco');
  assert.equal(audit.key('Cuernavaca - Acapulco'), 'cuernavaca acapulco');
  assert.equal(audit.key('Acatlán de Juárez - El Trapiche'), 'acatlan de juarez el trapiche');
  assert.equal(audit.key('  '), '');
  assert.equal(audit.key(null), '');
});

test('toll must be a real boolean true, not a truthy value', () => {
  const proposed = { corredores: [{ nombre: 'Cuernavaca - Acapulco', estado: 'calibrable', detalleAnclas: range(1, 5).map(idKm => ({ idKm })) }] };
  const posts = [{ id: 1, km: 1 }, { id: 2, km: 2 }, { id: 3, km: 3 }, { id: 4, km: 4 }];
  const truthy = audit.audit(proposed, { chains: [{ code: '95', name: 'Cuernavaca - Acapulco', toll: 1, posts }] })[0];
  const strict = audit.audit(proposed, { chains: [{ code: '95', name: 'Cuernavaca - Acapulco', toll: true, posts }] })[0];
  assert.equal(truthy.segments.length, 0);
  assert.equal(strict.segments.length, 1);
});

test('duplicate anchors are counted once', () => {
  const anchors = [{ idKm: 1 }, { idKm: 1 }, { idKm: 2 }, { idKm: 3 }, { idKm: 4 }];
  const proposed = { corredores: [{ nombre: 'Cuernavaca - Acapulco', estado: 'calibrable', detalleAnclas: anchors }] };
  const posts = [{ id: 1, km: 1 }, { id: 2, km: 2 }, { id: 3, km: 3 }, { id: 4, km: 4 }];
  const result = audit.audit(proposed, { chains: [{ code: '95', name: 'Cuernavaca - Acapulco', toll: true, posts }] })[0];
  assert.equal(result.candidateAnchors, 4);
  assert.equal(result.segments[0].posts.length, 4);
});

function range(from, to) {
  return Array.from({ length: to - from }, (_, i) => from + i);
}