'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rnc = require('./rnc-loader');

// Pruebas sobre el dataset real construido por tools/build-rnc.js
// (worker/data). Si aún no existe, se omite el módulo entero en vez de fallar.

const index = rnc._loadIndex();
const hasData = !!(index && index.codes && (index.codes['150'] || index.codes['57']));
const opts = hasData ? {} : { skip: 'dataset RNC no construido (node tools/build-rnc.js)' };

test('el índice publica cals certificadas con ventana coherente', opts, () => {
  const metas = index.codes['150'];
  const withCals = metas.filter(m => m.calibrated && m.cals && m.cals.length);
  assert.ok(withCals.length, 'la ruta 150 debe tener cadenas calibradas');
  for (const meta of withCals) {
    assert.ok(meta.anchorPosts >= 3);
    for (const cal of meta.cals) {
      assert.ok(cal.validTo >= cal.validFrom, `${meta.id}: ventana invertida`);
      assert.ok(cal.anchors >= 3, `${meta.id}: cal con menos de 3 anclas`);
      assert.ok(Number.isFinite(cal.kmStart), `${meta.id}: cal sin kmStart`);
    }
    // El nivel superior refleja la primaria (compatibilidad con el loader).
    assert.equal(meta.validFrom, meta.cals[0].validFrom);
    assert.equal(meta.validTo, meta.cals[0].validTo);
  }
});

test('calFor elige la numeración cuya ventana contiene el km consultado', opts, () => {
  const meta = index.codes['150'].find(m => m.cals && m.cals.length >= 2);
  assert.ok(meta, 'la ruta 150 debe publicar cadenas con dos numeraciones (reinicios)');
  // Los extremos de cada ventana certifican dentro de su propia cal.
  for (const cal of meta.cals) {
    for (const km of [cal.validFrom, cal.validTo]) {
      const hit = rnc._calFor(meta, km);
      assert.ok(hit, `km ${km} debe caer en alguna cal`);
      assert.ok(km >= hit.validFrom && km <= hit.validTo, `km ${km} fuera de la cal que devolvió`);
    }
  }
  // Entre ventana y ventana (ordenadas por km) no certifica nada.
  const sorted = [...meta.cals].sort((a, b) => a.validFrom - b.validFrom);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.validTo + 0.1 < b.validFrom) {
      assert.equal(rnc._calFor(meta, (a.validTo + b.validFrom) / 2), null,
        `el hueco [${a.validTo}, ${b.validFrom}] no debe certificar`);
    }
  }
  // Fuera de toda ventana → null.
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  assert.equal(rnc._calFor(meta, lowest.validFrom - 5), null);
  assert.equal(rnc._calFor(meta, highest.validTo + 5), null);
});

test('pointAtChainById distingue poste exacto, interpolación y km fuera de ventana', opts, () => {
  // km 215: existe poste oficial revisado en la 150 (Acatzingo–Córdoba).
  const exact = rnc.pointAtChainById('150', '150:33', 215);
  assert.ok(exact, 'km 215 de la 150 debe resolver');
  assert.equal(exact.precision, 'rnc_poste');
  assert.equal(exact.confidence, 0.93);
  assert.ok(exact.latitude > 18 && exact.latitude < 20, 'poste en el centro de México');
  assert.match(exact.label, /· km 215$/);

  // km 203: dentro de la ventana pero sin poste cercano → interpolación.
  const lerp = rnc.pointAtChainById('150', '150:33', 203);
  assert.ok(lerp, 'km 203 debe interpolar');
  assert.equal(lerp.precision, 'kilometer_rnc_network');
  assert.equal(lerp.confidence, 0.9);
  assert.ok(Math.abs(lerp.latitude - exact.latitude) < 0.5, 'cerca del tramo del poste');

  // km 120: hueco entre numeraciones (0.6–95 y ~150–301) → ninguna cal certifica.
  assert.equal(rnc.pointAtChainById('150', '150:33', 120), null);
  // km 320: más allá de toda ventana de la cadena.
  assert.equal(rnc.pointAtChainById('150', '150:33', 320), null);
});

test('resolveNetworkKilometer resuelve carretera + km dentro de la cascada', opts, () => {
  const hit = rnc.resolveNetworkKilometer('carretera 150 km 215', 215);
  assert.ok(hit, 'con código y km debe resolver');
  assert.equal(hit.corridor, '150');
  assert.equal(hit.status, 'automatic');
  assert.equal(hit.provider, 'rnc_2025');
  assert.ok(hit.latitude >= 14 && hit.latitude <= 33);
  assert.ok(hit.longitude >= -119 && hit.longitude <= -86);

  // km fuera de toda ventana de la red → la cascada sigue al geocodificador.
  assert.equal(rnc.resolveNetworkKilometer('carretera 57 km 9999', 9999), null);
  assert.equal(rnc.resolveNetworkKilometer('carretera 999 km 10', 10), null);
  assert.equal(rnc.resolveNetworkKilometer('', 10), null);
  assert.equal(rnc.resolveNetworkKilometer('carretera 57', NaN), null);
});

test('un código con sufijo D cae a la familia sin perder la pista de cuota', opts, () => {
  // "57D" no existe como CODIGO en el RNC: se resuelve con la familia 57.
  const { candidates } = rnc._candidateMetas('carretera 57D km 45');
  assert.ok(candidates.length, '57D debe caer a la familia 57');
  assert.ok(candidates.every(c => c.code === '57'));
  assert.equal(rnc.resolveNetworkKilometer('carretera 57D km 45', 45)?.corridor, '57');
});

test('la pista de cuota/libre ordena las cadenas exactas antes que Mixto', opts, () => {
  const cuota = rnc._candidateMetas('carretera 150 cuota km 215');
  assert.ok(cuota.candidates.some(c => c.meta.peaje === 'Si'), 'la 150 tiene tramos de cuota');
  const otro = cuota.candidates.findIndex(c => c.meta.peaje !== 'Si');
  const ultimoSi = cuota.candidates.map(c => c.meta.peaje).lastIndexOf('Si');
  if (otro !== -1) assert.ok(ultimoSi < otro, 'Si debe ir antes que cualquier otro');

  const libre = rnc._candidateMetas('carretera 150 libre km 215');
  assert.ok(libre.candidates.some(c => c.meta.peaje === 'No'), 'la 150 tiene tramos libres');
  const otroNo = libre.candidates.findIndex(c => c.meta.peaje !== 'No');
  const ultimoNo = libre.candidates.map(c => c.meta.peaje).lastIndexOf('No');
  if (otroNo !== -1) assert.ok(ultimoNo < otroNo, 'No debe ir antes que cualquier otro');
});

test('la coherencia de nombre evita resolver el km de otra vía con el mismo código', opts, () => {
  const road = 'Autopista Querétaro–Irapuato 45D km 15';
  const { nameHits, candidates } = rnc._candidateMetas(road);
  assert.ok(nameHits > 0, 'el nombre de la consulta existe en la red');
  assert.ok(candidates.length, 'el 45D cae a la familia 45');
  const hit = rnc.resolveNetworkKilometer(road, 15);
  // Si algo resuelve, debe ser en la familia 45 (nunca otra ruta "ventanera").
  if (hit) assert.match(hit.corridor, /^45/, 'resolvió en otra familia: ' + hit.corridor);
});

test('corridorMidpoint devuelve el punto intermedio solo como último recurso', opts, () => {
  const hit = rnc.corridorMidpoint('carretera 57');
  assert.ok(hit, 'el corredor 57 debe tener geometría');
  assert.equal(hit.precision, 'corridor_midpoint');
  assert.equal(hit.confidence, 0.55);
  assert.equal(hit.status, 'approximate');
  assert.ok(hit.latitude >= 14 && hit.latitude <= 33);
  assert.match(hit.label, /punto intermedio del corredor$/);
  // Sin datos para la vía → null (el geocodificador externo decide).
  assert.equal(rnc.corridorMidpoint('brecha inventada XYZ'), null);
});

test('reset limpia la caché sin romper la carga diferida', () => {
  rnc.reset();
  assert.ok(rnc._loadIndex(), 'el índice debe recargar');
  assert.equal(rnc._loadKm('codigo-inexistente'), null);
  assert.ok(rnc._loadKm('150'), 'los km se leen bajo demanda');
  rnc.reset();
});
