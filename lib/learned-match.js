'use strict';
// Coincidencia de «lugares aprendidos» (correcciones aprobadas por operadores) con el texto de una alerta.
// Reglas: tokens completos (km 8 no empata con km 84), mismo estado cuando ambos lo traen,
// kilómetro exacto si el lugar aprendido lo tiene, y alias (la frase original que falló).

function fold(v) { return String(v || '').normalize('NFKC').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function keyOf(v) {
  return fold(v).replace(/\b(plaza|de|cobro|caseta|peaje|km|kilometro)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function stateKey(v) {
  const s = fold(v).replace(/[^a-z]+/g, ' ').trim();
  if (!s) return '';
  if (/\bcdmx\b|distrito federal/.test(s) || (/ciudad/.test(s) && /mexico/.test(s))) return 'cdmx';
  if (/estado de mexico|edomex|edo mex|^mexico$/.test(s)) return 'edomex';
  return s.replace(/\b(estado|de|del|la|el)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function sameState(a, b) {
  const x = stateKey(a), y = stateKey(b);
  return !x || !y || x === y || x.includes(y) || y.includes(x);
}
// ¿El lugar a guardar es lo bastante específico? (km, caseta, cruce…). Una autopista completa no lo es.
const SPECIFIC_RE = /(caseta|plaza de cobro|entronque|cruce|crucero|puente|glorieta|esquina|libramiento|distribuidor|acceso|salida|incorporacion|\d)/;
function isSpecificPlace(label, kilometer) {
  if (kilometer != null && kilometer !== '' && Number.isFinite(Number(kilometer))) return true;
  return SPECIFIC_RE.test(fold(label));
}
function rowKeys(row) {
  const keys = [row.match_key, ...(Array.isArray(row.aliases) ? row.aliases.map(keyOf) : [])];
  return [...new Set(keys.filter(k => k && k.length >= 4))];
}
function matchLearned(rows, text, ctx = {}) {
  const hay = ' ' + keyOf(text) + ' ';
  if (hay.trim() === '') return null;
  let best = null, bestLen = 0;
  for (const row of rows || []) {
    if (!sameState(row.state, ctx.state)) continue;
    if (row.kilometer != null && Number.isFinite(Number(row.kilometer))) {
      const kmTok = ' ' + String(Number(row.kilometer)).replace('.', ' ') + ' ';
      if (!hay.includes(kmTok)) continue;
    }
    for (const key of rowKeys(row)) {
      if (hay.includes(' ' + key + ' ') && key.length > bestLen) { best = row; bestLen = key.length; }
    }
  }
  return best;
}
function selectHints(rows, text, state, max = 10) {
  const words = new Set(keyOf(text).split(' ').filter(w => w.length >= 4));
  const scored = [];
  for (const row of rows || []) {
    if (!row.label || !sameState(row.state, state)) continue;
    const toks = new Set([row.label, ...(Array.isArray(row.aliases) ? row.aliases : [])].flatMap(v => keyOf(v).split(' ')).filter(w => w.length >= 4));
    let score = 0; for (const w of toks) if (words.has(w)) score++;
    if (score > 0) scored.push({ label: row.label, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.map(x => x.label))].slice(0, max);
}
module.exports = { keyOf, stateKey, sameState, isSpecificPlace, matchLearned, selectHints };
