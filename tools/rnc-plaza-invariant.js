'use strict';

// Invariante de corroboración por plaza de cobro, para la revisión nacional.
// Un poste de una cadena candidata ya tiene identidad de carretera (codigo +
// nombre de tramo) y geometria. Este index anade una tercera fuente
// independiente: la declaracion oficial de la plaza de cobro mas cercana.
//
// Regla deliberadamente debil: la plaza NUNCAAprueba ni corrige una cadena. Solo
// separa "la plaza declarada coincide con el tramo" de "la plaza declarada nombra
// otro tramo" y "no hay plaza aplicable". El segundo caso es el que vale: son
// candidatos a alias de corredor y hay que revisarlos a mano.

const { closestOnLine, geometry, EARTH_M_PER_DEG } = require('./rnc-national-review');

const PLACEHOLDER = /^N\/?[DA]$/i;
const STOP = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'ent', 'entre', 'autonoma', 'autonomo',
  'federal', 'carretera', 'cuota', 'autopista', 'km', 'n', 'd'
]);

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Toponimos con significado: descarta conectores y palabras de una letra, pero
// conserva los digitos, que en un nombre de tramo suelen ser parte del
// toponimo ("16 de Septiembre", "7 de Julio") y no una medida de ruta.
function toponyms(value) {
  return new Set(normalize(value).split(' ')
    .filter(t => t && !STOP.has(t) && (t.length > 2 || (/^\d{2,}$/.test(t)))));
}

// Un nombre de plaza es un subsegmento del corredor, no el corredor completo:
// "Cuitlahuac - La Tinaja" y "Paso del Toro - Veracruz" son dos tramos de
// "Cordoba - Veracruz". La coincidencia exacta no puede exigirse.
function nameAgreement(chainName, sections) {
  const target = normalize(chainName);
  for (const section of sections) {
    if (normalize(section) === target) return 'exact';
  }
  // Comparten al menos un topónimo: mismo corredor, segmentación distinta.
  const chainToks = toponyms(chainName);
  for (const section of sections) {
    for (const t of toponyms(section)) if (chainToks.has(t)) return 'shares_toponym';
  }
  return 'different';
}

// Agrupa las entradas del indice por codigo de ruta, que es como las consulta
// la revision nacional.
function indexByCode(entries) {
  const byCode = new Map();
  for (const entry of entries) {
    if (!byCode.has(entry.code)) byCode.set(entry.code, []);
    byCode.get(entry.code).push(entry);
  }
  return byCode;
}

// Aplica el invariante a una cadena candidata. Devuelve siempre un veredicto;
// nunca modifica la cadena ni sus coordenadas.
function checkChain(chain, entriesByCode) {
  const entries = (entriesByCode.get(String(chain.code)) || [])
    .filter(e => e.idRed && chain.posts.some(p => p.roadId === e.idRed));
  if (!entries.length) {
    return { code: chain.code, name: chain.name, posts: chain.posts.length, verdict: 'no_plaza_on_road_ids' };
  }
  const sections = [...new Set(entries.flatMap(e => e.sections))].filter(Boolean).sort();
  const agreement = sections.length ? nameAgreement(chain.name, sections) : 'no_section_declared';
  const plazas = [...new Set(entries.flatMap(e => e.plazaIds))].sort((a, b) => a - b);
  return {
    code: chain.code,
    name: chain.name,
    posts: chain.posts.length,
    roadIds: entries.length,
    verdict: agreement,
    sections,
    plazaIds: plazas
  };
}

const VERDICTS = {
  no_plaza_on_road_ids: 'ninguna plaza declarada toca los ID_RED de esta cadena: invariante mudo',
  no_section_declared: 'hay plaza cercana pero su SECCION es N/D: no se puede comparar',
  different: 'la plaza declara otro tramo: revisar alias de corredor',
  shares_toponym: 'mismo corredor con segmentación distinta de plaza',
  exact: 'la plaza declara exactamente este tramo'
};

function summarize(results) {
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  return {
    chains: results.length,
    posts: results.reduce((s, r) => s + r.posts, 0),
    verdicts: counts,
    // Un invariante nuncaAprueba. Este conteo es solo de ayuda al revisor.
    coveredByPlaza: results.filter(r => r.verdict !== 'no_plaza_on_road_ids').length
  };
}

module.exports = { normalize, toponyms, nameAgreement, indexByCode, checkChain, summarize, VERDICTS, PLACEHOLDER, closestOnLine, geometry, EARTH_M_PER_DEG };
