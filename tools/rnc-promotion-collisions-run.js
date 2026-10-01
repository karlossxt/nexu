'use strict';

// Paso 1 de la promocion, sobre datos reales: genera el reporte de colisiones y
// el conteo del escalon limpio. Reporte de solo lectura, no escribe el indice
// de produccion. Ese es el paso 2 y va aparte.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { evaluate, summarize, normalize } = require('./rnc-chain-invariant');
const { buildExclusions, validateExclusions } = require('./rnc-promotion-collisions');

// Las anclas manuales no traen codigo de ruta ni nombre de corredor: el
// llamador declara a que familia pertenece cada archivo, porque el codigo vive
// en la etiqueta ("... 150D") y el nombre en el alias.
const MANUAL_FAMILIES = [
  { file: 'rnc-150d-reviewed.json', code: '150', name: 'Acatzingo - Ciudad Mendoza', kmRange: [197, 230] },
  { file: 'rnc-20260928-reviewed.json', code: '95', name: 'Cuernavaca - Acapulco', kmRange: [142, 250] },
  { file: 'rnc-20260930-reviewed.json', code: '180', name: 'Nuevo Teapa - Cosoleacaque', kmRange: [7, 7] },
];

// El estado sale de localidad.CVEGEO (2 digitos = entidad, INEGI). Verificado
// contra las 37 anclas que la app ya acepta a mano: 37/37 coinciden, a 0-3 m.
const ENTIDAD = {
  '01':'Aguascalientes','02':'Baja California','03':'Baja California Sur','04':'Campeche','05':'Coahuila',
  '06':'Colima','07':'Chiapas','08':'Chihuahua','09':'Ciudad de México','10':'Durango','11':'Guanajuato',
  '12':'Guerrero','13':'Hidalgo','14':'Jalisco','15':'México','16':'Michoacán','17':'Morelos','18':'Nayarit',
  '19':'Nuevo León','20':'Oaxaca','21':'Puebla','22':'Querétaro','23':'Quintana Roo','24':'San Luis Potosí',
  '25':'Sinaloa','26':'Sonora','27':'Tabasco','28':'Tamaulipas','29':'Tlaxcala','30':'Veracruz','31':'Yucatán','32':'Zacatecas',
};

function loadManualAnchors(repo) {
  const out = [];
  for (const fam of MANUAL_FAMILIES) {
    const arr = require(path.join(repo, 'worker', fam.file));
    for (const a of arr) {
      if (a.km < fam.kmRange[0] || a.km > fam.kmRange[1]) continue;
      out.push({ ...a, code: fam.code, normalizedName: normalize(fam.name), family: fam.file });
    }
  }
  return out;
}

function stateFromLocalidad(db, lat, lon, radiusKm = 40) {
  const dLat = radiusKm / 111.32, dLon = dLat / Math.max(.2, Math.cos(lat * Math.PI / 180));
  // La caja del rtree espera (max, min). Pasar el orden natural invierte el
  // rango y devuelve cero filas en silencio.
  const rows = db.prepare(`select l.CVEGEO as cvegeo, b.minx,b.maxx,b.miny,b.maxy
    from rtree_localidad_geom as b join localidad as l on l.fid=b.id
    where b.minx<=? and b.maxx>=? and b.miny<=? and b.maxy>=?`).all(lon + dLon, lon - dLon, lat + dLat, lat - dLat);
  let best = null, bestD = Infinity;
  for (const r of rows) {
    const cx = (r.minx + r.maxx) / 2, cy = (r.miny + r.maxy) / 2;
    const d = Math.hypot((cx - lon) * Math.cos(lat * Math.PI / 180), cy - lat) * 111.32;
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best) return { state: null, distanceM: null };
  return { state: ENTIDAD[String(best.cvegeo).slice(0, 2)] ?? null, distanceM: Math.round(bestD) };
}

function run(gpkg, reviewFile, outFile, repo) {
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const db = new DatabaseSync(gpkg);

  const ids = new Set();
  for (const c of review.chains) for (const p of c.posts) ids.add(p.roadId);
  const want = new Set([...ids].map(Number));
  const roads = new Map();
  for (const r of db.prepare('select ID_RED,PEAJE,ADMINISTRA,NIVEL from red_vial').iterate()) {
    if (want.has(Number(r.ID_RED))) roads.set(Number(r.ID_RED), { toll: r.PEAJE === 'Si', admin: String(r.ADMINISTRA ?? '').trim(), nivel: r.NIVEL });
  }

  const result = evaluate(review, roads);
  const manual = loadManualAnchors(repo);

  // Escalon recomendado: cadenas sin ninguna marca, ni dura ni informativa.
  const clean = [];
  review.chains.forEach((c, i) => {
    if (result.chainReports[i].flags.length === 0) {
      clean.push({ ...c, normalizedName: normalize(c.name) });
    }
  });

  const { exclusions, kept } = buildExclusions(clean, manual);
  const checked = validateExclusions(exclusions, manual);

  // Estado de cada poste promovido, y a que distancia quedo de una localidad.
  const withState = kept.map(p => ({ ...p, ...stateFromLocalidad(db, p.lat, p.lon) }));
  const noState = withState.filter(p => !p.state);
  const far = withState.filter(p => p.state && p.distanceM > 25000);

  // Densidad por corredor: quantos km enteros del rango tienen poste.
  const byCorridor = new Map();
  for (const p of withState) {
    const k = `${p.code}|${p.name}`;
    if (!byCorridor.has(k)) byCorridor.set(k, { code: p.code, name: p.name, kms: [] });
    byCorridor.get(k).kms.push(p.km);
  }
  let span = 0, have = 0;
  for (const g of byCorridor.values()) { span += Math.max(...g.kms) - Math.min(...g.kms) + 1; have += new Set(g.kms).size; }

  db.close();

  const report = {
    status: 'review_only',
    runtime_use: 'none',
    step: '1_colisiones',
    summary: summarize(result),
    escalon: {
      chains: clean.length,
      corridors: new Set(clean.map(c => `${c.code}|${c.name}`)).size,
      postsBeforeExclusions: clean.reduce((s, c) => s + c.posts.length, 0),
      postsPromotable: kept.length,
      collisions: checked.length,
    },
    collisions: checked,
    stateCoverage: {
      withState: withState.filter(p => p.state).length,
      withoutState: noState.length,
      fartherThan25km: far.length,
      maxDistanceM: Math.max(0, ...withState.map(p => p.distanceM ?? 0)),
    },
    density: { kmInRange: span, kmWithPost: have, ratio: `${(100 * have / span).toFixed(1)}%` },
    note: 'Este reporte NO escribe el indice de produccion. Ese es el paso 2 y cambia runtime.',
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
  return report;
}

if (require.main === module) {
  const [gpkg, reviewFile, outFile, repo] = process.argv.slice(2);
  if (!gpkg || !reviewFile || !outFile || !repo) {
    console.error('uso: node tools/rnc-promotion-collisions-run.js <gpkg> <review.json> <out.json> <repo>');
    process.exit(1);
  }
  const r = run(gpkg, reviewFile, outFile, repo);
  console.log(JSON.stringify({ escalon: r.escalon, stateCoverage: r.stateCoverage, density: r.density }, null, 1));
}

module.exports = { run, loadManualAnchors, stateFromLocalidad, MANUAL_FAMILIES, ENTIDAD };