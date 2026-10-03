'use strict';
const { stateMatches } = require('../lib/state-match');
const posts = require('./rnc-150d-reviewed.json');
const reviewedToday = require('./rnc-20260928-reviewed.json');
const reviewedSeptember30 = require('./rnc-20260930-reviewed.json');

// RNC 2025: Poste de referencia, approximate position (not an incident GPS fix).
// Reviewed against adjacent kilometre posts and the tolled road geometry.
// Exact posts only; separately reviewed short-gap estimates appear below.
const ANCHORS = [
  { road:'Guadalajara–Colima 54D', state:'Jalisco', km:117, lat:19.46473314598444, lon:-103.46481122763824,
    aliases:[/guadalajara\s*[-–—]?\s*colima/i, /colima\s*[-–—]?\s*guadalajara/i], sourcePostId:40870 },
  ...posts.map(p=>({ ...p, road:'Acatzingo–Ciudad Mendoza 150D',
    aliases:[/acatzingo\s*[-–—]?\s*(?:cd\.?|ciudad)\s*mendoza/i, /(?:cd\.?|ciudad)\s*mendoza\s*[-–—]?\s*acatzingo/i] })),
  ...reviewedToday.map(p=>({ ...p, aliases:[new RegExp(p.alias,'i')] })),
  ...reviewedSeptember30.map(p=>({ ...p, aliases:[new RegExp(p.alias,'i')] }))
];

// km 104/105 lie between RNC posts 103 (ID 40864) and 106 (ID 40865).
// The reviewed points are projected onto the corresponding toll-road geometry;
// each successive point is ~1 km apart. They are estimates, not official posts.
const ESTIMATES_54D = [
  { km:104, lat:19.559756961439334, lon:-103.44035251441161, sourceRoadId:2746298 },
  { km:105, lat:19.551591567696082, lon:-103.43525405303387, sourceRoadId:2746299 }
];
const GUADALAJARA_COLIMA = ANCHORS[0].aliases;

function resolveRncPost(road, kilometer, state='') {
  const value=String(road||'').trim();
  const km=Number(kilometer);
  if(!value || !Number.isInteger(km)) return null;
  if(/\blibre\b/i.test(value)) return null;
  if(/\b(?:54|150)\b/i.test(value) && !/\b(?:54D|150D)\b/i.test(value) && !/autopista/i.test(value)) return null;
  const matches=ANCHORS.filter(a=>a.km===km && a.aliases.some(alias=>alias.test(value)));
  if(matches.length!==1) return null;
  const a=matches[0];
  if(state && !stateMatches(state,a.state)) return null;
  return { latitude:a.lat, longitude:a.lon, label:`${a.road} · km ${km} (referencia aproximada)`,
    confidence:.78, status:'approximate', precision:'kilometer_rnc', provider:'rnc_2025',
    source_post_id:a.sourcePostId, uncertainty_m:1500 };
}
function resolveRncEstimatedKm(road, kilometer, state='') {
  const value=String(road||'').trim(), km=Number(kilometer);
  if(!value || !Number.isInteger(km) || /\blibre\b/i.test(value)) return null;
  if(/\b54\b/i.test(value) && !/\b54D\b/i.test(value) && !/autopista/i.test(value)) return null;
  if(!GUADALAJARA_COLIMA.some(alias=>alias.test(value))) return null;
  if(state && !stateMatches(state,'Jalisco')) return null;
  const point=ESTIMATES_54D.find(p=>p.km===km);
  if(!point) return null;
  return { latitude:point.lat, longitude:point.lon,
    label:`Autopista Guadalajara–Colima · km ${km} estimado entre postes`,
    confidence:.70, status:'approximate', precision:'kilometer_rnc_estimated', provider:'rnc_2025',
    source_post_ids:[40864,40865], source_road_id:point.sourceRoadId, uncertainty_m:2000 };
}
module.exports={ resolveRncPost, resolveRncEstimatedKm };
