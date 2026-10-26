'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rncNetworkDecision, sectionNamedInRoad, RNC_NETWORK_PRECISIONS } = require('./rnc-precision');

const geo = (over = {}) => ({ latitude: 18.9, longitude: -96.9, precision: 'rnc_poste', confidence: 0.93, provider: 'rnc_2025', matched_alias: 'Córdoba - Veracruz', ...over });

test('contrato: toda precisión que puede devolver rnc-loader la reconoce la compuerta', () => {
  const loader = fs.readFileSync(path.join(__dirname, 'rnc-loader.js'), 'utf8');
  const m = loader.match(/precision:\s*viaPost\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
  assert.ok(m, 'no se encontró la asignación de precisión en rnc-loader.js');
  for (const precision of [m[1], m[2]]) {
    assert.ok(RNC_NETWORK_PRECISIONS.has(precision), `la compuerta no conoce "${precision}"`);
    assert.ok(rncNetworkDecision(geo({ precision }), { state: 'Veracruz', road: 'Autopista Córdoba - Veracruz' }), precision);
  }
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(index, /rncNetworkDecision\(geo,\{ state, road \}\)/, 'index.js debe usar rncNetworkDecision en la compuerta');
});

test('con estado verificado se acepta el poste y la interpolación', () => {
  assert.deepEqual(rncNetworkDecision(geo({ state_verified: true }), { state: 'Veracruz', road: 'Autopista Córdoba - Veracruz' }), { ok: true, reason: 'trusted_rnc_official_post' });
  assert.equal(rncNetworkDecision(geo({ precision: 'kilometer_rnc_network', confidence: 0.9, state_verified: true }), { state: 'Puebla', road: 'x' }).reason, 'trusted_rnc_interpolated');
});

test('con estado pero sin verificación se rechaza', () => {
  assert.equal(rncNetworkDecision(geo(), { state: 'Veracruz', road: 'Autopista Córdoba - Veracruz' }).reason, 'rnc_network_state_unverified');
});

test('sin estado solo se acepta si el tramo se eligió por nombre', () => {
  assert.equal(rncNetworkDecision(geo(), { state: '', road: 'Autopista Córdoba - Veracruz' }).ok, true);
  // "15D" se resolvió solo por el número a un tramo de otro estado: no se debe confiar
  const wrong = geo({ matched_alias: 'Tepic - Mazatlán', precision: 'kilometer_rnc_network', confidence: 0.9 });
  assert.equal(rncNetworkDecision(wrong, { state: '', road: 'Autopista 15D' }).reason, 'rnc_network_matched_by_code_only');
});

test('abreviaturas y "Cuota" no impiden reconocer el nombre del tramo', () => {
  assert.ok(sectionNamedInRoad('Acatzingo - Ciudad Mendoza', 'Autopista Acatzingo - Cd. Mendoza'));
  assert.ok(sectionNamedInRoad('México - Cuernavaca Cuota', 'Autopista México-Cuernavaca'));
  assert.ok(!sectionNamedInRoad('Tepic - Puerto Vallarta', 'Carretera federal 200'));
  assert.ok(!sectionNamedInRoad('', 'Autopista X'));
});

test('confianza baja, proveedor ajeno y otras precisiones', () => {
  assert.equal(rncNetworkDecision(geo({ confidence: 0.6, state_verified: true }), { state: 'Veracruz' }).reason, 'low_confidence_rnc_network');
  assert.equal(rncNetworkDecision(geo({ provider: 'google', state_verified: true }), { state: 'Veracruz' }).reason, 'rnc_network_unknown_provider');
  assert.equal(rncNetworkDecision({ precision: 'kilometer_rnc' }, {}), null);
  assert.equal(rncNetworkDecision(null, {}), null);
});
