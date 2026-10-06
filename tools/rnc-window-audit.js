'use strict';
// Auditoría desechable: ¿las ventanas oficiales de las cadenas calibradas de un
// código se solapan entre sí (numeración que reinicia por sección) o se teselan
// (numeración continua por ruta)?

const path = require('node:path');
const rnc = require(path.join(__dirname, '..', 'worker', 'rnc-loader'));

const codes = process.argv.slice(2);
const index = rnc._loadIndex();
if (!index) {
  console.error('no hay índice en worker/data — corre node tools/build-rnc.js');
  process.exit(1);
}

for (const code of (codes.length ? codes : ['57', '15'])) {
  const metas = (index.codes[code] || [])
    .filter(c => c.calibrated && c.anchorPosts >= 3)
    .sort((a, b) => a.validFrom - b.validFrom);
  console.log(`\ncódigo ${code}: ${metas.length} cadenas calibradas con ≥3 anclas`);
  for (const m of metas) {
    const secs = (m.sections || []).map(s => s.name).slice(0, 2).join(' | ');
    console.log(
      `  ${m.id.padEnd(9)} win=[${String(m.validFrom).padStart(7)}, ${String(m.validTo).padStart(7)}] ` +
      `total=${String(m.total).padStart(6)} anchors=${String(m.anchorPosts).padStart(3)} ` +
      `peaje=${String(m.peaje).padEnd(5)} ${secs}`);
  }

  // Solapes: ¿cuántas ventanas distintas contienen un mismo km?
  const points = [];
  for (const m of metas) {
    points.push([m.validFrom, +1, m.id]);
    points.push([m.validTo, -1, m.id]);
  }
  points.sort((a, b) => a[0] - b[0]);
  let depth = 0, maxDepth = 0;
  const samples = new Map();
  let i = 0;
  while (i < points.length) {
    const km = points[i][0];
    while (i < points.length && points[i][0] === km) depth += points[i++][1];
    if (depth > maxDepth) maxDepth = depth;
    if (depth > 1 && samples.size < 6 && !samples.has(depth)) samples.set(depth, km);
  }
  console.log(`  profundidad máxima de solape de ventanas: ${maxDepth} ` +
    (samples.size ? `— ej: km ${[...samples.values()].join(', ')}` : '(sin solapes)'));
}
