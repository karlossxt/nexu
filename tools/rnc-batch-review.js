'use strict';

// Port a Node de tools/rnc-batch-review.py. Ordena alertas viales sin punto por
// las cadenas candidatas de la revisión nacional. Nunca publica un pin.

const fs = require('node:fs');
const path = require('node:path');

// Windows guarda JSON con BOM; rompe JSON.parse sin motivo aparente.
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const STOP_TOKENS = new Set(['autopista', 'carretera', 'de', 'del', 'la', 'el', 'cuota', 'federal', 'km']);

// El orden importa: name_matches exige igualdad exacta de la lista, así que
// "Cuernavaca - Acapulco" y "Acapulco - Cuernavaca" no se equiparan.
function tokens(value) {
  const plain = String(value ?? '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  return (plain.match(/[a-z0-9]+/g) || []).filter(token => !STOP_TOKENS.has(token));
}

function nameMatches(alertRoad, chainName) {
  const a = tokens(alertRoad), b = tokens(chainName);
  return a.length >= 2 && a.length === b.length && a.every((token, i) => token === b[i]);
}

// float() solo acepta números y cadenas: listas y diccionarios lanzan
// TypeError y se descartan. Un booleano sí convertiría a 1.0 en Python, pero se
// rechaza aquí a propósito: un kilometer corrupto no debe parecer un km 1
// plausible en la cola de revisión.
function toKilometer(value) {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function review(alerts, report, traffic = []) {
  const groups = new Map();
  for (const alert of alerts) {
    if (alert.latitude != null || alert.longitude != null) continue;
    const road = alert.road;
    if (!road) continue;
    const km = toKilometer(alert.kilometer);
    if (km === null) continue;
    const key = JSON.stringify([road, km]);
    if (!groups.has(key)) groups.set(key, { road, km, rows: [] });
    groups.get(key).rows.push(alert);
  }

  const output = [];
  for (const { road, km, rows } of groups.values()) {
    const candidates = [];
    for (const chain of report.chains) {
      if (!nameMatches(road, chain.name) || !(chain.fromKm <= km && km <= chain.toKm)) continue;
      const exact = chain.posts.filter(p => p.km === km);
      candidates.push({
        code: chain.code, name: chain.name, range: [chain.fromKm, chain.toKm],
        postIds: exact.map(p => p.id), exactPost: exact.length === 1
      });
    }
    const reason = !candidates.length ? 'no_matching_chain'
      : candidates.length > 1 ? 'ambiguous_chains'
        : candidates[0].exactPost ? 'exact_post_needs_review'
          : 'gap_needs_review';

    const samples = traffic.filter(s => nameMatches(road, s.road));
    const sample = samples.length ? samples.reduce((best, s) => (s.tdpa > best.tdpa ? s : best)) : null;

    const states = [...new Set(rows.map(a => a.state).filter(Boolean))].sort();
    const latestEventAt = rows.reduce((max, a) => ((a.event_at || '') > max ? (a.event_at || '') : max), '');

    output.push({
      road, kilometer: km, alerts: rows.length, states, latestEventAt,
      alertIds: rows.map(a => a.id).filter(id => id),
      trafficSample: sample, reason, candidates, status: 'review_required'
    });
  }

  // Una estación es una muestra, no un ranking de carretera ni nacional. Las
  // alertingas sin muestra quedan visibles debajo de los corredores medidos.
  if (traffic.length) {
    return output.sort((x, y) =>
      Number(Boolean(y.trafficSample)) - Number(Boolean(x.trafficSample))
      || -(y.trafficSample ? y.trafficSample.tdpa : 0) + (x.trafficSample ? x.trafficSample.tdpa : 0)
      || y.alerts - x.alerts
      || compare(x.road, y.road)
      || x.kilometer - y.kilometer);
  }
  return output.sort((x, y) =>
    y.alerts - x.alerts
    || Number(Boolean(y.candidates)) - Number(Boolean(x.candidates))
    || compare(x.road, y.road)
    || x.kilometer - y.kilometer);
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function main(argv) {
  if (argv.length < 3 || argv.length > 4) {
    console.error('Usage: node tools/rnc-batch-review.js alerts.json rnc-national-review.json output.json [traffic.json]');
    return 1;
  }
  const [alertsPath, sourcePath, targetPath, trafficPath] = argv;
  const traffic = trafficPath ? readJson(trafficPath) : [];
  const result = review(readJson(alertsPath), readJson(sourcePath), traffic);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    groups: result.length,
    alerts: result.reduce((sum, r) => sum + r.alerts, 0),
    exactCandidates: result.filter(r => r.reason === 'exact_post_needs_review').length
  }));
  return 0;
}

module.exports = { tokens, nameMatches, review };

if (require.main === module) process.exit(main(process.argv.slice(2)));