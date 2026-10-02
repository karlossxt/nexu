'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rnc = require('./rnc-national-review');

function post(km, lon, ident = null, code = '150', name = 'Acatzingo - Ciudad Mendoza') {
  return { id: ident ?? km, km, lat: 19.0, lon, code, name, roadId: 1, snapM: 0, toll: true };
}

test('rejects parallel free and other code', () => {
  const p = post(104, -103.4);
  const toll = { code: '54', name: 'Acatlán', toll: true, snapM: 10 };
  const free = { code: '54', name: 'Acatlán', toll: false, snapM: 12 };
  const other = { code: '80', name: 'Otra vía', toll: true, snapM: 15 };
  assert.equal(rnc.assignPost(p, [toll, free])[1], 'ambiguous_free_or_other_code');
  assert.equal(rnc.assignPost(p, [toll, other])[1], 'ambiguous_free_or_other_code');
  assert.notEqual(rnc.assignPost(p, [toll, { ...free, snapM: 70 }])[0], null);
});

test('duplicate km is never chosen by closeness', () => {
  const points = [220, 221, 222, 224, 225].map(k => post(k, -97.50 + (k - 220) * .009));
  points.push(post(223, -97.473, 2231), post(223, -97.40, 2232));
  const [chains, flagged] = rnc.reviewedChains(points);
  assert.equal(flagged.filter(p => p.km === 223 && p.reason === 'duplicate_km_same_code').length, 2);
  assert.equal(chains.some(c => c.posts.some(p => p.km === 223)), false);
});

test('chain requires coherence and multiple posts', () => {
  const points = [197, 198, 199, 200].map(k => post(k, -97.50 + (k - 197) * .009));
  points.push(post(201, -98.00));
  const [chains, flagged] = rnc.reviewedChains(points);
  assert.deepEqual(chains.map(c => [c.fromKm, c.toKm]), [[197, 200]]);
  assert.equal(flagged[0].km, 201);
});

test('anchors must match route identity uniquely', () => {
  const a = [197, 198, 199, 200].map(k => post(k, -97.50 + (k - 197) * .009));
  const [chains] = rnc.reviewedChains(a);
  const anchor = { code: '150', name: 'Acatzingo - Ciudad Mendoza', km: 198, lat: 19, lon: a[1].lon };
  assert.equal(rnc.validateAnchors(chains, [anchor]).withinTolerance, 1);
  assert.equal(rnc.validateAnchors(chains, [{ ...anchor, code: '54' }]).withinTolerance, 0);
  assert.equal(rnc.validateAnchors(chains, [{ ...anchor, name: 'otro' }]).results[0].result, 'not_covered');
});

test('pyRound reproduces the half-to-even behaviour of python round()', () => {
  assert.equal(rnc.pyRound(0.5), 0);
  assert.equal(rnc.pyRound(1.5), 2);
  assert.equal(rnc.pyRound(2.5), 2);
  assert.equal(rnc.pyRound(3.5), 4);
  assert.equal(rnc.pyRound(-0.5), 0);
  assert.equal(rnc.pyRound(12.25, 1), 12.2);
  assert.equal(rnc.pyRound(12.35, 1), 12.4);
});

test('an unnamed toll road is refused without plaza verification', () => {
  const p = post(50, -99.1);
  const anonymous = { roadId: 777, code: '57', name: 'N/A', toll: true, snapM: 20 };
  const [selected, reason] = rnc.assignPost(p, [anonymous]);
  assert.equal(selected, null);
  assert.equal(reason, 'no_named_toll_road_within_120m');
});

test('placeholders N/D and N/A never count as a real road name', () => {
  const p = post(50, -99.1);
  for (const name of ['N/A', 'N/D', 'n/a', 'n/d', 'N/A ']) {
    const road = { roadId: 777, code: '57', name, toll: true, snapM: 20 };
    assert.equal(rnc.assignPost(p, [road])[0], null, `debería rechazar ${name}`);
  }
});

test('a plaza-verified road lends its name without moving the post', () => {
  const p = post(50, -99.1, 5001);
  const anonymous = { roadId: 219, code: '57', name: 'N/A', toll: true, snapM: 20 };
  const verification = new Map([[219, { code: '57', names: ['La Venta - Lechería'] }]]);
  const [selected, reason] = rnc.assignPost(p, [anonymous], 30, verification);
  assert.equal(reason, null);
  assert.equal(selected.name, 'La Venta - Lechería');
  assert.equal(selected.nameSource, 'toll_plaza_verified');
  // La posición sigue siendo la del poste: la identidad viene de la plaza, no
  // de haber movido el punto.
  assert.equal(selected.lon, -99.1);
  assert.equal(selected.km, 50);
  assert.equal(selected.roadId, 219);
});

test('verification of a different route code is refused', () => {
  const p = post(50, -99.1);
  const anonymous = { roadId: 219, code: '57', name: 'N/A', toll: true, snapM: 20 };
  const wrongCode = new Map([[219, { code: '150', names: ['Otra'] }]]);
  const [selected, reason] = rnc.assignPost(p, [anonymous], 30, wrongCode);
  assert.equal(selected, null);
  assert.equal(reason, 'no_named_toll_road_within_120m');
});

test('an unknown roadId is never rescued by any verification index', () => {
  const p = post(50, -99.1);
  const anonymous = { roadId: 999999, code: '57', name: 'N/A', toll: true, snapM: 20 };
  const verification = new Map([[219, { code: '57', names: ['La Venta - Lechería'] }]]);
  assert.equal(rnc.assignPost(p, [anonymous], 30, verification)[0], null);
});

test('a road with its own real name is never overwritten by the plaza index', () => {
  const p = post(50, -99.1);
  const named = { roadId: 219, code: '57', name: 'Nombre propio', toll: true, snapM: 20 };
  const verification = new Map([[219, { code: '57', names: ['La Venta - Lechería'] }]]);
  const [selected] = rnc.assignPost(p, [named], 30, verification);
  assert.equal(selected.name, 'Nombre propio');
  assert.equal(selected.nameSource, 'road');
});

test('a verified road still loses against a real parallel corridor', () => {
  const p = post(50, -99.1);
  const anonymous = { roadId: 219, code: '57', name: 'N/A', toll: true, snapM: 20 };
  const parallel = { roadId: 300, code: '57', name: 'Otro tramo', toll: true, snapM: 25 };
  const verification = new Map([[219, { code: '57', names: ['La Venta - Lechería'] }]]);
  const [selected, reason] = rnc.assignPost(p, [anonymous, parallel], 30, verification);
  assert.equal(selected, null);
  assert.equal(reason, 'ambiguous_corridor_name');
});

test('loadPlazaVerification accepts both an array and a wrapped report', () => {
  const entries = [{ idRed: 219, code: '57', names: ['A'] }];
  assert.equal(rnc.loadPlazaVerification(null).size, 0);
  assert.deepEqual([...rnc.loadPlazaVerification(entries)], [[219, { code: '57', names: ['A'] }]]);
  assert.equal(rnc.loadPlazaVerification({ entries }).size, 1);
  // Sin nombres no hay nada que prestar: la entrada se descarta.
  assert.equal(rnc.loadPlazaVerification([{ idRed: 1, code: '57', names: [] }]).size, 0);
});

test('parseArgs reads positional and optional arguments without dropping values', () => {
  const base = { plazaVerification: null };
  assert.deepEqual(rnc.parseArgs(['a.gpkg', 'b.json']), { gpkg: 'a.gpkg', output: 'b.json', limit: 0, anchors: null, ...base });
  assert.deepEqual(rnc.parseArgs(['a.gpkg', 'b.json', '--limit', '3000']),
    { gpkg: 'a.gpkg', output: 'b.json', limit: 3000, anchors: null, ...base });
  assert.deepEqual(rnc.parseArgs(['a.gpkg', 'b.json', '--anchors', 'x.json', '--limit', '10']),
    { gpkg: 'a.gpkg', output: 'b.json', limit: 10, anchors: 'x.json', ...base });
  assert.deepEqual(rnc.parseArgs(['a.gpkg', 'b.json', '--plaza-verification', 'v.json']),
    { gpkg: 'a.gpkg', output: 'b.json', limit: 0, anchors: null, plazaVerification: 'v.json' });
});

test('geometry decodes GeoPackage point and linestring headers', () => {
  // Envoltura vacía, punto little-endian.
  const header = Buffer.alloc(8);
  header.write('GP', 0, 'latin1');
  header[3] = 0x01;
  const blob = Buffer.concat([header, Buffer.from([0x01]), int32LE(1), doubleLE(-99.1333), doubleLE(19.432)]);
  assert.deepEqual(rnc.geometry(blob), [[-99.1333, 19.432]]);
  assert.throws(() => rnc.geometry(Buffer.from('XX')), /Expected GeoPackage geometry/);
});

function int32LE(value) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
}
function doubleLE(value) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(value);
  return b;
}