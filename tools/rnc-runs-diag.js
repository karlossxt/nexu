'use strict';
// Postes y runs máximos (ambas orientaciones) de cadenas elegidas.
// El km file no serializa snappedKm: se recalcula proyectando sobre la polilínea.
//   node tools/rnc-runs-diag.js 95:6 91:18 95:10 150:33
const path = require('node:path');
const build = require(path.join(__dirname, 'build-rnc.js'));
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));

const { projectOnPolyline } = build;
const SPREAD = 2.5;

function maximalRuns(posts, offsetOf, minAnchors) {
  const out = [];
  let start = 0;
  while (start < posts.length) {
    let min = Infinity, max = -Infinity;
    let end = start;
    for (; end < posts.length; end++) {
      const off = offsetOf(posts[end]);
      const nmin = Math.min(min, off), nmax = Math.max(max, off);
      if (!(nmax - nmin <= SPREAD)) break;   // NaN rompe el run
      min = nmin; max = nmax;
    }
    const n = end - start;
    if (n >= minAnchors) out.push({ from: start, to: end, n, spread: max - min });
    start = end > start ? end : start + 1;
  }
  return out;
}

const ids = process.argv.slice(2);
const index = rnc._loadIndex();
for (const id of ids) {
  const [code] = id.split(':');
  const meta = (index.codes[code] || []).find(m => m.id === id);
  if (!meta) { console.log(`${id}: no existe`); continue; }
  const data = rnc._loadKm(code);
  const chain = data.chains.find(c => c.id === id);
  console.log(`\n=== ${id} total=${meta.total} peaje=${meta.peaje} cal=${meta.calibrated} win=[${meta.validFrom},${meta.validTo}] anchors=${meta.anchorPosts} reversed=${meta.reversed}`);
  console.log(`    secs: ${(meta.sections || []).map(s => `${s.name}(${Math.round(s.from)}..${Math.round(s.to)})`).join(' | ')}`);
  const pts = (chain.pts || []).map(x => [x[2], x[1]]);   // [[lon,lat]]
  const posts = ((chain && chain.posts) || [])
    .map(p => {
      const hit = projectOnPolyline(p.lon, p.lat, pts);
      return hit && Number.isFinite(hit.fraction)
        ? { ...p, acc: hit.fraction * meta.total } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.acc - b.acc);
  console.log(`    posts: ${posts.length}`);
  for (const orient of ['FWD', 'REV']) {
    const runs = orient === 'FWD'
      ? maximalRuns(posts, p => p.km - p.acc, 2)
      : maximalRuns(posts, p => p.km + p.acc, 2);
    for (const r of runs) {
      const a = posts[r.from], b = posts[r.to - 1];
      const off0 = orient === 'FWD' ? a.km - a.acc : a.km + a.acc;
      const off1 = orient === 'FWD' ? b.km - b.acc : b.km + b.acc;
      console.log(`    ${orient} n=${String(r.n).padStart(3)} spread=${r.spread.toFixed(1)} acc=${a.acc.toFixed(1)}..${b.acc.toFixed(1)} km=${a.km}..${b.km} off≈${off0.toFixed(1)}..${off1.toFixed(1)} frac=${(r.n / posts.length).toFixed(2)}`);
    }
  }
}
