'use strict';

// Mide la cobertura OFFLINE de la cascada de kilometraje sobre un export de
// alertas (id,road,kilometer,state,event_at,latitude,longitude,location_status):
//
//   node tools/rnc-alerts-coverage.js /ruta/alerts.json [--json salida.json]
//
// Reproduce los pasos que no requieren red ni llaves, en el mismo orden que
// resolveRoadLocation:
//   1. postes revisados a mano (rnc-km-anchors)
//   2. RED_VIAL estático — aporta 0 mientras chainageVerified no se asigne
//   3. red RNC 2025 certificada (rnc-loader: poste exacto o interpolación)
// Lo que queda fuera (geocodificador externo, punto medio del corredor,
// verificación de estado por reverse-geocoding) se reporta aparte: este número
// es el suelo de lo que el worker resolvería sin tocar la red.

const fs = require('node:fs');
const { resolveRncPost, resolveRncEstimatedKm } = require('../worker/rnc-km-anchors');
const RNC = require('../worker/rnc-loader');

function main(argv) {
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('Uso: node tools/rnc-alerts-coverage.js alerts.json [--json salida.json]');
    return 2;
  }
  const alerts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const jsonAt = argv.indexOf('--json');
  const jsonOut = jsonAt !== -1 ? argv[jsonAt + 1] : null;

  const kmAlerts = alerts.filter(a => a.road && a.kilometer != null);
  const roadOnly = alerts.filter(a => a.road && a.kilometer == null);
  const levels = {
    anchor_post: [],        // poste revisado a mano (rnc-km-anchors)
    anchor_estimate: [],    // estimación revisada entre postes
    rnc_poste: [],          // poste oficial exacto (carga diferida)
    rnc_interpolated: [],   // interpolación en ventana certificada
    unresolved: []          // necesita geocodificador externo
  };
  const groups = new Map(); // vía+km → resultado, para ver deduplicación

  for (const a of kmAlerts) {
    const km = Number(a.kilometer);
    const state = a.state || '';
    let level = 'unresolved';
    let hit = resolveRncPost(a.road, km, state);
    if (hit) level = 'anchor_post';
    if (!hit) {
      hit = resolveRncEstimatedKm(a.road, km, state);
      if (hit) level = 'anchor_estimate';
    }
    if (!hit) {
      hit = RNC.resolveNetworkKilometer(a.road, km);
      if (hit) level = hit.precision === 'rnc_poste' ? 'rnc_poste' : 'rnc_interpolated';
    }
    levels[level].push({ id: a.id, road: a.road, km, state, precision: hit && hit.precision });
    const key = `${a.road} · km ${km}`;
    if (!groups.has(key)) groups.set(key, level);
  }

  // Punto medio del corredor: solo como referencia de cuántas alertas sin km
  // podrían orientarse si además falla el geocodificador (último recurso).
  const midpointOk = roadOnly.filter(a => RNC.corridorMidpoint(a.road)).length;

  const total = kmAlerts.length;
  const resolved = total - levels.unresolved.length;
  const pct = n => total ? `${((n / total) * 100).toFixed(1)}%` : '—';
  const withState = kmAlerts.filter(a => a.state).length;

  console.log(`Alertas leídas: ${alerts.length} · con vía+km: ${total} · con vía sin km: ${roadOnly.length}`);
  console.log(`  postes revisados (ancla)   ${String(levels.anchor_post.length).padStart(4)}  ${pct(levels.anchor_post.length)}`);
  console.log(`  estimación revisada        ${String(levels.anchor_estimate.length).padStart(4)}  ${pct(levels.anchor_estimate.length)}`);
  console.log(`  poste oficial RNC exacto   ${String(levels.rnc_poste.length).padStart(4)}  ${pct(levels.rnc_poste.length)}`);
  console.log(`  interpolación RNC cert.    ${String(levels.rnc_interpolated.length).padStart(4)}  ${pct(levels.rnc_interpolated.length)}`);
  console.log(`  sin resolver (externo)     ${String(levels.unresolved.length).padStart(4)}  ${pct(levels.unresolved.length)}`);
  console.log(`Cobertura offline: ${resolved}/${total} = ${pct(resolved)}`);
  console.log(`Grupos vía+km únicos: ${groups.size} · alertas con estado (verificación en producción): ${withState}`);

  // Cruce con lo que la producción logró hoy: cuántas de las resueltas offline
  // están todavía sin ubicar (el valor práctico del paso RNC).
  const statusById = new Map(alerts.map(a => [a.id, a.location_status]));
  const unlocated = list => list.filter(x => statusById.get(x.id) === 'unlocated').length;
  console.log('Sin ubicar HOY por nivel (lo que el paso RNC desbloquearía):');
  for (const [level, list] of Object.entries(levels)) {
    console.log(`  ${level.padEnd(20)} ${String(unlocated(list)).padStart(4)} de ${list.length}`);
  }
  const unlocatedTotal = kmAlerts.filter(a => a.location_status === 'unlocated').length;
  console.log(`Hoy sin ubicar (location_status=unlocated): ${unlocatedTotal} · punto medio disponible para las ${roadOnly.length} sin km: ${midpointOk}`);

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      total, resolved,
      unlocated: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, unlocated(v)])),
      levels,
      groups: [...groups].map(([key, level]) => ({ key, level }))
    }, null, 2));
    console.log(`JSON → ${jsonOut}`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
