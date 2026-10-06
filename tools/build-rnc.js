'use strict';

// Construye los datasets RNC del worker desde los shapefiles oficiales de la
// Red Nacional de Caminos 2025 (IMT, https://rnc.imt.mx/tablero/ → Descargar
// datos → por capas). Los CSV publicados traen solo atributos; los shapefiles
// incluyen la geometría geográfica (GCS_Mexico_ITRF2008 ≈ WGS84, UTF-8).
//
// Salidas (relativas a --out, por defecto worker/data):
//   red-vial-index.json.gz  índice liviano: código → cadenas, secciones, rangos
//   km/<código>.json.gz     polilíneas con km calibrado + postes (consulta lazy)
//   casetas.json.gz         plazas de cobro oficiales con coordenadas
//
// Cómo se consigue el km:
//   1. Los tramos con CODIGO real (715 rutas, ~109,000 km) se encadenan por
//      sus nodos UNION_INI/UNION_FIN; la cadena se corta en bifurcaciones para
//      no mezclar tramos paralelos (la RNC no separa libre/cuota en CODIGO:
//      ambos comparten código y se distinguen por PEAJE y por el nombre de la
//      sección).
//   2. El km acumulado de cada cadena arranca con la longitud oficial de cada
//      tramo (LONGITUD, en metros), repartida sobre su geometría.
//   3. Los 46,289 postes de referencia se pegan a la red a ≤120 m y calibran
//      la cadena: desplazamiento oficial − acumulado, y sentido de marcha.
//      Sin ≥2 postes con span ≥3 km y residuos ≤1 km la cadena queda
//      `calibrated:false` y el worker la ignora para km absolutos (los postes
//      sueltos siguen sirviendo para coincidencia exacta de km).
//
// Uso:
//   node tools/build-rnc.js <dir-rnc-work> [--out worker/data] [--codes 57,15]
// <dir-rnc-work> debe contener:
//   redvial/red_vial.{shp,dbf}            poste/poste_de_referencia.{shp,dbf}
//   plaza/plaza_cobro.{shp,dbf}

const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { shpRecords, dbfRows, zip } = require('./shapefile');
const { geoDistanceKm, normalizeRoad, tollNameKey } = require('../lib/road-match');

const SNAP_RADIUS_KM = 0.12;   // radio de pegado de postes (revisión nacional)
const CALIB_MIN_SPAN_KM = 3;   // span mínimo del run de postes (limitado al largo de la cadena)
const CALIB_RUN_SPREAD_KM = 2.5; // ventana máxima de offset (oficial − acumado) dentro de un run
const CALIB_MIN_INLIER_FRACTION = 0.5; // la numeración primaria debe explicar ≥50% de los postes
const CALIB_MIN_ANCHORS = 3;   // postes mínimos para certificar cualquier calibración
const CALIB_STRONG_ANCHORS = 8; // anclas suficientes para certificar sin fracción mayoritaria
const CALIB_MAX_CALS = 4;      // calibraciones (numeraciones) por cadena
const GRID_CELL_DEG = 0.01;    // celdas ~1.1 km para buscar tramos candidatos
const LAT_STEP_KM = 111.19;
const KM_DECIMALS = 2;         // 0.01 km ≈ 10 m de grano en el km por vértice
const COORD_DECIMALS = 5;      // ~1.1 m

function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function inMexico(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= -119 && lon <= -86 && lat >= 14 && lat <= 33;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return !text || /^(n\/d|n\/a)$/i.test(text) ? '' : text;
}

// ---------------------------------------------------------------------------
// Fase 1: recolectar tramos codificados (streaming; el .dbf pesa 2.36 GB)
// ---------------------------------------------------------------------------

function collectSegments(dir, filterCodes) {
  const base = path.join(dir, 'redvial', 'red_vial');
  const byCode = new Map();
  const stats = { total: 0, kept: 0, noGeom: 0, badCoord: 0, multipart: 0 };
  for (const [shape, row] of zip(shpRecords(base + '.shp'), dbfRows(base + '.dbf'))) {
    stats.total++;
    const code = typeof row.CODIGO === 'string' ? row.CODIGO.trim() : row.CODIGO;
    if (!code || code === 'N/D' || code === 'N/A') continue;
    if (filterCodes && !filterCodes.has(code)) continue;
    if (!shape || !shape.parts.length) { stats.noGeom++; continue; }
    if (shape.parts.length > 1) stats.multipart++;
    const pts = [];
    for (const part of shape.parts) {
      for (const [lon, lat] of part) {
        if (!inMexico(lon, lat)) { stats.badCoord++; continue; }
        pts.push([lon, lat]);
      }
    }
    if (pts.length < 2) continue;
    let list = byCode.get(code);
    if (!list) byCode.set(code, (list = []));
    list.push({
      id: row.ID_RED,
      name: clean(row.NOMBRE),
      ini: row.UNION_INI,
      fin: row.UNION_FIN,
      len: Number(row.LONGITUD) || 0,
      peaje: clean(row.PEAJE),
      pts
    });
    stats.kept++;
  }
  return { byCode, stats };
}

// ---------------------------------------------------------------------------
// Fase 2: encadenar los tramos de un código por sus nodos
// ---------------------------------------------------------------------------

function adjacency(segs) {
  const adj = new Map();
  const add = (node, entry) => {
    let list = adj.get(node);
    if (!list) adj.set(node, (list = []));
    list.push(entry);
  };
  segs.forEach((seg, i) => {
    add(seg.ini, { i, end: 0 });
    add(seg.fin, { i, end: 1 });
  });
  return adj;
}

// Camina desde un nodo mientras haya exactamente un tramo sin usar: si hay
// bifurcación (≥2) se detiene antes de elegir, para no mezclar ramales.
function walk(adj, segs, used, startNode) {
  const steps = [];
  let node = startNode;
  for (;;) {
    const candidates = (adj.get(node) || []).filter(c => !used[c.i]);
    if (candidates.length !== 1) break;
    const c = candidates[0];
    used[c.i] = 1;
    const forward = c.end === 0; // entramos por INI → avanzamos INI→FIN
    steps.push({ i: c.i, forward });
    node = forward ? segs[c.i].fin : segs[c.i].ini;
  }
  return steps;
}

function chainCode(segs) {
  const adj = adjacency(segs);
  const used = new Uint8Array(segs.length);
  const chains = [];

  // 1) desde nodos de grado 1 (extremos reales de la red)
  for (const [node, list] of adj) {
    if (list.length !== 1 || used[list[0].i]) continue;
    const steps = walk(adj, segs, used, node);
    if (steps.length) chains.push(steps);
  }
  // 2) el resto (bucles y tramos que quedaron detrás de bifurcaciones): se
  //    siembra con un tramo sin usar y se extiende hacia ambos extremos.
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const forwardSteps = walk(adj, segs, used, segs[i].fin);
    const backwardSteps = walk(adj, segs, used, segs[i].ini);
    const head = backwardSteps
      .reverse()
      .map(s => ({ i: s.i, forward: !s.forward }));
    chains.push([...head, { i, forward: true }, ...forwardSteps]);
  }
  return chains;
}

// ---------------------------------------------------------------------------
// Fase 3: geometría de la cadena con km acumulado + secciones
// ---------------------------------------------------------------------------

function sectionName(raw) {
  // N/D hereda la sección anterior: los tramos sin nombre son enlaces.
  return clean(raw);
}

function buildGeometry(code, steps, segs) {
  const pts = [];        // [km, lat, lon] por vértice, km ascendente
  const sections = [];   // { name, from, to } en km oficial
  const peajes = new Set();
  let current = null;
  let km = 0;
  const bbox = [180, 90, -180, -90]; // W, S, E, N

  for (const step of steps) {
    const seg = segs[step.i];
    const geom = step.forward ? seg.pts : [...seg.pts].reverse();
    const cum = [0];
    for (let i = 1; i < geom.length; i++) {
      cum.push(cum[i - 1] + geoDistanceKm(geom[i - 1][1], geom[i - 1][0], geom[i][1], geom[i][0]));
    }
    const haversine = cum[cum.length - 1];
    const official = seg.len > 0 ? seg.len / 1000 : haversine;
    const startKm = km;

    for (let i = 0; i < geom.length; i++) {
      const [lon, lat] = geom[i];
      const fraction = geom.length > 1
        ? (haversine > 0 ? cum[i] / haversine : i / (geom.length - 1))
        : 1;
      const vertexKm = startKm + fraction * official;
      const last = pts[pts.length - 1];
      if (!last || last[1] !== lat || last[2] !== lon) {
        pts.push([vertexKm, lat, lon]);
      }
      if (lon < bbox[0]) bbox[0] = lon;
      if (lat < bbox[1]) bbox[1] = lat;
      if (lon > bbox[2]) bbox[2] = lon;
      if (lat > bbox[3]) bbox[3] = lat;
    }
    km += official;
    seg.loc = { chain: null, startKm, lenKm: official };

    const name = sectionName(seg.name);
    if (name) {
      if (!current || current.name !== name) {
        if (current) current.to = startKm;
        current = { name, from: startKm, to: official };
        sections.push(current);
      }
    } else if (current) {
      current.to = startKm + official; // sin nombre: alarga la sección vigente
    }
    if (seg.peaje) peajes.add(seg.peaje);
  }
  if (current) current.to = km;
  // Une secciones contiguas con el mismo nombre (ida y vuelta de N/D intercalado)
  const merged = [];
  for (const section of sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.name === section.name && section.from - prev.to < 0.01) prev.to = section.to;
    else merged.push(section);
  }

  const peajeValues = [...peajes];
  return {
    pts,
    sections: merged,
    segLocs: steps.map(s => segs[s.i].loc),
    bbox,
    total: km,
    peaje: peajeValues.length === 1 ? peajeValues[0] : peajeValues.length > 1 ? 'Mixto' : ''
  };
}

// ---------------------------------------------------------------------------
// Fase 4: rejilla espacial + pegado de postes a ≤120 m
// ---------------------------------------------------------------------------

function buildGrid(byCode) {
  const grid = new Map();
  for (const [code, segs] of byCode) {
    segs.forEach((seg, i) => {
      let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
      for (const [lon, lat] of seg.pts) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
      for (let x = Math.floor(minLon / GRID_CELL_DEG); x <= Math.floor(maxLon / GRID_CELL_DEG); x++) {
        for (let y = Math.floor(minLat / GRID_CELL_DEG); y <= Math.floor(maxLat / GRID_CELL_DEG); y++) {
          const key = `${x}:${y}`;
          let cell = grid.get(key);
          if (!cell) grid.set(key, (cell = []));
          cell.push({ code, i });
        }
      }
    });
  }
  return grid;
}

// Proyecta el punto sobre la polilínea en coordenadas planas locales (~km).
// Devuelve distancia al tramo y recorrido acumulado (fracción 0..1).
function projectOnPolyline(lon, lat, pts) {
  const mx = Math.cos(lat * Math.PI / 180) * LAT_STEP_KM;
  const my = LAT_STEP_KM;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + geoDistanceKm(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]));
  }
  const total = cum[cum.length - 1];
  let bestDist = Infinity;
  let bestAt = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1][0] - lon) * mx, ay = (pts[i - 1][1] - lat) * my;
    const bx = (pts[i][0] - lon) * mx, by = (pts[i][1] - lat) * my;
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? -(ax * abx + ay * aby) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + t * abx, dy = ay + t * aby;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      const edge = cum[i] - cum[i - 1];
      bestAt = cum[i - 1] + t * edge;
    }
  }
  if (!(total > 0)) return null;
  return { distKm: bestDist, fraction: bestAt / total };
}

function snapPosts(dir, grid, byCode) {
  const base = path.join(dir, 'poste', 'poste_de_referencia');
  const stats = { total: 0, snapped: 0, tooFar: 0, noGeom: 0, badKm: 0, ambiguous: 0 };
  for (const [shape, row] of zip(shpRecords(base + '.shp'), dbfRows(base + '.dbf'))) {
    stats.total++;
    if (!shape) { stats.noGeom++; continue; }
    const [lon, lat] = shape.parts[0][0] || [];
    const official = Number(row.KM);
    if (!inMexico(lon, lat) || !Number.isFinite(official)) { stats.badKm++; continue; }

    const x = Math.floor(lon / GRID_CELL_DEG);
    const y = Math.floor(lat / GRID_CELL_DEG);
    let best = null;
    let bestLoc = null;
    let near = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${x + dx}:${y + dy}`);
        if (!cell) continue;
        for (const ref of cell) {
          const seg = byCode.get(ref.code)[ref.i];
          const hit = projectOnPolyline(lon, lat, seg.pts);
          if (!hit) continue;
          if (hit.distKm <= SNAP_RADIUS_KM) near++;
          if (!best || hit.distKm < best.distKm) { best = hit; bestLoc = { ref, seg }; }
        }
      }
    }
    if (!best || best.distKm > SNAP_RADIUS_KM) { stats.tooFar++; continue; }
    if (near > 1) stats.ambiguous++;
    stats.snapped++;

    const loc = bestLoc.seg.loc;
    const chain = loc.chain;
    const snappedKm = loc.startKm + best.fraction * loc.lenKm;
    chain.posts.push({ km: official, lat: round(lat, COORD_DECIMALS), lon: round(lon, COORD_DECIMALS), snappedKm, dist: Math.round(best.distKm * 1000) });
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Fase 5: calibración (sentido de marcha + desplazamiento contra los postes)
// ---------------------------------------------------------------------------

function mirrorChain(chain) {
  const total = chain.total;
  chain.pts.reverse();
  for (const pt of chain.pts) pt[0] = total - pt[0];
  chain.sections.reverse();
  for (const section of chain.sections) {
    const from = section.from;
    section.from = total - section.to;
    section.to = total - from;
  }
  for (const post of chain.posts) post.snappedKm = total - post.snappedKm;
  chain.reversed = true;
}

// Runs máximos: subsecuencias contiguas (en orden de acumulado) cuyo offset
// —oficial − acumulado— se mantiene dentro de CALIB_RUN_SPREAD_KM. Cada run es
// una numeración autoconsistente: descarta postes de otras vías pegadas a
// ≤120 m y aísla tramos con numeración propia (libramientos, reinicios por
// sección — la ruta 150 reinicia en Córdoba; ambas numeraciones son reales).
// Se guardan como rangos de índices para poder fusionar runs partidos.
function maximalRuns(posts, offsetOf) {
  const runs = [];
  let start = 0;
  while (start < posts.length) {
    let min = Infinity, max = -Infinity;
    let end = start;
    for (; end < posts.length; end++) {
      const off = offsetOf(posts[end]);
      const nmin = Math.min(min, off), nmax = Math.max(max, off);
      if (!(nmax - nmin <= CALIB_RUN_SPREAD_KM)) break; // NaN corta el run
      min = nmin; max = nmax;
    }
    if (end > start) runs.push({ ranges: [[start, end]] });
    start = end > start ? end : start + 1;
  }
  return runs;
}

// Estadística de un run: anclas, spread del offset y rango de acumulado.
// Solo cuentan los miembros de los rangos: la basura intermedia que partió el
// run no se incluye.
function runStats(run, posts, offsetOf) {
  let min = Infinity, max = -Infinity, n = 0, first = -1, last = -1;
  for (const [from, to] of run.ranges) {
    for (let i = from; i < to; i++) {
      const off = offsetOf(posts[i]);
      if (off < min) min = off;
      if (off > max) max = off;
      if (first < 0) first = i;
      last = i;
      n++;
    }
  }
  return {
    n,
    spread: n ? max - min : Infinity,
    fromAcc: n ? posts[first].snappedKm : 0,
    toAcc: n ? posts[last].snappedKm : 0
  };
}

// Fusiona runs consecutivos si la numeración combinada sigue en ventana: un
// poste corrupto intermedio (offset atípico) no debe partir una numeración
// continua — p.ej. ruta 95 en Acapulco, donde un poste mal pegado dividía un
// run de 61 postes en dos.
function mergeRuns(runs, posts, offsetOf) {
  const out = [];
  for (const run of runs) {
    // Un run con menos de CALIB_MIN_ANCHORS postes jamás certifica: se ignora
    // para que un poste corrupto suelto no impida fusionar a sus vecinos.
    const members = run.ranges.reduce((sum, [f, t]) => sum + (t - f), 0);
    if (members < CALIB_MIN_ANCHORS) continue;
    const last = out[out.length - 1];
    if (last) {
      const merged = { ranges: last.ranges.concat(run.ranges) };
      if (runStats(merged, posts, offsetOf).spread <= CALIB_RUN_SPREAD_KM) {
        last.ranges = merged.ranges;
        continue;
      }
    }
    out.push({ ranges: run.ranges.map(r => r.slice()) });
  }
  return out;
}

// Calibración: la cadena puede contener VARIAS numeraciones reales en tramos
// distintos (reinicios por sección, libramientos). Se certifica cada run
// independiente como una "cal" con su propio kmStart y ventana de acumulado;
// el loader interpola en la cal cuya ventana contiene el km consultado.
// Salida: chain.cals = [{ kmStart, validFrom, validTo, anchors, residualKm }],
// siendo cals[0] la numeración primaria (la dominante). El nivel superior
// (kmStart/validFrom/validTo) refleja la primaria por compatibilidad.
function calibrate(chain) {
  chain.calibrated = false;
  chain.residualKm = null;
  chain.kmStart = null;
  chain.kmEnd = null;
  chain.validFrom = null;
  chain.validTo = null;
  chain.anchorPosts = 0;
  chain.cals = [];
  chain.dropped = [];
  chain.posts.sort((a, b) => a.snappedKm - b.snappedKm);
  chain.postsFound = chain.posts.length;
  if (chain.posts.length < 2) return;

  const forwardOff = p => p.km - p.snappedKm;
  const reversedOff = p => p.km + p.snappedKm;
  const count = runs => runs.reduce(
    (max, run) => Math.max(max, run.ranges.reduce((sum, [f, t]) => sum + (t - f), 0)), 0);

  // Sentido de marcha: gana la orientación con el run fusionado más largo.
  let runs = mergeRuns(maximalRuns(chain.posts, forwardOff), chain.posts, forwardOff);
  const runsReversed = mergeRuns(maximalRuns(chain.posts, reversedOff), chain.posts, reversedOff);
  if (count(runsReversed) > count(runs)) {
    mirrorChain(chain);
    chain.posts.sort((a, b) => a.snappedKm - b.snappedKm);
    runs = mergeRuns(maximalRuns(chain.posts, forwardOff), chain.posts, forwardOff);
  }

  // Runs certificables: anclas mínimas y tramo de acumulado suficiente.
  const minSpan = Math.min(CALIB_MIN_SPAN_KM, Math.max(1.5, chain.total * 0.9));
  const candidates = runs
    .map(run => ({ run, st: runStats(run, chain.posts, forwardOff) }))
    .filter(x => x.st.n >= CALIB_MIN_ANCHORS && x.st.toAcc - x.st.fromAcc >= minSpan)
    .sort((a, b) => b.st.n - a.st.n || a.st.spread - b.st.spread);
  if (!candidates.length) return;

  const primary = candidates[0];
  const fraction = primary.st.n / chain.posts.length;
  if (fraction < CALIB_MIN_INLIER_FRACTION && primary.st.n < CALIB_STRONG_ANCHORS) {
    // Sin numeración dominante la cadena no certifica km absolutos; sus postes
    // quedan solo como auditoría (el worker no los usa sin calibrar).
    return;
  }

  const cals = [];
  const kept = new Set();
  for (const { run, st } of candidates.slice(0, CALIB_MAX_CALS)) {
    const offsets = [];
    for (const [from, to] of run.ranges) {
      for (let i = from; i < to; i++) {
        offsets.push(chain.posts[i].km - chain.posts[i].snappedKm);
        kept.add(i);
      }
    }
    offsets.sort((a, b) => a - b);
    const kmStart = round(median(offsets), KM_DECIMALS);
    cals.push({
      kmStart,
      // Ventana certificada: dentro de los postes ancla (±0.5 km de tolerancia
      // de etiqueta) el worker interpola; fuera cae al geocodificador externo.
      validFrom: round(kmStart + st.fromAcc - 0.5, KM_DECIMALS),
      validTo: round(kmStart + st.toAcc + 0.5, KM_DECIMALS),
      anchors: st.n,
      residualKm: round(st.spread, 2)
    });
  }

  chain.calibrated = true;
  chain.cals = cals;
  chain.anchorPosts = cals.reduce((sum, cal) => sum + cal.anchors, 0);
  chain.kmStart = cals[0].kmStart;
  chain.kmEnd = round(chain.kmStart + chain.total, KM_DECIMALS);
  chain.validFrom = cals[0].validFrom;
  chain.validTo = cals[0].validTo;
  chain.residualKm = cals[0].residualKm;
  // Fuera los postes con numeración incompatible con toda cal certificada;
  // quedan en dropped por si otra cadena gemela puede rescatarlos (fase 5.5).
  chain.dropped = chain.posts.filter((_, i) => !kept.has(i));
  chain.posts = chain.posts.filter((_, i) => kept.has(i));
}

// ---------------------------------------------------------------------------
// Fase 5.5: rescate de postes caídos
// ---------------------------------------------------------------------------
// El RNC duplica alineaciones (la misma autopila aparece varias veces en
// red_vial), así que un poste puede caer en la cadena "hermana" y su numeración
// ser incoherente AHÍ, pero encajar perfectamente en la cal certificada de la
// cadena vecina (p.ej. los km 197–214 de la 150D caían en la cadena gemela y
// dejaban sin certificar el tramo Acatzingo–Córdoba). Si el km del poste
// coincide con alguna cal de una cadena cercana (±CALIB_RUN_SPREAD_KM), se
// reasigna como ancla y la ventana de esa cal se extiende hasta él.
function attachDroppedPosts(grid, byCode, allChains) {
  const byId = new Map(allChains.map(c => [c.id, c]));
  const attachTo = new Map(); // id de cadena -> postes rescatados
  for (const owner of allChains) {
    // Los descartados de cadenas calibradas y todos los de las no calibradas
    // (estos la calibración los dejó enteros pero no sirven en su propia cadena).
    const pool = owner.calibrated ? owner.dropped : owner.posts;
    for (const post of pool) {
      if (!Number.isFinite(post.km) || !Number.isFinite(post.snappedKm)) continue;
      const x = Math.floor(post.lon / GRID_CELL_DEG);
      const y = Math.floor(post.lat / GRID_CELL_DEG);
      let best = null;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get(`${x + dx}:${y + dy}`);
          if (!cell) continue;
          for (const ref of cell) {
            const seg = byCode.get(ref.code)[ref.i];
            const hit = projectOnPolyline(post.lon, post.lat, seg.pts);
            if (!hit || hit.distKm > SNAP_RADIUS_KM) continue;
            const loc = seg.loc;
            const cand = loc && loc.chain;
            if (!cand || !cand.calibrated || !cand.cals.length) continue;
            // loc quedó en el sentido original; si la cadena se reflejó en la
            // calibración, el acc válido es el espejo.
            let acc = loc.startKm + hit.fraction * loc.lenKm;
            if (cand.reversed) acc = cand.total - acc;
            for (const cal of cand.cals) {
              const diff = Math.abs(post.km - (cal.kmStart + acc));
              if (diff > CALIB_RUN_SPREAD_KM) continue;
              const better = !best || diff < best.diff ||
                (diff === best.diff && cand === owner && best.cand !== owner);
              if (better) best = { cand, cal, acc, diff };
            }
          }
        }
      }
      if (!best) continue;
      const list = attachTo.get(best.cand.id) || [];
      list.push({ post, ...best });
      attachTo.set(best.cand.id, list);
    }
  }
  let rescued = 0;
  for (const [id, items] of attachTo) {
    const chain = byId.get(id);
    for (const { post, cal, acc } of items) {
      const postFrom = round(cal.kmStart + acc - 0.5, KM_DECIMALS);
      const postTo = round(cal.kmStart + acc + 0.5, KM_DECIMALS);
      const newFrom = Math.min(cal.validFrom, postFrom);
      const newTo = Math.max(cal.validTo, postTo);
      // La extensión no puede invadir la ventana de otra cal de la misma cadena.
      const clash = chain.cals.some(s => s !== cal && newFrom <= s.validTo && newTo >= s.validFrom);
      if (clash) {
        if (!(post.km >= cal.validFrom && post.km <= cal.validTo)) continue; // ni ancla ni extensión
      } else {
        cal.validFrom = newFrom;
        cal.validTo = newTo;
      }
      cal.anchors++;
      if (cal === chain.cals[0]) {
        chain.validFrom = cal.validFrom;
        chain.validTo = cal.validTo;
      }
      chain.posts.push({ ...post, snappedKm: acc });
      chain.anchorPosts++;
      rescued++;
    }
    chain.posts.sort((a, b) => a.snappedKm - b.snappedKm);
  }
  return rescued;
}

// ---------------------------------------------------------------------------
// Fase 6: casetas (plazas de cobro)
// ---------------------------------------------------------------------------

function buildCasetas(dir) {
  const base = path.join(dir, 'plaza', 'plaza_cobro');
  const entries = new Map();
  const stats = { total: 0, kept: 0, unnamed: 0 };
  for (const [shape, row] of zip(shpRecords(base + '.shp'), dbfRows(base + '.dbf'))) {
    stats.total++;
    const name = clean(row.NOMBRE);
    const key = tollNameKey(name);
    if (!shape || !key) { stats.unnamed++; continue; }
    const [lon, lat] = shape.parts[0][0] || [];
    if (!inMexico(lon, lat)) { stats.unnamed++; continue; }
    let list = entries.get(key);
    if (!list) entries.set(key, (list = []));
    list.push({
      name,
      lat: round(lat, 6),
      lon: round(lon, 6),
      admin: clean(row.ADMINISTRA) || null,
      section: clean(row.SECCION) || null,
      modalidad: clean(row.MODALIDAD) || null
    });
    stats.kept++;
  }
  return { entries, stats };
}

// ---------------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------------

function writeGz(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(data);
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  fs.writeFileSync(file, gz);
  return { bytes: gz.length, raw: json.length };
}

function build(args) {
  const dir = args[0];
  if (!dir) {
    console.error('Uso: node tools/build-rnc.js <dir-rnc-work> [--out worker/data] [--codes 57,15]');
    return 1;
  }
  let out = 'worker/data';
  let codesFilter = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--codes') codesFilter = new Set(args[++i].split(',').map(c => c.trim()));
  }

  const started = Date.now();
  const log = (step, detail) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${step}${detail ? ' — ' + detail : ''}`);

  log('1/6 tramos', 'leyendo red_vial (shp+dbf)…');
  const { byCode, stats } = collectSegments(dir, codesFilter);
  log('1/6 tramos', `${stats.kept.toLocaleString()} codificados de ${stats.total.toLocaleString()} en ${byCode.size} códigos (sin geom: ${stats.noGeom}, coords inválidas: ${stats.badCoord}, multipart: ${stats.multipart})`);

  log('2/6 encadenamiento + geometría…');
  const allChains = [];
  let singleSeg = 0;
  for (const [code, segs] of byCode) {
    const orders = chainCode(segs);
    const chains = orders.map((steps, index) => {
      const geometry = buildGeometry(code, steps, segs);
      const chain = {
        id: `${code}:${index}`,
        code,
        order: steps,
        posts: [],
        ...geometry
      };
      for (const step of steps) segs[step.i].loc.chain = chain;
      if (steps.length === 1) singleSeg++;
      return chain;
    });
    allChains.push(...chains);
  }
  log('2/6 encadenamiento', `${allChains.length.toLocaleString()} cadenas (${singleSeg.toLocaleString()} de1 tramo)`);

  log('3/6 rejilla espacial…');
  const grid = buildGrid(byCode);
  log('3/6 rejilla', `${grid.size.toLocaleString()} celdas`);

  log('4/6 postes', 'pegando a ≤120 m…');
  const postStats = snapPosts(dir, grid, byCode);
  log('4/6 postes', `${postStats.snapped} pegados de ${postStats.total} (lejos: ${postStats.tooFar}, sin km: ${postStats.badKm}, ambiguos: ${postStats.ambiguous})`);

  log('5/6 calibración…');
  let calibrated = 0, calibratedKm = 0, totalKm = 0, withPosts = 0, residualSum = 0;
  let anchorPosts = 0, junkPosts = 0;
  for (const chain of allChains) {
    const found = chain.posts.length;
    calibrate(chain);
    totalKm += chain.total;
    if (found) withPosts++;
    anchorPosts += chain.anchorPosts;
    junkPosts += found - chain.posts.length;
    if (chain.calibrated) {
      calibrated++;
      calibratedKm += chain.total;
      residualSum += chain.residualKm;
    }
  }
  log('5/6 calibración', `${calibrated} cadenas calibradas (${((calibratedKm / totalKm) * 100).toFixed(1)}% de ${(totalKm / 1000).toFixed(0)} mil km), ${withPosts} con postes, ${anchorPosts} como ancla y ${junkPosts} descartados por numeración incompatible, residuo medio ${(residualSum / Math.max(calibrated, 1)).toFixed(2)} km`);

  const rescued = attachDroppedPosts(grid, byCode, allChains);
  log('5/6 rescate', `${rescued} postes caídos reasignados a la cadena con cal compatible`);

  log('6/6 casetas…');
  const { entries, stats: casetaStats } = buildCasetas(dir);
  log('6/6 casetas', `${casetaStats.kept} plazas de ${casetaStats.total}`);

  // --- escribir ---
  const index = {
    source: 'Red Nacional de Caminos 2025 (IMT/INEGI) — https://rnc.imt.mx',
    generated: new Date().toISOString(),
    snap_radius_m: SNAP_RADIUS_KM * 1000,
    codes: {}
  };
  let written = 0;
  const byCodeChains = new Map();
  for (const chain of allChains) {
    let list = byCodeChains.get(chain.code);
    if (!list) byCodeChains.set(chain.code, (list = []));
    list.push(chain);
  }
  for (const [code, chains] of byCodeChains) {
    index.codes[code] = chains.map(chain => ({
      id: chain.id,
      kmStart: chain.kmStart,
      kmEnd: chain.kmEnd,
      // Ventana de km certificada por los postes ancla (interpolar solo aquí).
      validFrom: chain.validFrom,
      validTo: chain.validTo,
      calibrated: chain.calibrated,
      reversed: !!chain.reversed,
      residualKm: chain.residualKm,
      // Numeraciones certificadas de la cadena (una por run de postes válido).
      cals: chain.cals || [],
      posts: chain.postsFound ?? chain.posts.length,
      anchorPosts: chain.anchorPosts,
      peaje: chain.peaje,
      segs: chain.order.length,
      total: round(chain.total, KM_DECIMALS),
      bbox: chain.bbox.map(v => round(v, COORD_DECIMALS)),
      sections: chain.sections.map(s => ({ name: s.name, from: round(s.from, KM_DECIMALS), to: round(s.to, KM_DECIMALS) }))
    }));
    const kmFile = {
      code,
      chains: chains.map(chain => ({
        id: chain.id,
        pts: chain.pts.map(([km, lat, lon]) => [round(km, KM_DECIMALS), round(lat, COORD_DECIMALS), round(lon, COORD_DECIMALS)]),
        // Ordenados por km: un espejo al calibrar los invierte. `acc` es el
        // acumulado en la polilínea (para auditoría y diagnóstico de números).
        posts: [...chain.posts].sort((a, b) => a.snappedKm - b.snappedKm)
          .map(p => ({ km: p.km, lat: p.lat, lon: p.lon, acc: round(p.snappedKm, KM_DECIMALS), dist: p.dist }))
      }))
    };
    const size = writeGz(path.join(out, 'km', `${code}.json.gz`), kmFile);
    written++;
    if (written === 1 || written % 200 === 0) {
      log('escritura', `${written} archivos km (${(size.bytes / 1024).toFixed(0)} KB el último)`);
    }
  }
  const indexSize = writeGz(path.join(out, 'red-vial-index.json.gz'), index);
  const casetaSize = writeGz(path.join(out, 'casetas.json.gz'), {
    source: index.source,
    generated: index.generated,
    entries: Object.fromEntries(entries)
  });

  log('listo', `índice ${(indexSize.bytes / 1024).toFixed(0)} KB (raw ${(indexSize.raw / 1024).toFixed(0)} KB), casetas ${(casetaSize.bytes / 1024).toFixed(0)} KB, ${written} archivos km en ${path.join(out, 'km')}`);
  return 0;
}

// Ejecutable como script; como módulo exporta las piezas puras para las pruebas.
if (require.main === module) {
  process.exit(build(process.argv.slice(2)));
}

module.exports = {
  maximalRuns,
  runStats,
  mergeRuns,
  calibrate,
  attachDroppedPosts,
  mirrorChain,
  chainCode,
  buildGeometry,
  projectOnPolyline,
  buildCasetas
};
