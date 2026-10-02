'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const batch = require('./rnc-batch-review');

test('exact road and km are candidates only', () => {
  const report = { chains: [{ code: '95', name: 'Cuernavaca - Acapulco', fromKm: 140, toKm: 145, posts: [{ km: 142, id: 1510 }] }] };
  const alerts = [
    { id: 'a', road: 'Autopista Cuernavaca - Acapulco', kilometer: 142, latitude: null, longitude: null },
    { id: 'b', road: 'Autopista Cuernavaca - Acapulco', kilometer: 142, latitude: null, longitude: null },
    { id: 'c', road: 'Autopista Cuernavaca - Acapulco', kilometer: 142, latitude: 18.5, longitude: -99.2 },
    { id: 'd', road: 'Autopista Cuernavaca - Iguala', kilometer: 142, latitude: null, longitude: null }
  ];
  const result = batch.review(alerts, report);
  assert.equal(result[0].alerts, 2);
  assert.equal(result[0].reason, 'exact_post_needs_review');
  assert.equal(result[0].status, 'review_required');
  assert.equal(result[1].reason, 'no_matching_chain');
});

test('shared place name does not equate distinct corridors', () => {
  assert.equal(batch.nameMatches('Zacapalco - Rancho Viejo', 'Zacapalco - Taxco'), false);
});

test('traffic samples rank only matching roads without approving posts', () => {
  const alerts = [{ road: 'Autopista Querétaro - Irapuato', kilometer: 63 }, { road: 'Autopista Zacapalco - Rancho Viejo', kilometer: 8 }];
  const samples = [{ road: 'Querétaro - Irapuato', tdpa: 15370, year: 2024 }];
  const result = batch.review(alerts, { chains: [] }, samples);
  assert.equal(result[0].road, alerts[0].road);
  assert.equal(result[0].trafficSample.tdpa, 15370);
  assert.equal(result[0].status, 'review_required');
  assert.equal(result[1].trafficSample, null);
});

test('a road name must match completely and in order', () => {
  assert.equal(batch.nameMatches('Autopista Cuernavaca - Acapulco', 'Cuernavaca - Acapulco'), true);
  assert.equal(batch.nameMatches('Acapulco - Cuernavaca', 'Cuernavaca - Acapulco'), false);
  assert.equal(batch.nameMatches('Cuernavaca', 'Cuernavaca - Acapulco'), false);
  // El número de ruta sobrevive al filtrado de palabras vacías, así que un
  // alerts que lo traiga nunca empata con la cadena. Igual que en Python.
  assert.equal(batch.nameMatches('Carretera Federal 95 Cuernavaca - Acapulco', 'Cuernavaca - Acapulco'), false);
});

test('corrupt kilometres never become a plausible review item', () => {
  const report = { chains: [{ code: '95', name: 'Cuernavaca - Acapulco', fromKm: 0, toKm: 200, posts: [] }] };
  const alerts = [
    { road: 'Cuernavaca - Acapulco', kilometer: true },
    { road: 'Cuernavaca - Acapulco', kilometer: '' },
    { road: 'Cuernavaca - Acapulco', kilometer: '   ' },
    { road: 'Cuernavaca - Acapulco', kilometer: 'no aplica' },
    { road: 'Cuernavaca - Acapulco', kilometer: null },
    { road: 'Cuernavaca - Acapulco', kilometer: '142' }
  ];
  const result = batch.review(alerts, report);
  assert.deepEqual(result.map(r => r.kilometer), [142]);
});

test('already located alerts are never queued for review', () => {
  const report = { chains: [] };
  const alerts = [
    { id: 'a', road: 'Cuernavaca - Acapulco', kilometer: 142, latitude: 18.5, longitude: null },
    { id: 'b', road: 'Cuernavaca - Acapulco', kilometer: 142, latitude: null, longitude: -99.2 },
    { id: 'c', road: 'Cuernavaca - Acapulco', kilometer: 142, latitude: null, longitude: null }
  ];
  assert.equal(batch.review(alerts, report).length, 1);
});

test('ambiguous chains outrank a single exact post', () => {
  const post = { km: 142, id: 1510 };
  const report = {
    chains: [
      { code: '95', name: 'Cuernavaca - Acapulco', fromKm: 140, toKm: 145, posts: [post] },
      { code: '150', name: 'Cuernavaca - Acapulco', fromKm: 140, toKm: 145, posts: [{ km: 142, id: 9999 }] }
    ]
  };
  const alerts = [{ road: 'Cuernavaca - Acapulco', kilometer: 142 }];
  const result = batch.review(alerts, report);
  assert.equal(result[0].reason, 'ambiguous_chains');
  assert.equal(result[0].candidates.length, 2);
});