'use strict';

// Ninguna carretera federal mexicana pasa de ~400 km, y un poste "km 0" siempre
// es un kilometraje no confirmado: tratarlo como dato real terminaba anclando el
// incidente en el arranque equivocado de la vía.
const KILOMETER_MIN = .1;
const KILOMETER_MAX = 400;

function kilometersConflict(a,b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const first=Number(a), second=Number(b);
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first-second)>1;
}

function inRange(km) {
  return Number.isFinite(km) && km >= KILOMETER_MIN && km <= KILOMETER_MAX;
}

// "66+500" es cadenamiento (miles), "66.5" / "66,5" es decimal.
function addFraction(whole, plus, decimal) {
  if (plus != null) return whole + Number(plus) / 1000;
  if (decimal != null) return whole + Number(`0.${decimal}`);
  return whole;
}

// Acepta 27, '27', '66.5', '66,5' y '66+500'. Rechaza null, '', 0, -5 y 2024.
// No debe lanzar ante ningún valor que devuelva el clasificador.
function parseKilometer(value) {
  if (value == null) return null;
  const source = String(value);
  if (/^[^\d]*-\s*\d/.test(source)) return null;
  const match = source.match(/(\d{1,4})(?:\s*\+\s*(\d{1,3})|[.,](\d{1,3}))?/);
  if (!match) return null;
  const km = addFraction(Number(match[1]), match[2], match[3]);
  return inRange(km) ? Number(km.toFixed(3)) : null;
}

// El clasificador es la fuente de verdad: el cuerpo de la nota nunca debe
// sobrescribir un kilometraje ya extraído. El texto solo rescata cuando la IA no
// devolvió nada, y exige el prefijo "km" para no confundir años, montos o
// precios con postes kilométricos.
function normalizedKilometer(value, text) {
  const fromClassifier = parseKilometer(value);
  if (fromClassifier != null) return fromClassifier;

  const match = String(text || '').match(/\b(?:km|kil[oó]metros?)\.?\s*[:.]?\s*(\d{1,3})(?:\s*\+\s*(\d{1,3})|[.,](\d{1,3}))?/i);
  if (!match) return null;
  const km = addFraction(Number(match[1]), match[2], match[3]);
  return inRange(km) ? Number(km.toFixed(3)) : null;
}

module.exports={ kilometersConflict, normalizedKilometer, parseKilometer };
