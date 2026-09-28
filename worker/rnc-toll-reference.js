'use strict';

const plazas = require('./rnc-toll-plazas.json');
const { roadMatches, roadTokens, extractRouteCodes } = require('../lib/road-match');

function key(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/\b(?:caseta|plaza|cobro|peaje|de|del|la|el|no|nro|numero)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}

function roadSectionMatches(road, section) {
  if (!roadMatches(road,section)) return false;
  const expected=roadTokens(road), resolved=roadTokens(section);
  const common=[...expected].filter(token=>resolved.has(token)).length;
  const codeMatch=extractRouteCodes(road).some(code=>extractRouteCodes(section).includes(code));
  return common>=2 || (codeMatch && common>=1);
}

function officialNameExists(reference, catalog=plazas) {
  const name=key(reference);
  return !!name && catalog.some(p=>key(p.name)===name);
}

function resolveOfficialTollReference(reference, road='', catalog=plazas) {
  if (!/(?:caseta|plaza\s+de\s+cobro|peaje)/i.test(reference || '')) return null;
  const name=key(reference);
  if (!name) return null;
  const matching=catalog.filter(p=>key(p.name)===name && (!road || roadSectionMatches(road,p.section)));
  if (matching.length!==1) return null;
  const p=matching[0];
  return { latitude:p.lat, longitude:p.lon,
    label:`Plaza de Cobro ${p.name} · ${p.section} (referencia aproximada)`,
    confidence:.90, status:'approximate', precision:'toll_reference',
    provider:'rnc_2025_plaza_cobro', matched_reference:p.name,
    source_plaza_ids:p.sourceIds, uncertainty_m:500 };
}

module.exports={ resolveOfficialTollReference, officialNameExists, roadSectionMatches };
