'use strict';

// Construye un mapa de ID_RED de tramos de cuota corroborados por plazas de
// cobro (3 compuertas: snap ≤ 120 m, código único, sin conflicto con SECCION).
const { DatabaseSync } = require('node:sqlite');
const { geometry, closestOnLine, pyRound, EARTH_M_PER_DEG } = require('./rnc-national-review');
const fs = require('node:fs');

const NORM = v => String(v || '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const NUMERIC = /^\d+$/;

function pointOf(blob) {
  const b = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const envelope = [0, 32, 48, 48, 64, 0, 0, 0][(b[3] >> 1) & 7];
  const pos = 8 + envelope;
  const little = b[pos] === 1;
  const f = at => (little ? b.readDoubleLE(at) : b.readDoubleBE(at));
  return [f(pos + 5), f(pos + 13)];
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('Usage: node tools/build-toll-plaza-verification.js rnc2025.gpkg out.json');
    return 1;
  }
  const [gpkg, out] = argv;
  const db = new DatabaseSync(gpkg, { readOnly: true });
  const roadQ = db.prepare(`select r.ID_RED,r.CODIGO,r.NOMBRE,r.geom
    from red_vial r join rtree_red_vial_geom t on r.fid=t.id
    where t.minx<=? and t.maxx>=? and t.miny<=? and t.maxy>=? and r.PEAJE='Si'`);
  roadQ.setReturnArrays(true);
  function nearbyToll(lon, lat, r) {
    const dLat = r / EARTH_M_PER_DEG;
    const dLon = dLat / Math.max(.2, Math.cos(lat * Math.PI / 180));
    const found = [];
    for (const row of roadQ.all(lon + dLon, lon - dLon, lat + dLat, lat - dLat)) {
      const [d] = closestOnLine(lon, lat, geometry(row[3]));
      if (d <= r) found.push({ idRed: row[0], code: row[1], name: row[2], dist: d });
    }
    return found.sort((a, b) => a.dist - b.dist);
  }
  const nameCode = new Map();
  for (const row of db.prepare("select CODIGO,NOMBRE from red_vial where PEAJE='Si'").all()) {
    const k = NORM(row.NOMBRE);
    if (!k) continue;
    if (!nameCode.has(k)) nameCode.set(k, new Set());
    nameCode.get(k).add(row.CODIGO);
  }
  const plazas = db.prepare('select ID_PLAZA,NOMBRE,SECCION,ADMINISTRA,geom from plaza_cobro').all();
  const verified = new Map();
  for (const p of plazas) {
    const [lon, lat] = pointOf(p.geom);
    const near = nearbyToll(lon, lat, 120);
    if (!near.length) continue;
    const codes = new Set(near.map(n => n.code));
    if (codes.size !== 1) continue;
    const code = near[0].code;
    if (!NUMERIC.test(code) || +code < 1 || +code > 999) continue;
    const declared = nameCode.get(NORM(p.SECCION));
    if (declared && declared.size === 1 && [...declared][0] !== code) continue;
    for (const n of near) {
      if (n.code !== code) continue;
      if (!verified.has(n.idRed)) {
        verified.set(n.idRed, {
          idRed: n.idRed, code: n.code, names: new Set(), sections: new Set(),
          plazaIds: new Set(), anchors: new Map()
        });
      }
      const e = verified.get(n.idRed);
      e.plazaIds.add(p.ID_PLAZA);
      if (p.SECCION) e.sections.add(p.SECCION);
      if (n.name && !/^N\/?[AD]$/i.test(n.name.trim())) e.names.add(n.name);
      // El par plaza↔seccion se conserva: sin el, un desacuerdo de nombre no
      // dice que plaza revisar.
      e.anchors.set(p.ID_PLAZA, { plazaId: p.ID_PLAZA, section: p.SECCION, admin: p.ADMINISTRA, snapM: pyRound(n.dist) });
    }
  }
  const list = [...verified.values()].map(e => ({
    idRed: e.idRed, code: e.code,
    names: [...e.names].sort((a, b) => a.localeCompare(b)),
    sections: [...e.sections].sort((a, b) => a.localeCompare(b)),
    plazaIds: [...e.plazaIds].sort((a, b) => a - b),
    anchors: [...e.anchors.values()].sort((a, b) => a.plazaId - b.plazaId)
  }));
  list.sort((a, b) => a.idRed - b.idRed || a.code - b.code);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'plaza_cobro',
    gates: { snapM: 120, uniqueCode: true, codeRange: [1, 999], rejectNameConflict: true },
    totalRoadIds: list.length,
    totalPlazaIds: new Set(list.flatMap(e => e.plazaIds)).size,
    entries: list
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
  console.log(JSON.stringify({ totalRoadIds: payload.totalRoadIds, totalPlazaIds: payload.totalPlazaIds }));
  db.close();
  return 0;
}

module.exports = { main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
