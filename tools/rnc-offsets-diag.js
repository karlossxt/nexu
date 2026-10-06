'use strict';
// ¿Qué numeración cargan los postes de las cadenas clave de la ruta 150?
// Proyecta cada poste sobre la cadena (projectOnPolyline) y calcula el offset
// oficial − acumulado, para ver si hay dos poblaciones enfrentadas.
const path = require('node:path');
const build = require(path.join(__dirname, 'build-rnc.js'));
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));

const { projectOnPolyline } = build;
const index = rnc._loadIndex();

const posts150d = require(path.join(__dirname, '..', 'worker', 'rnc-150d-reviewed.json'))
  .map(p => ({ ...p, road: 'Acatzingo–Ciudad Mendoza 150D' }));
const posts30 = require(path.join(__dirname, '..', 'worker', 'rnc-20260930-reviewed.json'));

for (const chainId of ['150:33', '150:8', '150:46']) {
  const meta = (index.codes['150'] || []).find(m => m.id === chainId);
  if (!meta) { console.log(`${chainId}: no existe`); continue; }
  const data = rnc._loadKm('150');
  const chain = data.chains.find(c => c.id === chainId);
  console.log(`\n=== ${chainId} kmStart=${meta.kmStart} win=[${meta.validFrom},${meta.validTo}] total=${meta.total} peaje=${meta.peaje} anchors=${meta.anchorPosts}`);
  console.log(`    secs: ${meta.sections.map(s => `${s.name}(${Math.round(s.from)}..${Math.round(s.to)})`).join(' | ')}`);

  const pts = chain.pts.map(p => [p[2], p[1]]);   // [[lon,lat]] para proyección
  const offsets = [];
  for (const p of chain.posts || []) {
    const hit = projectOnPolyline(p.lon, p.lat, pts);
    if (hit && Number.isFinite(hit.fraction)) offsets.push({ km: p.km, acc: hit.fraction * meta.total, off: p.km - hit.fraction * meta.total, d: hit.distKm });
  }
  offsets.sort((a, b) => a.acc - b.acc);
  for (const o of offsets) {
    console.log(`    poste km=${String(o.km).padStart(5)} acc=${o.acc.toFixed(1).padStart(6)} offset=${o.off.toFixed(1).padStart(7)} (snap=${o.d.toFixed(3)}km)`);
  }

  // Postes revisados: ¿dónde caen sobre esta cadena?
  const reviewed = [...posts150d, ...posts30].filter(p => p.road.includes('150D'));
  for (const p of reviewed) {
    const hit = projectOnPolyline(p.lon, p.lat, pts);
    if (!hit || !Number.isFinite(hit.fraction)) { console.log(`    REVISADO km=${p.km}: fuera de la cadena`); continue; }
    const acc = hit.fraction * meta.total;
    console.log(`    REVISADO km=${String(p.km).padStart(5)} acc=${acc.toFixed(1).padStart(6)} offset=${(p.km - acc).toFixed(1).padStart(7)} (dist=${hit.distKm.toFixed(2)}km)`);
  }
}
