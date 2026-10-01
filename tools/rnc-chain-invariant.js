'use strict';

// Phase C: invariantes mecanicos sobre las cadenas candidatas del RNC.
//
// Ninguno de estos invariantes aprueba ni corrige una coordenada. Solo separan
// cadenas que se pueden usar para interpolar un kilometraje de aquellas que no.
// La decision de publicarlas sigue siendo de una persona.
//
// Lo que se midio sobre RNC 2025 y por que cada invariante existe:
//
// - cuota/libre  127/127 cadenas son de cuota. Discrimina cero. Se conserva
//                porque es la unica garantia de que un tramo "libre" nunca se
//                promueva como si fuera de cuota, y porque el RNC si distingue
//                ('Si'/'No' sobre 4,349,691 filas), pero no se presume util.
// - entidad      ADMINISTRA='Federal' en 104 de 127. Las 23 restantes son de
//                cuota Estatal, y 9 de esos codigos no tienen ninguna cadena
//                Federal. Sonvias legitimas, no un error: por eso este
//                invariante REPORTA y no RECHAZA.
// - ramal        NIVEL distinto de 0 en 23 de 127. Se solapa con entidad en
//                solo 4: son señales independientes. Un poste sobre un tramo a
//                desnivel puede seguir siendo valido, asi que tambien reporta.
// - cadenamiento  ID_KM corre al reves del sentido de la carretera, asi que solo
//                se usa para detectar mezcla de sentidos dentro de una cadena,
//                nunca para derivar kilometraje.
// - vecinos      El que de verdad decide. Medido: distancia/salto de km entre
//                postes consecutivos esta en 864-1060 m (p05-p95), muy ajustado.
//                Entre fragmentos de un mismo corredor, 61 de 72 uniones dan
//                ~1000 m/km: el divisor partio cadenas por huecos >3 km, no por
//                discontinuidades reales. Unir es lo correcto y el invariante
//                dice cuales uniones son seguras.

const M_PER_DEG = 111320;

// Rango de razon aceptable entre el hueco de km y la distancia medida. El
// gauge medio del RNC ronda 1000 m/km; una carretera de cuota serpentea, asi
// que se admite margen. Fuera de este rango los dos extremos NO son el mismo
// tramo y no se deben unir ni interpolar a traves.
const JOIN_RATIO_MIN = 600;
const JOIN_RATIO_MAX = 1400;

const VERDICTS = {
  ok: 'chain_usable_for_interpolation',
  no_entity: 'chain_not_federal_reported',
  grade_separated: 'chain_has_grade_separation_reported',
  mixed_direction: 'chain_mixes_id_km_direction',
  bridge_too_long: 'bridge_geometry_mismatch_rejected',
  bridge_missing_neighbor: 'bridge_has_no_adjacent_post',
};

function separationM(a, b) {
  const lat = (a.lat + b.lat) / 2;
  return Math.hypot((a.lon - b.lon) * Math.cos((lat * Math.PI) / 180), a.lat - b.lat) * M_PER_DEG;
}

// Normaliza para comparar dos hitos de un mismo corredor. Los digitos se
// conservan: en un nombre de tramo suelen ser parte del toponimo
// ("16 de Septiembre") y no una medida de ruta.
function normalize(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function checkChain(chain, roads) {
  const list = [...chain.posts].sort((a, b) => a.km - b.km);
  const own = [...new Set(list.map(p => p.roadId))].map(id => roads.get(Number(id))).filter(Boolean);
  const flags = [];

  // cuota/libre: la unica garantia dura.
  const anyFree = own.some(r => r.toll === false);
  if (anyFree) flags.push('has_free_road_segment');

  // entidad: informativo. Una cuota estatal es legitima.
  const admins = [...new Set(own.map(r => r.admin))].sort();
  if (own.length && !admins.every(a => a === 'Federal')) flags.push(VERDICTS.no_entity);

  // ramal: informativo, independiente de entidad.
  const levels = [...new Set(own.map(r => String(r.nivel)))];
  if (own.length && !(levels.length === 1 && levels[0] === '0')) flags.push(VERDICTS.grade_separated);

  // cadenamiento: ID_KM solo detecta mezcla de sentido. Nunca deriva km.
  let up = 0, down = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].id > list[i - 1].id) up++;
    else if (list[i].id < list[i - 1].id) down++;
  }
  if (up > 0 && down > 0) flags.push(VERDICTS.mixed_direction);

  return { code: chain.code, name: chain.name, fromKm: chain.fromKm, toKm: chain.toKm, posts: list.length, admins, levels, flags };
}

// Decide si dos fragmentos del mismo corredor se pueden unir. Devuelve el
// veredicto y la razon medida, nunca una coordenada.
function checkBridge(lower, upper) {
  const a = lower.posts[lower.posts.length - 1];
  const b = upper.posts[0];
  const gapKm = b.km - a.km;
  if (!(gapKm > 0)) return { verdict: VERDICTS.bridge_too_long, ratio: null, gapKm, distanceM: null };
  const distanceM = separationM(a, b);
  const ratio = distanceM / gapKm;
  const verdict = ratio >= JOIN_RATIO_MIN && ratio <= JOIN_RATIO_MAX
    ? VERDICTS.ok
    : VERDICTS.bridge_too_long;
  return { verdict, ratio: Math.round(ratio), gapKm, distanceM: Math.round(distanceM), fromKm: a.km, toKm: b.km };
}

// Ademas de la razon, un puente necesita un poste a cada lado del hueco: si el
// hueco es de km pero no hay poste intermedio en ninguno de los tramos, el
// kilometraje救人 se apoya solo en la geometria del extremo.
function bridgeHasPostsOnBothSides(lower, upper, maxGapKm) {
  const a = lower.posts[lower.posts.length - 1];
  const b = upper.posts[0];
  const withinLower = lower.posts.some(p => p.km > a.km - maxGapKm && p.km < a.km);
  const withinUpper = upper.posts.some(p => p.km > b.km && p.km < b.km + maxGapKm);
  return withinLower && withinUpper;
}

function evaluate(review, roads) {
  const chains = review.chains;
  const chainReports = chains.map(c => checkChain(c, roads));

  // Agrupar por corredor. Se usa el par (code, name), no solo el codigo: el 15
  // cubre 39 secciones declaradas y el codigo solo no discrimina.
  const groups = new Map();
  chains.forEach((c, i) => {
    const key = JSON.stringify([c.code, normalize(c.name)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  const corridors = [];
  const bridges = [];
  for (const [key, indexes] of groups) {
    const parts = indexes.map(i => chains[i]).sort((a, b) => a.fromKm - b.fromKm);
    const chainIndexes = indexes.map(i => chainReports[i]);
    const reasons = [...new Set(chainIndexes.flatMap(r => r.flags))];
    const joinable = parts.length === 1;
    for (let k = 1; k < parts.length; k++) {
      const lower = [...parts[k - 1].posts].sort((a, b) => a.km - b.km);
      const upper = [...parts[k].posts].sort((a, b) => a.km - b.km);
      const bridge = checkBridge({ posts: lower }, { posts: upper });
      bridges.push({ corridor: JSON.parse(key), ...bridge });
    }
    corridors.push({
      code: JSON.parse(key)[0],
      name: JSON.parse(key)[1],
      fragments: parts.length,
      posts: parts.reduce((s, p) => s + p.posts.length, 0),
      kmRange: [parts[0].fromKm, parts[parts.length - 1].toKm],
      reasons,
      joinable: joinable,
    });
  }

  return { chainReports, corridors, bridges };
}

function summarize(result) {
  const chainVerdicts = {};
  for (const r of result.chainReports) {
    const v = r.flags.length ? r.flags.join('+') : VERDICTS.ok;
    chainVerdicts[v] = (chainVerdicts[v] || 0) + 1;
  }
  const corridorVerdicts = {};
  for (const c of result.corridors) {
    const v = c.reasons.length ? c.reasons.join('+') : VERDICTS.ok;
    corridorVerdicts[v] = (corridorVerdicts[v] || 0) + 1;
  }
  const bridgeVerdicts = {};
  for (const b of result.bridges) bridgeVerdicts[b.verdict] = (bridgeVerdicts[b.verdict] || 0) + 1;
  return { chains: result.chainReports.length, corridors: result.corridors.length, bridges: result.bridges.length, chainVerdicts, corridorVerdicts, bridgeVerdicts };
}

module.exports = { separationM, normalize, checkChain, checkBridge, bridgeHasPostsOnBothSides, evaluate, summarize, VERDICTS, JOIN_RATIO_MIN, JOIN_RATIO_MAX, M_PER_DEG };