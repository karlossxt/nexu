'use strict';

// Corrida del invariante de cadena sobre el GeoPackage real. Reporte de solo
// lectura: no escribe coordenadas de produccion ni modifica nada.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { evaluate, summarize, VERDICTS } = require('./rnc-chain-invariant');

function run(gpkg, reviewFile, outFile) {
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const chains = review.chains;

  const roadIds = new Set();
  for (const c of chains) for (const p of c.posts) roadIds.add(p.roadId);
  const wanted = new Set([...roadIds].map(Number));

  // red_vial no tiene indice por ID_RED (4,349,691 filas): una sola pasada
  // filtrada en JS. Un SELECT por via seria un escaneo completo por cada una.
  const db = new DatabaseSync(gpkg);
  const stmt = db.prepare('select ID_RED,PEAJE,ADMINISTRA,JURISDI,NIVEL,TIPO_VIAL from red_vial');
  const roads = new Map();
  for (const row of stmt.iterate()) {
    if (!wanted.has(Number(row.ID_RED))) continue;
    roads.set(Number(row.ID_RED), {
      toll: row.PEAJE === 'Si',
      admin: String(row.ADMINISTRA ?? '').trim(),
      jurisdiccion: String(row.JURISDI ?? '').trim(),
      nivel: row.NIVEL,
      tipo: String(row.TIPO_VIAL ?? '').trim(),
    });
  }
  db.close();

  const missing = [...roadIds].filter(id => !roads.has(Number(id)));
  if (missing.length) console.warn(`[warn] ${missing.length} ID_RED no encontrados en red_vial`);

  const result = evaluate(review, roads);
  const summary = summarize(result);

  const report = {
    status: 'review_only',
    source: review.source,
    runtime_use: 'none',
    summary,
    totals: { chains: chains.length, corridors: result.corridors.length, bridges: result.bridges.length, posts: chains.reduce((s, c) => s + c.posts.length, 0), roadIds: roadIds.size, missingRoadIds: missing.length },
    corridors: result.corridors,
    rejectedBridges: result.bridges.filter(b => b.verdict !== VERDICTS.ok),
    invariants: {
      cuotaLibre: 'mide cero sobre 127/127; se conserva como garantia, no como señal',
      entidad: 'informa, no rechaza: una cuota estatal es una vía legítima',
      ramal: 'informa, independiente de entidad (solapan 4 de 23)',
      cadenamiento: 'ID_KM solo detecta mezcla de sentido; nunca deriva kilometraje',
      vecinos: 'decide: separa uniones contiguas de uniones imposibles',
    },
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
  return report;
}

if (require.main === module) {
  const [gpkg, reviewFile, outFile] = process.argv.slice(2);
  if (!gpkg || !reviewFile || !outFile) {
    console.error('uso: node tools/rnc-chain-invariant-run.js <gpkg> <review.json> <out.json>');
    process.exit(1);
  }
  const r = run(gpkg, reviewFile, outFile);
  console.log(JSON.stringify(r.summary, null, 1));
  console.log(JSON.stringify(r.totals));
}

module.exports = { run };