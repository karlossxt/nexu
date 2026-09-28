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

function reviewedCorridorMatch(name, road, section) {
  // RNC names these adjacent sections by their junctions; the public alert
  // calls the same corridor Cárdenas–Coatzacoalcos.
  return key(name)==='sanchez magallanes' &&
    /^cardenas coatzacoalcos$/.test(key(road).replace(/^autopista /,'')) &&
    ['agua dulce cardenas','agua dulce ent magallanes','ent magallanes cardenas'].includes(key(section));
}

function distanceM(a,b) {
  const lat=(a.lat+b.lat)/2*Math.PI/180;
  return Math.hypot((a.lat-b.lat)*111195,(a.lon-b.lon)*111195*Math.cos(lat));
}

function officialNameExists(reference, catalog=plazas) {
  const name=key(reference);
  return !!name && catalog.some(p=>key(p.name)===name);
}

function resolveOfficialTollReference(reference, road='', catalog=plazas) {
  if (!/(?:caseta|plaza\s+de\s+cobro|peaje)/i.test(reference || '')) return null;
  const name=key(reference);
  if (!name) return null;
  const matching=catalog.filter(p=>key(p.name)===name && (!road || roadSectionMatches(road,p.section) || reviewedCorridorMatch(p.name,road,p.section)));
  if (!matching.length || matching.some(p=>matching.some(q=>distanceM(p,q)>250))) return null;
  // Multiple entries may describe nearby ramps of one plaza. Use their
  // centroid only when every matching record belongs to a compact cluster.
  const lat=matching.reduce((s,p)=>s+p.lat,0)/matching.length;
  const lon=matching.reduce((s,p)=>s+p.lon,0)/matching.length;
  const spread=Math.max(...matching.map(p=>distanceM(p,{lat,lon})));
  const p=matching[0];
  return { latitude:+lat.toFixed(8), longitude:+lon.toFixed(8),
    label:`Plaza de Cobro ${p.name} · ${matching.length===1?p.section:road} (referencia aproximada)`,
    confidence:.90, status:'approximate', precision:'toll_reference',
    provider:'rnc_2025_plaza_cobro', matched_reference:p.name,
    source_plaza_ids:matching.flatMap(x=>x.sourceIds), uncertainty_m:Math.max(500,Math.ceil(spread+500)) };
}

module.exports={ resolveOfficialTollReference, officialNameExists, roadSectionMatches };
