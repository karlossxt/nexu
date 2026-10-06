'use strict';
// Reproduce calibrate() sobre reconstrucciones de cadenas reales para ver
// por qué cadenas con runs perfectos quedan sin calibrar.
//   node tools/rnc-calibrate-repro.js 91:18 95:6
const path = require('node:path');
const build = require(path.join(__dirname, 'build-rnc.js'));
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));

const { calibrate, projectOnPolyline } = build;
const index = rnc._loadIndex();

for (const id of process.argv.slice(2)) {
  const [code] = id.split(':');
  const meta = (index.codes[code] || []).find(m => m.id === id);
  const data = rnc._loadKm(code);
  const chain = data.chains.find(c => c.id === id);
  const pts = chain.pts.map(x => [x[2], x[1]]);   // [[lon,lat]]
  const posts = chain.posts.map(p => {
    const hit = projectOnPolyline(p.lon, p.lat, pts);
    return { km: p.km, snappedKm: +(hit.fraction * meta.total).toFixed(3), lat: p.lat, lon: p.lon, dist: p.dist };
  });
  const fake = {
    id, total: meta.total, reversed: false,
    pts: chain.pts.map(x => x.slice()),
    sections: meta.sections.map(s => ({ ...s })),
    posts, calibrated: false
  };
  calibrate(fake);
  console.log(`${id}: calibrated=${fake.calibrated} anchors=${fake.anchorPosts} reversed=${fake.reversed} ` +
    `kmStart=${fake.kmStart} win=[${fake.validFrom},${fake.validTo}] residual=${fake.residualKm} postsRestantes=${fake.posts.length}`);
  console.log(`  cals: ${JSON.stringify(fake.cals)}`);
}
