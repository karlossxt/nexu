'use strict';
// Validación cruzada: punto del loader RNC vs corredor curado de RED_VIAL
// (ground truth verificado a mano con marcadores oficiales).
//   node tools/rnc-redvial-validate.js
const path = require('node:path');
const RED_VIAL = require(path.join(__dirname, '..', 'worker', 'red-vial'));
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));
const { extractRouteCodes, geoDistanceKm } = require(path.join(__dirname, '..', 'lib', 'road-match'));

// Réplica de pointAtRoadKilometer (worker/index.js): km lineal sobre geometría.
function curatedPoint(corridor, kilometer) {
  const start = Number(corridor.kmStart), end = Number(corridor.kmEnd);
  const pts = corridor.pts || [];
  if (!Number.isFinite(kilometer) || end <= start || pts.length < 2) return null;
  if (kilometer < start || kilometer > end) return null;
  const segments = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = geoDistanceKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    segments.push(len);
    total += len;
  }
  if (!(total > 0)) return null;
  const target = ((kilometer - start) / (end - start)) * total;
  let walked = 0;
  for (let i = 0; i < segments.length; i++) {
    const next = walked + segments[i];
    if (target <= next || i === segments.length - 1) {
      const ratio = segments[i] > 0 ? Math.max(0, Math.min(1, (target - walked) / segments[i])) : 0;
      return { latitude: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * ratio,
               longitude: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * ratio };
    }
    walked += segments[i];
  }
  return null;
}

const buckets = { '<1': 0, '1-3': 0, '3-10': 0, '>10': 0, sin: 0 };
const rows = [];

for (const corridor of RED_VIAL) {
  const start = Number(corridor.kmStart), end = Number(corridor.kmEnd);
  if (!(end > start)) continue;
  // también probamos con el alias numérico si existe (ej. "57d")
  const numericAlias = (corridor.aliases || []).find(a => extractRouteCodes(a).length);
  const n = 7;
  let worst = 0, sum = 0, count = 0, misses = 0;
  for (let i = 1; i < n; i++) {
    const km = Math.round(start + ((end - start) * i) / n);
    const expected = curatedPoint(corridor, km);
    if (!expected) continue;
    let hit = rnc.resolveNetworkKilometer(corridor.name, km);
    let via = corridor.name;
    if (!hit && numericAlias) {
      hit = rnc.resolveNetworkKilometer(numericAlias, km);
      via = numericAlias;
    }
    if (!hit) {
      // intento con el alias numérico primero también cuando el nombre no resuelve
      misses++;
      buckets.sin++;
      continue;
    }
    const d = geoDistanceKm(expected.latitude, expected.longitude, hit.latitude, hit.longitude);
    count++;
    sum += d;
    if (d > worst) worst = d;
    if (d < 1) buckets['<1']++;
    else if (d < 3) buckets['1-3']++;
    else if (d < 10) buckets['3-10']++;
    else buckets['>10']++;
    void via;
  }
  rows.push({ badge: corridor.badge, name: corridor.name, km: `${start}-${end}`,
    resolved: count, misses, mean: count ? +(sum / count).toFixed(2) : null, worst: +worst.toFixed(2) });
}

rows.sort((a, b) => (b.worst || 0) - (a.worst || 0));
console.log('corredor                  km        resueltos  falla  media_km  peor_km');
for (const r of rows) {
  console.log(
    `${r.badge.padEnd(20)} ${String(r.km).padEnd(10)} ${String(r.resolved).padStart(4)}/6      ` +
    `${String(r.misses).padStart(4)}  ${String(r.mean ?? '-').padStart(7)}  ${String(r.worst).padStart(7)}`);
}
const totalResolved = rows.reduce((n, r) => n + r.resolved, 0);
const totalMiss = rows.reduce((n, r) => n + r.misses, 0);
console.log(`\nbuckets distancias: ${JSON.stringify(buckets)}`);
console.log(`resueltos: ${totalResolved}/${totalResolved + totalMiss} ` +
  `(${((totalResolved / Math.max(1, totalResolved + totalMiss)) * 100).toFixed(1)}%)`);
