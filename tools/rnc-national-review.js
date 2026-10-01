'use strict';

// Port a Node de tools/rnc-national-review.py. Sustituye a Python: el GeoPackage
// es un SQLite y node:sqlite lo lee de forma nativa, sin dependencias externas.
// La lógica es idéntica al original; los umbrales y las reglas conservadoras no
// se tocan. Este script nunca aprueba coordenadas de producción.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// Windows guarda JSON con BOM; rompe JSON.parse sin motivo aparente.
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const EARTH_M_PER_DEG = 111195;
const MAX_SNAP_M = 120;
const AMBIGUITY_M = 30;
const MAX_GAP_KM = 3;
const MIN_CHAIN_POSTS = 4;

// round() de Python redondea a pares (half-to-even); Math.round redondea hacia
// arriba. La diferencia es de una unidad, pero puede cruzar los umbrales de
// comparación, así que se replica exactamente.
function pyRound(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  if (Math.abs(diff - 0.5) < 1e-9) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(scaled);
  return rounded / factor;
}

function geometry(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (!buffer.length || buffer.toString('latin1', 0, 2) !== 'GP') throw new Error('Expected GeoPackage geometry');
  const flags = buffer[3];
  const envelope = [0, 32, 48, 48, 64, 0, 0, 0][(flags >> 1) & 7];
  let pos = 8 + envelope;
  const little = buffer[pos] === 1;
  const kind = (little ? buffer.readUInt32LE(pos + 1) : buffer.readUInt32BE(pos + 1)) % 1000;
  pos += 5;
  if (kind === 1) {
    const point = [];
    point.push(little ? buffer.readDoubleLE(pos) : buffer.readDoubleBE(pos));
    point.push(little ? buffer.readDoubleLE(pos + 8) : buffer.readDoubleBE(pos + 8));
    return [point];
  }
  if (kind !== 2) throw new Error(`Unexpected geometry type ${kind}`);
  const count = little ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos);
  const points = [];
  for (let i = 0; i < count; i++) {
    const at = pos + 4 + i * 16;
    points.push([
      little ? buffer.readDoubleLE(at) : buffer.readDoubleBE(at),
      little ? buffer.readDoubleLE(at + 8) : buffer.readDoubleBE(at + 8)
    ]);
  }
  return points;
}

function closestOnLine(lon, lat, vertices) {
  const scale = Math.cos(lat * Math.PI / 180);
  let bestDistance = Infinity, bestX = lon, bestY = lat;
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1], b = vertices[i];
    const dx = (b[0] - a[0]) * scale;
    const dy = b[1] - a[1];
    const denom = dx * dx + dy * dy;
    const t = denom ? Math.max(0, Math.min(1, ((lon - a[0]) * scale * dx + (lat - a[1]) * dy) / denom)) : 0;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const distance = Math.hypot((lon - x) * scale, lat - y) * EARTH_M_PER_DEG;
    if (distance < bestDistance) { bestDistance = distance; bestX = x; bestY = y; }
  }
  return [bestDistance, bestX, bestY];
}

function separationM(a, b) {
  const lat = (a.lat + b.lat) / 2;
  return Math.hypot((a.lon - b.lon) * Math.cos(lat * Math.PI / 180), a.lat - b.lat) * EARTH_M_PER_DEG;
}

function pairOk(a, b) {
  const gap = b.km - a.km;
  if (gap <= 0 || gap > MAX_GAP_KM) return false;
  const distance = separationM(a, b);
  return Math.max(0, gap * 550 - 150) <= distance && distance <= gap * 1080 + 150;
}

// Nunca elige un ganador entre kilometrajes repetidos de un mismo código, ni
// siquiera entre nombres de tramo distintos.
function reviewedChains(assigned) {
  const byCodeKm = new Map();
  for (const p of assigned) {
    const key = `${p.code}|${p.km}`;
    byCodeKm.set(key, (byCodeKm.get(key) || 0) + 1);
  }
  const blocked = new Set([...byCodeKm].filter(([, count]) => count > 1).map(([key]) => key));
  const flagged = assigned.filter(p => byCodeKm.get(`${p.code}|${p.km}`) > 1)
    .map(p => ({ ...p, reason: 'duplicate_km_same_code' }));
  const unique = assigned.filter(p => byCodeKm.get(`${p.code}|${p.km}`) === 1);

  const groups = new Map();
  for (const p of unique) {
    const key = JSON.stringify([p.code, p.name]);
    if (!groups.has(key)) groups.set(key, { code: p.code, name: p.name, posts: [] });
    groups.get(key).posts.push(p);
  }

  const chains = [];
  const finish = (current, code, name) => {
    if (current.length >= MIN_CHAIN_POSTS) {
      chains.push({ code, name, toll: true, fromKm: current[0].km, toKm: current[current.length - 1].km, posts: current.map(p => ({ ...p })) });
    } else {
      for (const p of current) flagged.push({ ...p, reason: 'short_or_isolated_chain' });
    }
  };

  const ordered = [...groups.values()].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { code, name, posts } of ordered) {
    posts.sort((a, b) => a.km - b.km);
    let current = [];
    for (const p of posts) {
      let crossesDuplicate = false;
      if (current.length) {
        for (let k = current[current.length - 1].km + 1; k < p.km; k++) {
          if (blocked.has(`${code}|${k}`)) { crossesDuplicate = true; break; }
        }
      }
      if (current.length && (crossesDuplicate || !pairOk(current[current.length - 1], p))) {
        finish(current, code, name);
        current = [];
      }
      current.push(p);
    }
    if (current.length) finish(current, code, name);
  }
  return [chains, flagged];
}

// Una ancla independiente debe nombrar el código de ruta; nunca se elige
// cualquier código cercano.
function validateAnchors(chains, anchors, toleranceM = 500) {
  const results = [];
  for (const anchor of anchors) {
    const code = String(anchor.code), km = Number(anchor.km);
    const possible = [];
    for (const chain of chains) {
      if (chain.code !== code || (anchor.name && anchor.name !== chain.name)) continue;
      const points = chain.posts;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (a.km <= km && km <= b.km) {
          const factor = (km - a.km) / (b.km - a.km);
          possible.push({
            lat: a.lat + factor * (b.lat - a.lat),
            lon: a.lon + factor * (b.lon - a.lon)
          });
          break;
        }
      }
    }
    if (possible.length !== 1) {
      results.push({ code, km, result: possible.length ? 'ambiguous' : 'not_covered' });
      continue;
    }
    const error = pyRound(separationM(anchor, possible[0]));
    results.push({ code, km, result: error <= toleranceM ? 'ok' : 'outside_tolerance', errorM: error });
  }
  const errors = results.filter(r => 'errorM' in r).map(r => r.errorM).sort((a, b) => a - b);
  return {
    total: anchors.length,
    coveredExactlyOnce: results.filter(r => 'errorM' in r).length,
    withinTolerance: errors.length,
    medianErrorM: errors.length ? errors[Math.floor(errors.length / 2)] : null,
    results
  };
}

const ROAD_QUERY = `select r.ID_RED,r.CODIGO,r.PEAJE,r.NOMBRE,r.geom
  from rtree_red_vial_geom as bbox join red_vial as r on r.fid=bbox.id
  where bbox.minx<=? and bbox.maxx>=? and bbox.miny<=? and bbox.maxy>=?
    and r.PEAJE in ('Si','No') and r.CODIGO is not null`;

function nearbyRoads(roadsStatement, lon, lat, maxSnapM = MAX_SNAP_M) {
  // Se amplia la ventana del RTree un poco más allá del umbral métrico. La
  // proyección exacta de abajo decide la distancia final.
  const deltaLat = (maxSnapM + 40) / EARTH_M_PER_DEG;
  const deltaLon = deltaLat / Math.max(.2, Math.cos(lat * Math.PI / 180));
  const found = [];
  for (const row of roadsStatement.all(lon + deltaLon, lon - deltaLon, lat + deltaLat, lat - deltaLat)) {
    const code = String(row.CODIGO ?? '').trim();
    if (!/^\d+$/.test(code) || !(Number(code) >= 1 && Number(code) <= 999)) continue;
    const [dist, x, y] = closestOnLine(lon, lat, geometry(row.geom));
    if (dist <= maxSnapM) {
      found.push({
        roadId: row.ID_RED, code, toll: row.PEAJE === 'Si',
        name: String(row.NOMBRE ?? '').trim(), snapM: pyRound(dist, 1),
        snappedLon: x, snappedLat: y
      });
    }
  }
  return found.sort((a, b) => a.snapM - b.snapM);
}

const PLACEHOLDER_NAME = /^N\/?[DA]$/i;

// Un tramo de cuota sin nombre propio puede recibir el nombre canonico de un
// tramo corroborado por plaza de cobro, SOLO si ese mismo ID_RED esta en el
// conjunto verificado. La identidad viene de la plaza declarada, no de la
// geometria: el poste no gana nada por proximity que no tuviera antes.
function resolvedName(road, plazaVerification) {
  const own = String(road.name ?? '').trim();
  if (own && !PLACEHOLDER_NAME.test(own)) return { name: own, source: 'road' };
  const entry = plazaVerification && plazaVerification.get(road.roadId);
  if (!entry || !entry.names.length) return { name: '', source: null };
  if (entry.code !== road.code) return { name: '', source: null };
  return { name: entry.names[0], source: 'toll_plaza_verified' };
}

function assignPost(post, candidates, ambiguityM = AMBIGUITY_M, plazaVerification = new Map()) {
  // Cada entrada conserva la referencia al candidate original: la comprobacion
  // de ambiguedad compara por identidad y necesita poder saltarse el mejor.
  const toll = [];
  for (const candidate of candidates) {
    if (!candidate.toll) continue;
    const { name, source } = resolvedName(candidate, plazaVerification);
    if (!name) continue;
    toll.push({ candidate, name, source });
  }
  if (!toll.length) return [null, 'no_named_toll_road_within_120m'];
  const winner = toll[0];
  for (const other of candidates) {
    if (other === winner.candidate || other.snapM > winner.candidate.snapM + ambiguityM) continue;
    if (!other.toll || other.code !== winner.candidate.code) return [null, 'ambiguous_free_or_other_code'];
    const otherName = String(other.name ?? '').trim();
    if (otherName && !PLACEHOLDER_NAME.test(otherName) && otherName !== winner.name) {
      return [null, 'ambiguous_corridor_name'];
    }
  }
  return [{ ...post, ...winner.candidate, name: winner.name, nameSource: winner.source }, null];
}

function loadPlazaVerification(file) {
  const map = new Map();
  if (!file) return map;
  // Se acepta una ruta o el objeto ya leído, para poder probar el index sin
  // escribir un archivo temporal.
  const raw = typeof file === 'string' ? readJson(file) : file;
  const entries = Array.isArray(raw) ? raw : raw.entries || [];
  for (const entry of entries) {
    if (!entry || !entry.names || !entry.names.length) continue;
    map.set(entry.idRed, { code: String(entry.code), names: entry.names });
  }
  return map;
}

function buildReport(db, limit = 0, plazaVerification = new Map()) {
  const roadsStatement = db.prepare(ROAD_QUERY);
  const postsStatement = db.prepare('select ID_KM,KM,geom from poste_de_referencia');
  const assigned = [], flagged = [];
  let totalPosts = 0;
  let rescuedByPlaza = 0;

  for (const row of postsStatement.iterate()) {
    if (limit && totalPosts >= limit) break;
    totalPosts++;
    const [lon, lat] = geometry(row.geom)[0];
    const post = { id: row.ID_KM, km: row.KM, lat, lon };
    if (row.KM == null || row.KM < 0 || row.KM > 2000) {
      flagged.push({ ...post, reason: 'invalid_or_extreme_km' });
      continue;
    }
    const [selected, reason] = assignPost(post, nearbyRoads(roadsStatement, lon, lat), AMBIGUITY_M, plazaVerification);
    if (selected) {
      if (selected.nameSource === 'toll_plaza_verified') rescuedByPlaza++;
      assigned.push(selected);
    } else flagged.push({ ...post, reason });
    if (totalPosts % 5000 === 0) console.log(`reviewed ${totalPosts} posts`);
  }

  const [chains, chainFlags] = reviewedChains(assigned);
  flagged.push(...chainFlags);

  const reasons = {};
  for (const p of flagged) reasons[p.reason] = (reasons[p.reason] || 0) + 1;

  const codes = [...new Set(chains.map(c => c.code))].sort((a, b) => Number(a) - Number(b));
  const byCode = {};
  for (const code of codes) {
    byCode[code] = {
      chains: chains.filter(c => c.code === code).length,
      posts: chains.filter(c => c.code === code).reduce((sum, c) => sum + c.posts.length, 0)
    };
  }

  return {
    status: 'review_required',
    source: 'INEGI RNC 2025 GeoPackage',
    policy: {
      tollOnly: true, maxSnapM: MAX_SNAP_M, ambiguityM: AMBIGUITY_M, maxGapKm: MAX_GAP_KM,
      minChainPosts: MIN_CHAIN_POSTS, duplicateKm: 'reject every duplicate within route code', runtimeUse: 'none'
    },
    summary: {
      totalPosts,
      assignedBeforeChainReview: assigned.length,
      // Poste que, sin este indice, se habria descartado por falta de nombre y
      // cuyo nombre viene de un tramo corroborado por plaza declarada.
      rescuedByTollPlaza: rescuedByPlaza,
      candidateChains: chains.length,
      candidatePosts: chains.reduce((sum, c) => sum + c.posts.length, 0),
      flagged: flagged.length,
      reasons,
      byCode
    },
    chains,
    flaggedPosts: flagged
  };
}

function parseArgs(argv) {
  const options = { gpkg: null, output: null, limit: 0, anchors: null, plazaVerification: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') { options.limit = Number(argv[++i]); continue; }
    if (arg === '--anchors') { options.anchors = argv[++i]; continue; }
    if (arg === '--plaza-verification') { options.plazaVerification = argv[++i]; continue; }
    if (!options.gpkg) options.gpkg = arg;
    else if (!options.output) options.output = arg;
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.gpkg || !options.output) {
    console.error('Usage: node tools/rnc-national-review.js rnc2025.gpkg report.json [--limit N] [--anchors anchors.json] [--plaza-verification verif.json]');
    return 1;
  }
  if (options.limit && !(options.limit > 0)) {
    console.error('--limit requiere un número entero positivo');
    return 1;
  }

  const db = new DatabaseSync(options.gpkg, { readOnly: true });
  let report;
  try {
    report = buildReport(db, options.limit, loadPlazaVerification(options.plazaVerification));
  } finally {
    db.close();
  }
  if (options.anchors) {
    report.anchorValidation = validateAnchors(report.chains, readJson(options.anchors));
  }
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
  return 0;
}

module.exports = {
  EARTH_M_PER_DEG, MAX_SNAP_M, AMBIGUITY_M, MAX_GAP_KM, MIN_CHAIN_POSTS,
  geometry, closestOnLine, separationM, pairOk, reviewedChains, validateAnchors,
  nearbyRoads, assignPost, buildReport, pyRound, parseArgs,
  resolvedName, loadPlazaVerification, PLACEHOLDER_NAME
};

if (require.main === module) process.exit(main(process.argv.slice(2)));