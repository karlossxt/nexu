'use strict';
// Dump de postes ancla de cadenas seleccionadas para ver dónde sienta la
// numeración oficial respecto a los km del corredor curado.
const path = require('node:path');
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));
const RED_VIAL = require(path.join(__dirname, '..', 'worker', 'red-vial'));
const { geoDistanceKm } = require(path.join(__dirname, '..', 'lib', 'road-match'));

const index = rnc._loadIndex();

function curatedPoint(corridor, kilometer) {
  const start = Number(corridor.kmStart), end = Number(corridor.kmEnd);
  const pts = corridor.pts || [];
  if (kilometer < start || kilometer > end) return null;
  const segments = []; let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = geoDistanceKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    segments.push(len); total += len;
  }
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

const qro = RED_VIAL.find(c => c.badge === 'mex-qro');
for (const id of ['57:4', '57:3', '57:7', '57:10', '57:73', '57:74']) {
  const meta = (index.codes['57'] || []).find(m => m.id === id);
  if (!meta) { console.log(`${id}: no existe`); continue; }
  const data = rnc._loadKm('57');
  const chain = data.chains.find(c => c.id === id);
  console.log(`\n${id} kmStart=${meta.kmStart} win=[${meta.validFrom},${meta.validTo}] total=${meta.total} peaje=${meta.peaje} anchors=${meta.anchorPosts}`);
  console.log(`  secs: ${meta.sections.map(s => `${s.name}(${s.from}..${s.to})`).join(' | ')}`);
  const posts = chain.posts || [];
  const step = Math.max(1, Math.floor(posts.length / 6));
  for (let i = 0; i < posts.length; i += step) {
    const p = posts[i];
    // km curado equivalente: busco el km de corrida más cercano a este poste
    let bestKm = null, bestD = Infinity;
    for (let km = qro.kmStart; km <= qro.kmEnd; km += 3) {
      const c = curatedPoint(qro, km);
      const d = geoDistanceKm(p.lat, p.lon, c.latitude, c.longitude);
      if (d < bestD) { bestD = d; bestKm = km; }
    }
    console.log(`  poste km=${String(p.km).padStart(4)} (${p.lat.toFixed(4)},${p.lon.toFixed(4)}) → curado km≈${bestKm} (d=${bestD.toFixed(1)}km)`);
  }
}
