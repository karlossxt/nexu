'use strict';

// Acceso perezoso a los datasets RNC 2025 construidos por tools/build-rnc.js:
//   data/red-vial-index.json.gz  metadatos de cadenas (se carga al primer uso)
//   data/km/<código>.json.gz     geometría + postes por código (caché acotada)
// El worker solo mantiene el índice en RAM; los km se leen bajo demanda para
// respetar el presupuesto de memoria del plan RNC.
//
// Qué aporta en la cascada de resolveRoadLocation:
//   carretera + km → poste oficial exacto (±0.5 km) o interpolación sobre una
//   cadena CALIBRADA dentro de su ventana certificada (validFrom..validTo).
//   carretera sin km → punto intermedio del corredor como último recurso,
//   solo cuando el geocodificador externo no devolvió candidatos.
// Lo que no certifica, devuelve null: el worker cae al geocodificador.
// Las casetas siguen resolviéndose con resolveTollReference (catálogo revisado);
// data/casetas.json.gz existe como catálogo completo para auditoría y futuro uso.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  normalizeRoad,
  extractRouteCodes,
  routeFamily
} = require('../lib/road-match');

const DATA_DIR = path.join(__dirname, 'data');
const KM_CACHE_MAX = 40;      // códigos en RAM; cada archivo pesa < 300 KB
const MIN_MATCH_SCORE = 82;   // mismo umbral que findRoadCorridor del worker
const MAX_KM_TRIES = 8;       // cadenas candidatas a intentar antes de rendirse

let indexCache = null;
let sectionsCache = null;
const kmCache = new Map();

function readGzJson(file) {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  } catch {
    return null; // dataset aún no construido: la cascada sigue intacta
  }
}

function loadIndex() {
  if (indexCache) return indexCache;
  indexCache = readGzJson(path.join(DATA_DIR, 'red-vial-index.json.gz'));
  return indexCache || null;
}

function loadKm(code) {
  if (kmCache.has(code)) return kmCache.get(code);
  const data = readGzJson(path.join(DATA_DIR, 'km', `${code}.json.gz`));
  if (!data) return null;
  if (kmCache.size >= KM_CACHE_MAX) kmCache.delete(kmCache.keys().next().value);
  kmCache.set(code, data);
  return data;
}

function reset() {
  indexCache = null;
  sectionsCache = null;
  kmCache.clear();
}

// Normalización "cruda" equivalente a norm() del worker (acento y caja).
function normText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function inMexico(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= 14 && latitude <= 33 && longitude >= -119 && longitude <= -86;
}

// Índice aplanado de secciones: nombre oficial de tramo → cadena que lo lleva.
function sectionsIndex() {
  if (sectionsCache) return sectionsCache;
  const list = [];
  const index = loadIndex();
  if (index) {
    for (const [code, metas] of Object.entries(index.codes || {})) {
      for (const meta of metas) {
        for (const section of meta.sections || []) {
          const name = String(section.name || '').trim();
          if (!name) continue;
          list.push({ code, meta, name, raw: normText(name), key: normalizeRoad(name) });
        }
      }
    }
  }
  sectionsCache = list;
  return list;
}

// Misma escala de puntaje que findRoadCorridor (100 exacto / 95 clave / 88-82 includes).
function nameScore(queryRaw, queryKey, entry) {
  if (!queryRaw || !entry.raw) return 0;
  if (queryRaw === entry.raw) return 100;
  if (queryKey && entry.key && queryKey === entry.key) return 95;
  if (queryRaw.length >= 4 && (queryRaw.includes(entry.raw) || entry.raw.includes(queryRaw))) return 88;
  if (queryKey && entry.key && queryKey.length >= 4 &&
      (queryKey.includes(entry.key) || entry.key.includes(queryKey))) return 82;
  return 0;
}

// Los códigos extraídos del texto pueden arrastrar el propio kilometraje
// ("carretera 57 km 45" extraería el 45): se retira solo "km 45"; retirar
// también "57 km" se comía el código de la ruta en "carretera 150 km 215".
function routeCodesOf(road) {
  const cleaned = String(road || '')
    .replace(/\bkm\s*\d+(?:[.,]\d+)?\b/ig, ' ');
  return extractRouteCodes(cleaned);
}

// Pista de lado de marcha: D/autopista/cuota → pista de caseta (Si), libre → No.
function peajeHint(road, codes) {
  const text = normText(road);
  if (/\b(autopista|cuota|peaje)\b/.test(text)) return 'Si';
  if (/\blibre\b/.test(text)) return 'No';
  if (codes.some(code => /^\d{1,3}[A-Z]$/.test(code))) return 'Si';
  return '';
}

// Coherencia de nombre: solo importan los identificadores geográficos
// ("Querétaro - Irapuato"). Las secciones que repiten la designación de la vía
// ("Federal 57") no distinguen ningún corredor y no deben bloquear la
// resolución por anclas de una consulta genérica como "carretera 57 km 58".
const GENERIC_SECTION_WORDS = new Set([
  'federal', 'nacional', 'autopista', 'carretera', 'libre', 'cuota',
  'libramiento', 'tramo', 'kilometro', 'primitivo', 'urbana', 'rural'
]);
function hasGeographicToken(raw) {
  return String(raw || '')
    .split(/[^a-z0-9]+/)
    .some(t => t.length >= 4 && !GENERIC_SECTION_WORDS.has(t));
}

// Candidatas ordenadas: con código en el texto solo ese código decide (la
// sección solo desempata dentro de él); sin código, el nombre de sección selecciona.
// Devuelve además nameHits: nº de secciones geográficas de la red cuyo nombre
// coincide con la consulta (≥82), pista para detectar conflicto de identidad.
function candidateMetas(road) {
  const index = loadIndex();
  if (!index) return { candidates: [], nameHits: 0 };
  const codes = routeCodesOf(road);
  const queryRaw = normText(road);
  const queryKey = normalizeRoad(road);

  const nameMatches = [];
  for (const entry of sectionsIndex()) {
    const score = nameScore(queryRaw, queryKey, entry);
    if (score >= MIN_MATCH_SCORE) nameMatches.push({ entry, score });
  }

  const candidates = [];
  const seen = new Set();
  const push = (code, meta, score) => {
    if (seen.has(meta.id)) return;
    seen.add(meta.id);
    candidates.push({ code, meta, nameScore: score });
  };

  if (codes.length) {
    for (const code of codes) {
      const metas = index.codes[code];
      if (metas) {
        for (const meta of metas) {
          const match = nameMatches.find(m => m.entry.meta === meta);
          push(code, meta, match ? match.score : 0);
        }
        continue;
      }
      // "57D" no existe en RNC (la distinción libre/cuota no está en CODIGO):
      // se cae a la familia 57 manteniendo la pista de cuota por el sufijo D.
      const family = routeFamily(code);
      if (family && family !== code && /^\d{1,3}[A-Z]$/.test(code)) {
        for (const meta of index.codes[family] || []) {
          const match = nameMatches.find(m => m.entry.meta === meta);
          push(family, meta, match ? match.score : 0);
        }
      }
    }
  } else {
    for (const match of nameMatches) push(match.entry.code, match.entry.meta, match.score);
  }

  const hint = peajeHint(road, codes);
  if (hint) {
    const hinted = candidates.filter(c => c.meta.peaje === hint || c.meta.peaje === 'Mixto');
    if (hinted.length) candidates.splice(0, candidates.length, ...hinted);
  }

  // Con pista de cuota/libre, la cadena exacta (Si→Si, No→No) va antes que Mixto.
  const hintRank = c => (!hint || c.meta.peaje === hint) ? 0 : 1;
  candidates.sort((a, b) =>
    (b.nameScore - a.nameScore) ||
    (hintRank(a) - hintRank(b)) ||
    ((b.meta.anchorPosts || 0) - (a.meta.anchorPosts || 0)) ||
    (b.meta.total - a.meta.total));
  const nameHits = nameMatches.filter(m => hasGeographicToken(m.entry.raw)).length;
  return { candidates, nameHits };
}

// Cal (numeración) certificada que contiene el km consultado. Las cadenas con
// reinicios por sección publican varias calibraciones (p.ej. la ruta 150
// certifica Puebla–Córdoba con numeración de origen en la Ciudad de México y
// Córdoba–Veracruz con reinicio en 1); la primaria (más anclas) va primero.
function calFor(meta, kilometer) {
  const cals = (meta.cals && meta.cals.length) ? meta.cals
    : (meta.calibrated && Number.isFinite(meta.validFrom)
      ? [{ kmStart: meta.kmStart, validFrom: meta.validFrom, validTo: meta.validTo }]
      : null);
  if (!cals) return null;
  for (const cal of cals) {
    if (kilometer >= cal.validFrom && kilometer <= cal.validTo) return cal;
  }
  return null;
}

function sectionAt(meta, accumKm) {
  for (const section of meta.sections || []) {
    if (accumKm >= section.from && accumKm <= section.to) return section;
  }
  return null;
}

function buildResult(candidate, section, latitude, longitude, road, kilometer, viaPost) {
  if (!inMexico(latitude, longitude)) return null;
  const name = section ? section.name : '';
  return {
    latitude,
    longitude,
    label: `${name || road} · km ${kilometer}`,
    // El poste oficial es un punto físico; la interpolación sobre geometría
    // certificada es un punto sobre la vía.
    confidence: viaPost ? 0.93 : 0.9,
    status: 'automatic',
    precision: viaPost ? 'rnc_poste' : 'kilometer_rnc_network',
    corridor: candidate.code,
    // Cadena exacta que resolvió: permite a la cascada descartarla y reintentar
    // con la siguiente candidata si el estado reportado no coincide.
    rnc_chain: candidate.meta.id,
    matched_alias: name || candidate.code,
    provider: 'rnc_2025'
  };
}

function pointAtChain(candidate, kilometer, road = '') {
  const meta = candidate.meta;
  const cal = calFor(meta, kilometer);
  if (!cal) return null; // el km no lo certifica ninguna numerción de la cadena
  const data = loadKm(candidate.code);
  if (!data) return null;
  const chain = (data.chains || []).find(c => c.id === meta.id);
  if (!chain) return null;

  // Poste oficial a ≤0.5 km: el km coincide con un punto físico publicado.
  let bestPost = null;
  for (const post of chain.posts || []) {
    const diff = Math.abs(post.km - kilometer);
    if (diff <= 0.5 && (!bestPost || diff < Math.abs(bestPost.km - kilometer))) bestPost = post;
  }
  const accum = kilometer - cal.kmStart;
  const section = sectionAt(meta, accum);
  if (bestPost) {
    return buildResult(candidate, section, bestPost.lat, bestPost.lon, road, kilometer, true);
  }
  if (!chain.pts || chain.pts.length < 2) return null;

  const target = Math.min(Math.max(accum, 0), meta.total);
  let lo = 0;
  let hi = chain.pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (chain.pts[mid][0] <= target) lo = mid;
    else hi = mid;
  }
  const a = chain.pts[lo];
  const b = chain.pts[hi];
  const span = b[0] - a[0];
  const t = span > 0 ? (target - a[0]) / span : 0;
  return buildResult(candidate, section,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    road, kilometer, false);
}

// carretera + km sobre cadenas calibradas; null si nada certifica el punto.
// `rejected` (ids de cadena) permite a la cascada descartar cadenas cuyo punto
// no pasó la verificación de estado y volver a preguntar por la siguiente.
function resolveNetworkKilometer(road, kilometer, rejected) {
  const km = Number(kilometer);
  if (!road || !Number.isFinite(km)) return null;
  const { candidates: all, nameHits } = candidateMetas(road);
  const windowed = all.filter(c => c.meta.calibrated && calFor(c.meta, km) &&
    !(rejected && rejected.has(c.meta.id)));
  // Coherencia de nombre: si el nombre de la alerta existe en la red pero
  // ninguna cadena dentro de la ventana lo respeta, ese km no pertenece a esa
  // vía (p.ej. "Querétaro–Irapuato 45D km 15": en el km 15 el 45 es otra
  // ruta). Sin nombre propio ("carretera 45 km 15") se decide por anclas + estado.
  if (nameHits > 0 && windowed.length &&
      !windowed.some(c => c.nameScore >= MIN_MATCH_SCORE)) {
    return null;
  }
  for (const candidate of windowed.slice(0, MAX_KM_TRIES)) {
    const hit = pointAtChain(candidate, km, road);
    if (hit) return hit;
  }
  return null;
}

// Último recurso sin kilometraje: vértice medio del mejor corredor por nombre.
function corridorMidpoint(road) {
  if (!road) return null;
  const { candidates, nameHits } = candidateMetas(road);
  // Misma coherencia de nombre que en la resolución por km (sin ventana aquí).
  if (nameHits > 0 && candidates.length &&
      !candidates.some(c => c.nameScore >= MIN_MATCH_SCORE)) {
    return null;
  }
  for (const candidate of candidates.slice(0, MAX_KM_TRIES)) {
    const data = loadKm(candidate.code);
    if (!data) continue;
    const chain = (data.chains || []).find(c => c.id === candidate.meta.id);
    if (!chain || !chain.pts || !chain.pts.length) continue;
    const mid = chain.pts[Math.floor(chain.pts.length / 2)];
    if (!inMexico(mid[1], mid[2])) continue;
    const section = sectionAt(candidate.meta, mid[0]);
    return {
      latitude: mid[1],
      longitude: mid[2],
      label: `${section ? section.name : road} · punto intermedio del corredor`,
      confidence: 0.55,
      status: 'approximate',
      precision: 'corridor_midpoint',
      corridor: candidate.code,
      matched_alias: section ? section.name : candidate.code,
      provider: 'rnc_2025'
    };
  }
  return null;
}

// Superficie de prueba: resuelve sobre una cadena por su id, sin pasar por el
// ranking de carreteras (útil para verificar la interpolación punto a punto).
function pointAtChainById(code, chainId, kilometer) {
  const km = Number(kilometer);
  if (!Number.isFinite(km)) return null;
  const index = loadIndex();
  if (!index) return null;
  const meta = (index.codes[code] || []).find(m => m.id === chainId);
  if (!meta) return null;
  return pointAtChain({ code, meta, nameScore: 0 }, km);
}

module.exports = {
  resolveNetworkKilometer,
  corridorMidpoint,
  pointAtChainById,
  reset,
  // interno, para pruebas y auditorías:
  _loadIndex: loadIndex,
  _loadKm: loadKm,
  _candidateMetas: candidateMetas,
  _calFor: calFor
};
