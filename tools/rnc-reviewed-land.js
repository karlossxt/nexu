'use strict';
// ¿Dónde caen los postes revisados sobre las cadenas de su familia y con qué
// offset (oficial − acum)? Revela poblaciones de numeración múltiples.
const path = require('node:path');
const build = require(path.join(__dirname, 'build-rnc.js'));
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));
const { projectOnPolyline } = build;
const { extractRouteCodes, routeFamily, geoDistanceKm } = require(path.join(__dirname, '..', 'lib', 'road-match'));

const index = rnc._loadIndex();
const reviewed = [
  ...require(path.join(__dirname, '..', 'worker', 'rnc-150d-reviewed.json')).map(p => ({ ...p, road: 'Acatzingo–Ciudad Mendoza 150D' })),
  ...require(path.join(__dirname, '..', 'worker', 'rnc-20260928-reviewed.json')),
  ...require(path.join(__dirname, '..', 'worker', 'rnc-20260930-reviewed.json'))
];

for (const p of reviewed) {
  const codes = extractRouteCodes(p.road);
  const fam = routeFamily(codes[0] || '');
  const metas = index.codes[fam] || [];
  const data = rnc._loadKm(fam);
  if (!data) { console.log(`km ${p.km} (${p.road}): sin datos de ${fam}`); continue; }
  const found = [];
  for (const meta of metas) {
    const chain = data.chains.find(c => c.id === meta.id);
    if (!chain || !chain.pts.length) continue;
    const pts = chain.pts.map(x => [x[2], x[1]]);
    const hit = projectOnPolyline(p.lon, p.lat, pts);
    if (!hit || hit.distKm > 0.5) continue;
    const acc = hit.fraction * meta.total;
    found.push({ id: meta.id, acc, off: p.km - acc, d: hit.distKm, win: `[${meta.validFrom},${meta.validTo}]`, cal: meta.calibrated, peaje: meta.peaje });
  }
  found.sort((a, b) => a.d - b.d);
  const desc = found.map(f =>
    `${f.id} acc=${f.acc.toFixed(1)} off=${f.off.toFixed(1)} ${f.cal ? 'CAL' : '---'} peaje=${f.peaje} win=${f.win} d=${f.d.toFixed(3)}`).join('  ||  ');
  console.log(`km ${String(p.km).padStart(3)} ${String(p.state || '').padEnd(10)} ${fam}: ${desc || 'SIN CADENA CERCANA'}`);
}
