'use strict';
// Política de la compuerta estricta para los puntos que devuelve rnc-loader
// (resolveNetworkKilometer). Antes la compuerta no reconocía estos dos tipos,
// los trataba como "tipo desconocido" y degradaba a `road_approximate` puntos
// exactos del kilómetro (confianza .90–.93).
//
//   · rnc_poste             poste oficial de la RNC               (confianza .93)
//   · kilometer_rnc_network interpolación sobre geometría certificada (.90)

const MIN_CONFIDENCE = { rnc_poste: 0.85, kilometer_rnc_network: 0.80 };
const RNC_NETWORK_PRECISIONS = new Set(Object.keys(MIN_CONFIDENCE));
const STOPWORDS = new Set(['autopista', 'libramiento', 'carretera', 'federal', 'cuota', 'libre', 'de', 'del', 'la', 'las', 'el', 'los', 'y']);
const ABBREVIATIONS = [[/\bcd\.?(?=\s)/gi, 'ciudad'], [/\bcdad\.?(?=\s)/gi, 'ciudad'], [/\bgtz\.?(?=\s)/gi, 'gutierrez'], [/\bsta\.?(?=\s)/gi, 'santa'], [/\bsto\.?(?=\s)/gi, 'santo'], [/\bpto\.?(?=\s)/gi, 'puerto']];

function tokens(text) {
  let value = String(text || '');
  for (const [pattern, full] of ABBREVIATIONS) value = value.replace(pattern, full);
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(t => t && !STOPWORDS.has(t));
}

// ¿El nombre del tramo que resolvió la RNC aparece en el texto de la carretera de la alerta?
// "Autopista 15D" → "Tepic - Mazatlán" NO (se resolvió solo por el número y puede ser otro estado).
// "Autopista Córdoba - Veracruz" → "Córdoba - Veracruz" SÍ.
function sectionNamedInRoad(alias, road) {
  const wanted = tokens(alias);
  if (!wanted.length) return false;
  const present = new Set(tokens(road));
  return wanted.every(t => present.has(t));
}

// Devuelve null si la precisión no es de este módulo; si lo es: { ok, reason }.
function rncNetworkDecision(geo, context = {}) {
  const precision = String(geo && geo.precision || '').toLowerCase();
  if (!RNC_NETWORK_PRECISIONS.has(precision)) return null;
  if (String(geo.provider || '').toLowerCase() !== 'rnc_2025') return { ok: false, reason: 'rnc_network_unknown_provider' };
  if ((Number(geo.confidence) || 0) < MIN_CONFIDENCE[precision]) return { ok: false, reason: 'low_confidence_rnc_network' };
  const state = String(context.state || '').trim();
  if (state) {
    // El worker ya descartó las cadenas cuyo punto cae en otro estado; aquí se exige esa marca.
    return geo.state_verified ? { ok: true, reason: precision === 'rnc_poste' ? 'trusted_rnc_official_post' : 'trusted_rnc_interpolated' }
      : { ok: false, reason: 'rnc_network_state_unverified' };
  }
  // Sin estado no hay verificación geográfica: solo se acepta si el tramo se eligió por su NOMBRE.
  if (!sectionNamedInRoad(geo.matched_alias, context.road)) return { ok: false, reason: 'rnc_network_matched_by_code_only' };
  return { ok: true, reason: 'trusted_rnc_named_section' };
}

module.exports = { rncNetworkDecision, sectionNamedInRoad, RNC_NETWORK_PRECISIONS, MIN_CONFIDENCE };
