'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalized, point, catalog } = require('./rnc-toll-plazas');

// Tamaño de la envolvente en bytes según el indicador de los flags.
const ENVELOPE = [0, 32, 48, 48, 64, 0, 0, 0];

function gpkgHeader(envelope, little) {
  const buffer = Buffer.alloc(8 + ENVELOPE[envelope] + 64);
  buffer.write('GP', 0, 'latin1');
  buffer[2] = 0;
  buffer[3] = (envelope << 1) | (little ? 1 : 0);
  const pos = 8 + ENVELOPE[envelope];
  buffer[pos] = little ? 1 : 0;
  return { buffer, pos };
}

function gpkgPoint(x, y, { envelope = 0, little = true, code = 1 } = {}) {
  const { buffer, pos } = gpkgHeader(envelope, little);
  if (little) {
    buffer.writeUInt32LE(code, pos + 1);
    buffer.writeDoubleLE(x, pos + 5);
    buffer.writeDoubleLE(y, pos + 13);
  } else {
    buffer.writeUInt32BE(code, pos + 1);
    buffer.writeDoubleBE(x, pos + 5);
    buffer.writeDoubleBE(y, pos + 13);
  }
  return buffer.subarray(0, pos + 21);
}

function plaza(ident, name, section, lon, lat) {
  return [ident, name, section, gpkgPoint(lon, lat)];
}

test('gpkg point survives both endiannesses and every envelope size', () => {
  for (const little of [true, false]) {
    for (const envelope of [0, 1, 2, 3, 4]) {
      assert.deepEqual(point(gpkgPoint(-99.27111721, 19.58254042, { envelope, little })), [-99.27111721, 19.58254042]);
    }
  }
});

test('geometry code is read modulo 1000 so Z and M points still decode', () => {
  assert.deepEqual(point(gpkgPoint(-99.5, 19.5, { code: 1001 })), [-99.5, 19.5]);
  assert.deepEqual(point(gpkgPoint(-99.5, 19.5, { code: 2001 })), [-99.5, 19.5]);
});

test('a non-point blob is refused rather than misread as coordinates', () => {
  const line = gpkgHeader(0, true);
  line.buffer.writeUInt32LE(2, line.pos + 1);
  assert.throws(() => point(line.buffer.subarray(0, line.pos + 40)), /Expected Point geometry/);
  assert.throws(() => point(Buffer.from('XXnotageopackage')), /Expected GeoPackage point/);
});

test('normalized folds accents, case and repeated whitespace', () => {
  assert.equal(normalized('  Plaza de Cobro   Atizapán '), 'plaza de cobro atizapan');
  // La raya no es diacrítico: sobrevive al NFD como ella misma, no como guion.
  assert.equal(normalized('CHAMAPA – LECHERÍA'), 'chamapa – lecheria');
  assert.equal(normalized(null), '');
  assert.equal(normalized(undefined), '');
});

test('unnamed plazas and missing sections are counted and never grouped', () => {
  const rows = [
    plaza(1, 'Atizapán', 'Chamapa - Lechería', -99.27, 19.58),
    plaza(2, null, 'Chamapa - Lechería', -99.27, 19.58),
    plaza(3, '', 'Chamapa - Lechería', -99.27, 19.58),
    plaza(4, 'N/D', 'Chamapa - Lechería', -99.27, 19.58),
    plaza(5, 'N/A', 'Chamapa - Lechería', -99.27, 19.58),
    plaza(6, 'Sin Nombre', 'Chamapa - Lechería', -99.27, 19.58),
    plaza(7, 'Atizapán', null, -99.27, 19.58),
    plaza(8, 'Atizapán', 'N/D', -99.27, 19.58),
    plaza(9, 'Atizapán', 'N/A', -99.27, 19.58)
  ];
  const { selected, rejected } = catalog(rows);
  assert.equal(selected.length, 1);
  assert.deepEqual(rejected, { unnamed_or_no_section: 8 });
});

test('lanes of one plaza collapse to the centroid and count each source id', () => {
  const rows = [
    plaza(730, 'Atizapán', 'Chamapa - Lechería', -99.2711, 19.5825),
    plaza(731, 'Atizapán', 'Chamapa - Lechería', -99.2712, 19.5826),
    plaza(732, 'Atizapán', 'Chamapa - Lechería', -99.27115, 19.58255)
  ];
  const { selected } = catalog(rows);
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].sourceIds, [730, 731, 732]);
  assert.equal(selected[0].name, 'Atizapán');
  assert.equal(selected[0].section, 'Chamapa - Lechería');
});

test('source ids sort numerically, not lexicographically', () => {
  const rows = [10, 2, 9, 100].map(id => plaza(id, 'X', 'Y', -99.27, 19.58));
  assert.deepEqual(catalog(rows).selected[0].sourceIds, [2, 9, 10, 100]);
});

test('lanes more than 250 m apart are dropped whole and counted per lane', () => {
  const rows = [
    plaza(1, 'Dispersa', 'Corredor', -99.0, 19.0),
    plaza(2, 'Dispersa', 'Corredor', -99.0, 19.0 + 600 / 111195)
  ];
  const { selected, rejected } = catalog(rows);
  assert.equal(selected.length, 0);
  assert.equal(rejected.spread_over_250m, 2);
});

test('longitude spread is scaled by the cosine of latitude', () => {
  // 0.0045 grados de longitud a los 19 grados son 473 m con la corrección del
  // coseno (dispersión 236 m, se acepta) y 500 m sin ella (dispersión 250 m,
  // se rechazaría). El resultado fija la corrección.
  const rows = [
    plaza(1, 'Ancha', 'Corredor', -100.0, 19.0),
    plaza(2, 'Ancha', 'Corredor', -100.0 + 0.0045, 19.0)
  ];
  const { selected, rejected } = catalog(rows);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].spreadM, 237);
  assert.equal(rejected.spread_over_250m, undefined);
});

test('group key is a pair, so a name and section cannot run together', () => {
  const rows = [
    plaza(1, 'A', 'BC', -99.0, 19.0),
    plaza(2, 'AB', 'C', -99.0, 19.0)
  ];
  assert.equal(catalog(rows).selected.length, 2);
});

test('catalog sorts by name then section, normalized', () => {
  const rows = [
    plaza(1, 'zeta', 'B', -99.0, 19.0),
    plaza(2, 'Alfa', 'C', -99.0, 19.0),
    plaza(3, 'Alfa', 'A', -99.0, 19.0)
  ];
  assert.deepEqual(catalog(rows).selected.map(e => [e.name, e.section]), [
    ['Alfa', 'A'], ['Alfa', 'C'], ['zeta', 'B']
  ]);
});
