'use strict';
const { stateMatches } = require('../lib/state-match');

// RNC 2025: Poste de referencia, approximate position (not an incident GPS fix).
// Reviewed against adjacent kilometre posts and the tolled road geometry.
// Keep this pilot limited to exact kilometre/road pairs; do not interpolate or
// treat a route number alone as identifying a particular corridor.
const ANCHORS = [
  { road:'Guadalajara–Colima 54D', state:'Jalisco', km:117, lat:19.46473314598444, lon:-103.46481122763824,
    aliases:[/guadalajara\s*[-–—]?\s*colima/i, /colima\s*[-–—]?\s*guadalajara/i], sourcePostId:40870 },
  { road:'Acatzingo–Ciudad Mendoza 150D', state:'Veracruz', km:229, lat:18.849633359617624, lon:-97.29896331195432,
    aliases:[/acatzingo\s*[-–—]?\s*(?:cd\.?|ciudad)\s*mendoza/i, /(?:cd\.?|ciudad)\s*mendoza\s*[-–—]?\s*acatzingo/i], sourcePostId:5725 }
];

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
module.exports={ resolveRncPost };
