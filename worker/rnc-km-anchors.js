'use strict';
const { stateMatches } = require('../lib/state-match');
const posts = require('./rnc-150d-reviewed.json');
const reviewedToday = require('./rnc-20260928-reviewed.json');
const reviewedSeptember30 = require('./rnc-20260930-reviewed.json');
const promotedPosts = require('./rnc-promoted.json');
const promotedCorridors = require('./rnc-promoted-corridors.json');

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

// RNC 2025: postes promovidos en bloque por tools/rnc-promoted-anchors-run.js.
//
// Son postes reales del RNC, no estimaciones: el generador solo acepta cadenas que
// el invariante de cadena dejo SIN marcas, descarta las que colisionan con un ancla
// revisada a mano y exige estado via localidad.CVEGEO. Aun asi reciben la misma
// confianza (.78) y la misma incertidumbre (1500 m) que las anclas revisadas: el
// bloque no los hace mas fiables, solo mas numerosos.
//
// El alias vive en el archivo de corredores, una vez por corredor, y no en cada
// ancla. Se materializa aqui como RegExp para que ANCHORS tenga una sola forma y
// resolveRncPost no necesite saber de donde salio cada entrada.
//
// PROMOTED es una lista aparte y no un .push sobre ANCHORS: ANCHORS[0] se consulta
// por indice mas abajo (GUADALAJARA_COLIMA) y esas 38 entradas se revisaron una a
// una. Las concatenadas van despues, asi que una ancla promovida nunca desplaza a
// una revisada.
const PROMOTED = promotedPosts.map(p=>({
  road: promotedCorridors[p.corridor].road,
  state: p.state,
  km: p.km,
  lat: p.lat,
  lon: p.lon,
  aliases: promotedCorridors[p.corridor].aliases.map(src=>new RegExp(src,'i')),
  sourcePostId: p.sourcePostId,
  // Marca de procedencia: la auditoria de promocion necesita separar el indice que
  // YA existe del que esta por escribir, porque el archivo que genera todavia no
  // esta en disco cuando corre.
  promoted: true
}));

// km 104/105 lie between RNC posts 103 (ID 40864) and 106 (ID 40865).
// The reviewed points are projected onto the corresponding toll-road geometry;
// each successive point is ~1 km apart. They are estimates, not official posts.
const ESTIMATES_54D = [
  { km:104, lat:19.559756961439334, lon:-103.44035251441161, sourceRoadId:2746298 },
  { km:105, lat:19.551591567696082, lon:-103.43525405303387, sourceRoadId:2746299 }
];
const GUADALAJARA_COLIMA = ANCHORS[0].aliases;

// El indice que resuelve de verdad. Se separa de ANCHORS para que las 38 anclas
// revisadas a mano sigan siendo direccionables por indice (GUADALAJARA_COLIMA usa
// ANCHORS[0]) mientras el filtro de resolucion mira las dos listas.
const ALL_ANCHORS = [...ANCHORS, ...PROMOTED];

function resolveRncPost(road, kilometer, state='') {
  const value=String(road||'').trim();
  const km=Number(kilometer);
  if(!value || !Number.isInteger(km)) return null;
  if(/\blibre\b/i.test(value)) return null;
  if(/\b(?:54|150)\b/i.test(value) && !/\b(?:54D|150D)\b/i.test(value) && !/autopista/i.test(value)) return null;
  const matches=ALL_ANCHORS.filter(a=>a.km===km && a.aliases.some(alias=>alias.test(value)));
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
// anchorIndex se exporta para la auditoria de promocion: el generador necesita
// auditar su salida contra el indice COMPLETO (anclas manuales incluidas), con los
// mismos objetos RegExp que el worker usa, no contra una copia de ellos. Exportar el
// array en vez de los datos evita que esa copia se desincronice en silencio.
module.exports={ resolveRncPost, resolveRncEstimatedKm, anchorIndex: ALL_ANCHORS };
