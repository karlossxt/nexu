'use strict';

function normalizeStateKey(value) {
  const key = String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:estado de|state of)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

  const aliases = {
    cdmx:'cdmx',
    ciudaddemexico:'cdmx',
    distritofederal:'cdmx',

    edomex:'edomex',
    mexico:'edomex',
    estadodemexico:'edomex',

    michoacan:'michoacan',
    michoacandeocampo:'michoacan',

    veracruz:'veracruz',
    veracruzdeignaciodelallave:'veracruz',

    coahuila:'coahuila',
    coahuiladezaragoza:'coahuila'
  };

  return aliases[key] || key;
}

function stateMatches(expected, resolved) {
  if (!expected || !resolved) return true;
  return normalizeStateKey(expected) === normalizeStateKey(resolved);
}

module.exports = { normalizeStateKey, stateMatches };
