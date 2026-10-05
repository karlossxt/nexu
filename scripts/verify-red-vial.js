#!/usr/bin/env node
'use strict';
/**
 * Verifica el cadenamiento (km) de los corredores de red-vial.js contra ANCLAS REALES
 * (puntos con kilómetro conocido: casetas, postes RNC, entronques) y genera una versión
 * corregida con interpolación por tramos.
 *
 * Uso:
 *   node scripts/verify-red-vial.js --red-vial ./red-vial.js --anchors ./anchors.json
 *   node scripts/verify-red-vial.js --red-vial ./worker/red-vial.js --anchors ./anchors.json --emit ./worker/red-vial.verified.js
 *   node scripts/verify-red-vial.js --red-vial ./red-vial.js            (solo diagnóstico geométrico)
 *
 * anchors.json = [{ "corridor":"mex-qro", "km":44, "lat":19.7, "lon":-99.2, "label":"Caseta X", "source":"SCT" }, ...]
 *   - "corridor" es el badge. Si falta, se intenta con "road" (nombre/alias) y, si no, por cercanía al trazo.
 *
 * Un corredor se marca chainageVerified:true SOLO si, con sus anclas:
 *   - tiene >= --min-anchors (3) anclas útiles,
 *   - la pendiente km/distancia está en 1 ± --slope-tol (0.05): el trazo realmente recorre esa carretera,
 *   - el error "leave-one-out" máximo es <= --max-resid km (1.0),
 *   - los km son monótonos a lo largo del trazo.
 * Nunca inventa datos: sin anclas, el corredor queda sin verificar.
 */
const fs = require('fs');
const path = require('path');

// ---------- argumentos ----------
function parseArgs(argv) {
  const o = { 'red-vial': './red-vial.js', 'min-anchors': 3, 'slope-tol': 0.05, 'max-resid': 1.0, 'max-offroad': 1.5, 'report': 'red-vial.report.json' };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true; else { o[k] = isNaN(Number(next)) ? next : Number(next); i++; }
  }
  return o;
}

// ---------- geometría ----------
const R = 6371, RAD = Math.PI / 180;
function hav(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD, dLon = (bLon - aLon) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return cum;
}
// Proyecta un punto sobre la polilínea (aprox. plana local). Devuelve distancia al trazo y recorrido d (km).
function project(pts, cum, lat, lon) {
  let best = { offroad: Infinity, d: 0 };
  const kx = Math.cos(lat * RAD) * 111.32, ky = 110.574;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = (pts[i][1] - lon) * kx, ay = (pts[i][0] - lat) * ky;
    const bx = (pts[i + 1][1] - lon) * kx, by = (pts[i + 1][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    const off = Math.hypot(px, py);
    if (off < best.offroad) best = { offroad: off, d: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return best;
}

// ---------- carga / emisión ----------
function loadRedVial(file) {
  const src = fs.readFileSync(file, 'utf8');
  const fn = new Function('window', 'module', 'exports',
    src + '\n;return (typeof RED_VIAL!=="undefined") ? RED_VIAL : (Array.isArray(module.exports) ? module.exports : window.RED_VIAL);');
  const mod = { exports: {} };
  const data = fn({}, mod, mod.exports);
  if (!Array.isArray(data)) throw new Error('No pude leer RED_VIAL de ' + file);
  return { data, format: /module\.exports\s*=/.test(src) ? 'cjs' : 'window' };
}
function emit(file, data, format) {
  const header = '// RED VIAL verificada: generada por scripts/verify-red-vial.js (no editar a mano).\n' +
    '// chainageVerified:true solo donde hay anclas reales y el ajuste pasó los umbrales.\n';
  const body = JSON.stringify(data);
  const code = format === 'cjs'
    ? `${header}const RED_VIAL = ${body};\nmodule.exports = RED_VIAL;\n`
    : `${header}const RED_VIAL = ${body};\nwindow.RED_VIAL = RED_VIAL;\n`;
  fs.writeFileSync(file, code);
}

// ---------- normalización / asignación ----------
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function assignAnchors(corridors, anchors, maxOffroad) {
  const byBadge = new Map(corridors.map(c => [c.badge, []]));
  const unassigned = [];
  for (const a of anchors) {
    let target = null;
    if (a.corridor && byBadge.has(a.corridor)) target = a.corridor;
    if (!target && a.road) {
      const r = norm(a.road);
      for (const c of corridors) {
        if ([c.name, ...(c.aliases || [])].some(n => { const k = norm(n); return k.length >= 4 && (r === k || r.includes(k)); })) { target = c.badge; break; }
      }
    }
    if (!target && Number.isFinite(a.lat) && Number.isFinite(a.lon)) {
      let bestOff = maxOffroad;
      for (const c of corridors) {
        const off = project(c.pts, c._cum, a.lat, a.lon).offroad;
        if (off < bestOff) { bestOff = off; target = c.badge; }
      }
    }
    if (target) byBadge.get(target).push(a); else unassigned.push(a);
  }
  return { byBadge, unassigned };
}

// ---------- ajuste lineal km = a + b*d ----------
function fit(points) {
  const n = points.length;
  const md = points.reduce((s, p) => s + p.d, 0) / n, mk = points.reduce((s, p) => s + p.km, 0) / n;
  let sdd = 0, sdk = 0;
  for (const p of points) { sdd += (p.d - md) ** 2; sdk += (p.d - md) * (p.km - mk); }
  const b = sdd > 0 ? sdk / sdd : 0;
  return { a: mk - b * md, b };
}

function analyze(c, anchors, opt) {
  const length = c._cum[c._cum.length - 1];
  const out = { badge: c.badge, name: c.name, length_km: +length.toFixed(1), anchors_total: anchors.length, dropped: [], reasons: [], verified: false };
  if (!anchors.length) { out.status = 'sin_anclas'; out.reasons.push('no hay anclas para este corredor'); return { out }; }

  let pts = [];
  for (const a of anchors) {
    if (!Number.isFinite(a.km) || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) { out.dropped.push({ label: a.label, km: a.km, reason: 'datos incompletos' }); continue; }
    const pr = project(c.pts, c._cum, a.lat, a.lon);
    if (pr.offroad > opt['max-offroad']) { out.dropped.push({ label: a.label, km: a.km, reason: `a ${pr.offroad.toFixed(1)} km del trazo` }); continue; }
    pts.push({ label: a.label || '', km: a.km, d: pr.d, offroad: pr.offroad });
  }
  // un mismo km repetido: se promedia
  pts.sort((p, q) => p.km - q.km);
  pts = pts.reduce((acc, p) => {
    const prev = acc[acc.length - 1];
    if (prev && Math.abs(prev.km - p.km) < 0.01) { prev.d = (prev.d + p.d) / 2; return acc; }
    acc.push({ ...p }); return acc;
  }, []);

  let reversed = false;
  if (pts.length >= 2 && fit(pts).b < 0) { reversed = true; pts.forEach(p => { p.d = length - p.d; }); }

  // Valores atípicos (ancla mal ubicada o km equivocado): se descartan hasta 3, de uno en uno.
  for (let k = 0; k < 3 && pts.length >= 4; k++) {
    const { a, b } = fit(pts);
    let worst = null;
    for (const p of pts) { const r = Math.abs(p.km - (a + b * p.d)); if (!worst || r > worst.r) worst = { p, r }; }
    if (worst.r > opt['max-resid'] * 2) {
      out.dropped.push({ label: worst.p.label, km: worst.p.km, reason: `atípica: desvío de ${worst.r.toFixed(1)} km respecto al ajuste` });
      pts = pts.filter(p => p !== worst.p);
    } else break;
  }

  // Monotonía de d con km creciente (tolerancia 50 m)
  let violations = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].d < pts[i - 1].d - 0.05) violations++;

  out.anchors_used = pts.length;
  out.reversed = reversed;
  if (pts.length < 2) { out.status = 'insuficiente'; out.reasons.push(`solo ${pts.length} ancla(s) útil(es)`); return { out }; }

  const { b } = fit(pts);
  out.slope = +b.toFixed(3);
  const dFirst = pts[0].d, dLast = pts[pts.length - 1].d;
  out.coverage = +((dLast - dFirst) / length).toFixed(2);
  out.km_range = [pts[0].km, pts[pts.length - 1].km];
  out.max_gap_km = +Math.max(...pts.slice(1).map((p, i) => p.km - pts[i].km)).toFixed(1);

  // leave-one-out: ¿se puede predecir el km de un poste interior con sus vecinos?
  const errs = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = pts[i - 1], r = pts[i + 1];
    const pred = r.d > l.d ? l.km + (pts[i].d - l.d) / (r.d - l.d) * (r.km - l.km) : l.km;
    errs.push(Math.abs(pred - pts[i].km));
  }
  out.loo_max_km = errs.length ? +Math.max(...errs).toFixed(2) : null;
  out.loo_rms_km = errs.length ? +Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length).toFixed(2) : null;

  if (pts.length < opt['min-anchors']) out.reasons.push(`mínimo ${opt['min-anchors']} anclas útiles (hay ${pts.length})`);
  if (Math.abs(b - 1) > opt['slope-tol']) out.reasons.push(`pendiente ${b.toFixed(2)} ≠ 1: el trazo no recorre la misma distancia que indican los km (revisa la geometría o las anclas)`);
  if (out.loo_max_km != null && out.loo_max_km > opt['max-resid']) out.reasons.push(`error leave-one-out ${out.loo_max_km} km > ${opt['max-resid']} km`);
  if (violations) out.reasons.push(`${violations} inversión(es) de orden entre km y posición`);
  out.verified = out.reasons.length === 0;
  out.status = out.verified ? 'verificado' : 'rechazado';
  if (out.verified && out.coverage < 0.5) out.warnings = [`las anclas cubren solo ${Math.round(out.coverage * 100)}% del trazo; fuera de ese rango no se resolverán km`];

  return { out, pts, reversed };
}

// ---------- principal ----------
function main() {
  const opt = parseArgs(process.argv.slice(2));
  const { data, format } = loadRedVial(opt['red-vial']);
  data.forEach(c => { c._cum = cumulative(c.pts); });
  const anchors = opt.anchors ? JSON.parse(fs.readFileSync(opt.anchors, 'utf8')) : [];
  const { byBadge, unassigned } = assignAnchors(data, anchors, opt['max-offroad']);

  const report = [], emitted = [];
  for (const c of data) {
    const { out, pts, reversed } = analyze(c, byBadge.get(c.badge) || [], opt);
    // diagnóstico geométrico que no depende de anclas
    const span = c.kmEnd - c.kmStart;
    out.geometry_ratio = +(out.length_km / span).toFixed(3);
    report.push(out);

    const clean = { ...c }; delete clean._cum;
    if (out.verified) {
      if (reversed) clean.pts = [...c.pts].reverse();
      clean.kmStart = pts[0].km; clean.kmEnd = pts[pts.length - 1].km;
      clean.anchors = pts.map(p => ({ km: p.km, d: +p.d.toFixed(3) }));
      clean.chainageVerified = true;
      clean.verification = { anchors: pts.length, slope: out.slope, loo_max_km: out.loo_max_km, coverage: out.coverage, max_gap_km: out.max_gap_km };
    } else {
      clean.chainageVerified = false;
    }
    emitted.push(clean);
  }

  // ---- consola ----
  const pad = (s, n) => String(s).padEnd(n), rpad = (s, n) => String(s).padStart(n);
  console.log(`\nRED VIAL: ${data.length} corredores · ${anchors.length} anclas${unassigned.length ? ` (${unassigned.length} sin corredor)` : ''}\n`);
  console.log(pad('corredor', 12), rpad('trazo km', 9), rpad('rango km', 9), rpad('ratio', 6), rpad('anclas', 7), rpad('pend.', 6), rpad('LOO km', 7), rpad('cobert.', 8), ' estado');
  for (const r of report) {
    const c = data.find(x => x.badge === r.badge);
    const flag = Math.abs(r.geometry_ratio - 1) > 0.05 ? '!' : ' ';
    console.log(pad(r.badge, 12), rpad(r.length_km, 9), rpad(c.kmEnd - c.kmStart, 9), rpad(r.geometry_ratio + flag, 6), rpad(`${r.anchors_used ?? 0}/${r.anchors_total}`, 7),
      rpad(r.slope ?? '-', 6), rpad(r.loo_max_km ?? '-', 7), rpad(r.coverage != null ? Math.round(r.coverage * 100) + '%' : '-', 8), ' ' + r.status);
    (r.reasons || []).filter(x => r.status !== 'sin_anclas').forEach(x => console.log('             · ' + x));
    (r.dropped || []).forEach(d => console.log(`             ✗ ancla "${d.label || '?'}" km ${d.km}: ${d.reason}`));
    (r.warnings || []).forEach(x => console.log('             ⚠ ' + x));
    if (r.reversed && r.verified) console.log('             ↺ el km decrecía a lo largo del trazo: se invirtió el orden de pts en el archivo generado');
  }
  const ok = report.filter(r => r.verified).length;
  console.log(`\nVerificados: ${ok}/${data.length} · sin anclas: ${report.filter(r => r.status === 'sin_anclas').length} · rechazados: ${report.filter(r => r.status === 'rechazado' || r.status === 'insuficiente').length}`);
  console.log('ratio = longitud del trazo / (kmEnd-kmStart); "!" marca diferencias >5%.\n');
  if (unassigned.length) console.log('Anclas sin corredor:', unassigned.map(a => `${a.label || '?'} (km ${a.km})`).join(', '), '\n');

  fs.writeFileSync(opt.report, JSON.stringify({ generated_at: new Date().toISOString(), thresholds: { min_anchors: opt['min-anchors'], slope_tol: opt['slope-tol'], max_resid_km: opt['max-resid'], max_offroad_km: opt['max-offroad'] }, corridors: report, unassigned }, null, 2));
  console.log('Reporte:', opt.report);
  if (anchors.length || opt.emit) {
    const target = typeof opt.emit === 'string' ? opt.emit : opt['red-vial'].replace(/\.js$/, '.verified.js');
    emit(target, emitted, opt.format || format);
    console.log('Archivo generado:', target, `(formato ${opt.format || format})`);
  }
}

if (require.main === module) main();
module.exports = { cumulative, project, fit, analyze, hav };
