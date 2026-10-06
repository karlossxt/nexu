'use strict';

// Validación del loader RNC contra los postes EXACTOS revisados a mano por los
// pilotos previos del repo (worker/rnc-*.reviewed.json): son postes oficiales
// con sourcePostId verificados contra los marcadores vecinos y la geometría de
// la vía. Es la única verdad de campo disponible offline.
//   node tools/rnc-exact-posts-validate.js

const path = require('node:path');
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));
const { geoDistanceKm, extractRouteCodes } = require(path.join(__dirname, '..', 'lib', 'road-match'));

const posts150d = require(path.join(__dirname, '..', 'worker', 'rnc-150d-reviewed.json'))
  .map(p => ({ ...p, road: 'Acatzingo–Ciudad Mendoza 150D' }));
const posts28 = require(path.join(__dirname, '..', 'worker', 'rnc-20260928-reviewed.json'));
const posts30 = require(path.join(__dirname, '..', 'worker', 'rnc-20260930-reviewed.json'));

const sets = [
  { name: 'rnc-150d-reviewed (23 postes km 197–230)', posts: posts150d },
  { name: 'rnc-20260928-reviewed (6 postes)', posts: posts28 },
  { name: 'rnc-20260930-reviewed (8 postes)', posts: posts30 }
];

let total = 0;
let resolved = 0;
const distances = [];

for (const set of sets) {
  console.log(`\n${set.name}`);
  for (const p of set.posts) {
    total++;
    // (a) nombre completo de la carretera como lo redactaría una alerta
    let hit = rnc.resolveNetworkKilometer(p.road, p.km);
    let via = 'nombre';
    // (b) variante genérica solo con código: "carretera 150D km 210"
    if (!hit) {
      const code = extractRouteCodes(p.road)[0];
      if (code) {
        hit = rnc.resolveNetworkKilometer(`carretera ${code} km ${p.km}`, p.km);
        via = 'código';
      }
    }
    if (!hit) {
      console.log(`  km ${String(p.km).padStart(3)} ${String(p.state || '').padEnd(10)} SIN RESOLUCIÓN`);
      continue;
    }
    resolved++;
    const d = geoDistanceKm(p.lat, p.lon, hit.latitude, hit.longitude);
    distances.push(d);
    const flag = d <= 1.5 ? 'ok  ' : d <= 3 ? 'cerca' : 'FAR ';
    console.log(`  km ${String(p.km).padStart(3)} ${String(p.state || '').padEnd(10)} ${flag} d=${d.toFixed(2)} km ` +
      `vía=${via} prec=${hit.precision} (${hit.corridor})`);
  }
}

distances.sort((a, b) => a - b);
const pct = p => distances.length ? distances[Math.min(distances.length - 1, Math.floor(p * distances.length))] : 0;
console.log(`\nresueltos: ${resolved}/${total} (${((resolved / total) * 100).toFixed(1)}%)`);
console.log(`distancias: mediana=${pct(0.5).toFixed(2)} km, p75=${pct(0.75).toFixed(2)} km, ` +
  `p95=${pct(0.95).toFixed(2)} km, máx=${(distances[distances.length - 1] || 0).toFixed(2)} km`);
console.log(`≤1.5 km: ${distances.filter(d => d <= 1.5).length}/${resolved}  ` +
  `≤3 km: ${distances.filter(d => d <= 3).length}/${resolved}`);
