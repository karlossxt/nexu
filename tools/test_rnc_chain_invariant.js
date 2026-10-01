'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  separationM, normalize, checkChain, checkBridge, bridgeHasPostsOnBothSides,
  evaluate, summarize, VERDICTS, JOIN_RATIO_MIN, JOIN_RATIO_MAX, M_PER_DEG
} = require('./rnc-chain-invariant');

const fedRoad = { toll: true, admin: 'Federal', nivel: 0 };
const stateRoad = { toll: true, admin: 'Estatal', nivel: 0 };
const gradeRoad = { toll: true, admin: 'Federal', nivel: 1 };

// Un par de postes a 1 km exacto en latitud: ~1000 m por grado.
function postAt(id, km, roadId, lat) {
  return { id, km, roadId, lat, lon: -100, snappedLat: lat, snappedLon: -100 };
}

function roads(map) {
  const m = new Map();
  for (const [id, r] of Object.entries(map)) m.set(Number(id), r);
  return m;
}

test('separationM usa coseno de latitud, no distancia en grados', () => {
  const a = postAt(1, 0, 1, 0), b = postAt(2, 1, 1, 1);
  const d = separationM(a, b);
  assert.ok(Math.abs(d - M_PER_DEG) < 1, `esperaba ~${M_PER_DEG}, obtuve ${d}`);
  // A 45 grados, un grado de longitud es mas corto que uno de latitud.
  const c = postAt(3, 0, 1, 45), e = postAt(4, 1, 1, 45);
  assert.ok(separationM(c, e) < d, 'la longitud debe comprimirse con la latitud');
});

test('normalize conserva los digitos que son parte del toponimo', () => {
  // Un filtro de 1-3 digitos habria vuelto esto "de septiembre" y lo habria
  // hecho coincidir con cualquier otro tramo quecomparta esas palabras.
  assert.equal(normalize('16 de Septiembre'), '16 de septiembre');
  assert.ok(normalize('Paso del Toro - Veracruz') !== normalize('Cordoba - Veracruz'));
  assert.equal(normalize('Culiacán'), normalize('Culiacan'), 'los acentos no distinguen corredores');
});

test('cadena de cuota sin federal y con desnivel se marca, no se rechaza', () => {
  const chain = {
    code: '1', name: 'Culiacan - Las Brisas', fromKm: 2, toKm: 11,
    posts: [postAt(1, 2, 10, 24.7), postAt(2, 3, 10, 24.71), postAt(3, 4, 11, 24.72), postAt(4, 5, 11, 24.73)],
  };
  const r = checkChain(chain, roads({ 10: stateRoad, 11: gradeRoad }));
  assert.ok(r.flags.includes(VERDICTS.no_entity), 'debe reportar entidad');
  assert.ok(r.flags.includes(VERDICTS.grade_separated), 'debe reportar ramal');
});

test('entidad y ramal son independientes: no se confundan', () => {
  // Medido: ambas marcas aparecen en 23 de 127 cadenas pero solo coinciden en 4.
  const soloEntidad = checkChain({
    code: '1', name: 'A', fromKm: 0, toKm: 1,
    posts: [postAt(1, 0, 10, 0), postAt(2, 1, 10, 0.01), postAt(3, 2, 10, 0.02), postAt(4, 3, 10, 0.03)],
  }, roads({ 10: stateRoad }));
  assert.ok(soloEntidad.flags.includes(VERDICTS.no_entity));
  assert.ok(!soloEntidad.flags.includes(VERDICTS.grade_separated), 'nivel 0 no debe marcar ramal');

  const soloRamal = checkChain({
    code: '1', name: 'A', fromKm: 0, toKm: 1,
    posts: [postAt(1, 0, 10, 0), postAt(2, 1, 10, 0.01), postAt(3, 2, 10, 0.02), postAt(4, 3, 10, 0.03)],
  }, roads({ 10: gradeRoad }));
  assert.ok(soloRamal.flags.includes(VERDICTS.grade_separated));
  assert.ok(!soloRamal.flags.includes(VERDICTS.no_entity), 'Federal no debe marcar entidad');
});

test('un tramo libre dentro de una cadena de cuota se detecta siempre', () => {
  const r = checkChain({
    code: '1', name: 'A', fromKm: 0, toKm: 1,
    posts: [postAt(1, 0, 10, 0), postAt(2, 1, 10, 0.01), postAt(3, 2, 11, 0.02), postAt(4, 3, 11, 0.03)],
  }, roads({ 10: fedRoad, 11: { toll: false, admin: 'Federal', nivel: 0 } }));
  assert.ok(r.flags.includes('has_free_road_segment'), 'un tramo libre rompe la garantia de cuota');
});

test('ID_KM mezclado se marca, pero un solo sentido no', () => {
  // ID_KM corre al reves del sentido real: km creciendo con ID cayendo es lo
  // normal y no debe marcarse.
  const oneWayDown = checkChain({
    code: '1', name: 'A', fromKm: 0, toKm: 3,
    posts: [postAt(4, 0, 10, 0), postAt(3, 1, 10, 0.01), postAt(2, 2, 10, 0.02), postAt(1, 3, 10, 0.03)],
  }, roads({ 10: fedRoad }));
  assert.ok(!oneWayDown.flags.includes(VERDICTS.mixed_direction), 'un solo sentido no es mezcla');

  const mixed = checkChain({
    code: '1', name: 'A', fromKm: 0, toKm: 3,
    posts: [postAt(4, 0, 10, 0), postAt(3, 1, 10, 0.01), postAt(2, 2, 10, 0.02), postAt(5, 3, 10, 0.03)],
  }, roads({ 10: fedRoad }));
  assert.ok(mixed.flags.includes(VERDICTS.mixed_direction), 'subir y bajar ID_KM dentro de la cadena es mezcla');
});

test('checkBridge acepta un hueco continuo y rechaza uno imposible', () => {
  // 10 km de hueco. Un grado de latitud son M_PER_DEG metros, asi que la
  // separacion que produce ~1000 m/km es gapKm*1000/M_PER_DEG grados.
  const gapKm = 10;
  const latForOneKm = 1000 / M_PER_DEG;
  const lower = { posts: [postAt(1, 10, 10, 20.0)] };
  const upper = { posts: [postAt(2, 20, 10, 20.0 + gapKm * latForOneKm)] };
  const ok = checkBridge(lower, upper);
  assert.ok(ok.ratio >= JOIN_RATIO_MIN && ok.ratio <= JOIN_RATIO_MAX,
    `ratio ${ok.ratio} deberia caer en [${JOIN_RATIO_MIN}, ${JOIN_RATIO_MAX}]`);
  assert.equal(ok.verdict, VERDICTS.ok);

  // Mismo hueco de km pero los extremos estan a ~1 km: no es el mismo tramo.
  const near = { posts: [postAt(2, 20, 10, 20.0 + latForOneKm)] };
  const bad = checkBridge(lower, near);
  assert.equal(bad.verdict, VERDICTS.bridge_too_long, 'dos kilometrajes a 1 km no son un corredor continuo');
  assert.ok(bad.ratio < JOIN_RATIO_MIN, `ratio ${bad.ratio} deberia quedar bajo el minimo`);
});

test('checkBridge nunca divide por cero si el hueco de km es cero', () => {
  const r = checkBridge({ posts: [postAt(1, 10, 10, 20.0)] }, { posts: [postAt(2, 10, 10, 21.0)] });
  assert.equal(r.verdict, VERDICTS.bridge_too_long);
  assert.equal(r.ratio, null, 'sin division por cero');
});

test('bridgeHasPostsOnBothSides exige apoyo a los dos lados del hueco', () => {
  const lower = { posts: [postAt(1, 8, 10, 20.0), postAt(2, 10, 10, 20.01)] };
  const upper = { posts: [postAt(3, 20, 10, 20.02), postAt(4, 22, 10, 20.03)] };
  assert.equal(bridgeHasPostsOnBothSides(lower, upper, 3), true, 'hay postes cerca de ambos extremos');

  // El extremo inferior es el ultimo de su tramo: no hay apoyo despues de el.
  const sinApoyo = { posts: [postAt(3, 20, 10, 20.02), postAt(4, 22, 10, 20.03)] };
  assert.equal(bridgeHasPostsOnBothSides({ posts: [postAt(1, 10, 10, 20.0)] }, sinApoyo, 3), false);
});

test('evaluate agrupa por (codigo, nombre) y no solo por codigo', () => {
  // El codigo 15 cubre 39 secciones declaradas: agrupar solo por codigo
  // mezclaria corredores distintos.
  const mk = (code, name, kmBase) => ({
    code, name, fromKm: kmBase, toKm: kmBase + 3,
    posts: [postAt(kmBase + 1, kmBase, 10, 20 + kmBase / 100), postAt(kmBase + 2, kmBase + 1, 10, 20 + kmBase / 100 + .01),
            postAt(kmBase + 3, kmBase + 2, 10, 20 + kmBase / 100 + .02), postAt(kmBase + 4, kmBase + 3, 10, 20 + kmBase / 100 + .03)],
  });
  const review = { chains: [mk('15', 'A - B', 0), mk('15', 'C - D', 100), mk('15', 'A - B', 50)] };
  const r = evaluate(review, roads({ 10: fedRoad }));
  assert.equal(r.corridors.length, 2, 'dos nombres distintos son dos corredores aunque sharean codigo');
  const ab = r.corridors.find(c => c.name === normalize('A - B'));
  assert.equal(ab.fragments, 2, 'los dos fragmentos de A-B deben unirse');
  assert.equal(ab.posts, 8);
});

test('summarize cuenta un veredicto por cadena y reporta vacios como cero', () => {
  const review = {
    chains: [{
      code: '1', name: 'A', fromKm: 0, toKm: 3,
      posts: [postAt(1, 0, 10, 0), postAt(2, 1, 10, 0.01), postAt(3, 2, 10, 0.02), postAt(4, 3, 10, 0.03)],
    }],
  };
  const s = summarize(evaluate(review, roads({ 10: fedRoad })));
  assert.equal(s.chains, 1);
  assert.equal(s.corridors, 1);
  assert.equal(s.bridges, 0, 'una cadena sin partir no genera puentes');
  assert.equal(s.chainVerdicts[VERDICTS.ok], 1);
});

test('la normalizacion de nombres no hace que dos corredores distintos coincidan', () => {
  // Regresion: estos tres se parecen mucho y el invariante de plaza ya los
  // treats como desacuerdo, no como coincidencia.
  assert.notEqual(normalize('Gómez Palacio - Jiménez'), normalize('Gómez Palacio - Zaragoza'));
  assert.notEqual(normalize('Ciudad Mendoza'), normalize('Cd. Mendoza'));
});