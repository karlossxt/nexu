'use strict';

// Port a Node de tools/rnc-toll-plazas.py. Catálogo conservador de plazas de
// cobro nombradas a partir de plaza_cobro del RNC 2025.
// Uso: node tools/rnc-toll-plazas.js rnc2025.gpkg worker/rnc-toll-plazas.json
// Los grupos de carriles separados más de 250 m se excluyen para revisión manual.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');

// pyRound: el round() de Python redondea a pares cuando el dígito es 5 exacto
// (251 -> 250) y Math.round sube. El valor es informativo, pero mezclarlos
// produciría un diff espurio contra el catálogo ya revisado.
const { pyRound, EARTH_M_PER_DEG } = require('./rnc-national-review');

const UNNAMED_NAME = new Set(['n/d', 'n/a', 'sin nombre']);
const UNNAMED_SECTION = new Set(['n/d', 'n/a']);

// Orden de Python: NFD, se quitan los diacríticos, luego minúsculas.
function normalized(value) {
  const plain = String(value || '').normalize('NFD').replace(/\p{Mn}/gu, '');
  return plain.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Decodificación GeoPackage estándar: cabecera GP, indicador de envolvente,
// byte mágico de endianness y tipo de geometría (codificado sobre 1000).
function point(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.toString('latin1', 0, 2) !== 'GP') throw new Error('Expected GeoPackage point');
  const envelope = [0, 32, 48, 48, 64, 0, 0, 0][(buffer[3] >> 1) & 7];
  const pos = 8 + envelope;
  const little = buffer[pos] === 1;
  const kind = little ? buffer.readUInt32LE(pos + 1) : buffer.readUInt32BE(pos + 1);
  if (kind % 1000 !== 1) throw new Error('Expected Point geometry');
  return [
    little ? buffer.readDoubleLE(pos + 5) : buffer.readDoubleBE(pos + 5),
    little ? buffer.readDoubleLE(pos + 13) : buffer.readDoubleBE(pos + 13)
  ];
}

function catalog(rows, maxSpreadM = 250) {
  const grouped = new Map();
  const rejected = new Map();
  const bump = (key, by) => rejected.set(key, (rejected.get(key) || 0) + by);

  for (const row of rows) {
    const [ident, name, section, geom] = row;
    const a = normalized(name), b = normalized(section);
    if (!a || !b || UNNAMED_NAME.has(a) || UNNAMED_SECTION.has(b)) {
      bump('unnamed_or_no_section', 1);
      continue;
    }
    const [lon, lat] = point(geom);
    // Clave por par, no concatenada: "A"+"BC" y "AB"+"C" deben quedar en
    // grupos distintos.
    const key = JSON.stringify([a, b]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ident, name: String(name).trim(), section: String(section).trim(), lon, lat });
  }

  const selected = [];
  for (const entries of grouped.values()) {
    const lon = entries.reduce((sum, e) => sum + e.lon, 0) / entries.length;
    const lat = entries.reduce((sum, e) => sum + e.lat, 0) / entries.length;
    // Se escala la longitud a la latitud media del grupo; sin esto un corredor
    // este-oeste parecería más disperso que uno norte-sur del mismo ancho real.
    const perLon = EARTH_M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    let spread = 0;
    for (const e of entries) {
      spread = Math.max(spread, Math.hypot((e.lon - lon) * perLon, (e.lat - lat) * EARTH_M_PER_DEG));
    }
    if (spread > maxSpreadM) {
      // La clave nombra el umbral por defecto aunque maxSpreadM cambie; se
      // conserva para no invalidar a quien lea el resumen.
      bump('spread_over_250m', entries.length);
      continue;
    }
    selected.push({
      name: entries[0].name,
      section: entries[0].section,
      lat: pyRound(lat, 8),
      lon: pyRound(lon, 8),
      // Orden numérico: el sort() por defecto de JS ordenaría [10, 2, 9].
      sourceIds: entries.map(e => e.ident).sort((a, b) => a - b),
      spreadM: pyRound(spread)
    });
  }

  // Python ordena por la tupla (nombre, sección): primero nombre, luego sección.
  selected.sort((a, b) =>
    compare(normalized(a.name), normalized(b.name)) || compare(normalized(a.section), normalized(b.section)));
  return { selected, rejected: Object.fromEntries(rejected) };
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('Usage: node tools/rnc-toll-plazas.js rnc2025.gpkg worker/rnc-toll-plazas.json');
    return 1;
  }
  const [source, target] = argv;
  const db = new DatabaseSync(source, { readOnly: true });
  const query = db.prepare('select ID_PLAZA,NOMBRE,SECCION,geom from plaza_cobro');
  // Por defecto node:sqlite devuelve objetos con nombre de columna; catalog()
  // consume filas posicionales, igual que las tuplas de la versión Python.
  query.setReturnArrays(true);
  const rows = query.all();
  db.close();
  const { selected, rejected } = catalog(rows);
  fs.writeFileSync(target, JSON.stringify(selected, null, 2) + '\n');
  console.log(JSON.stringify({ namedPlazas: selected.length, excluded: rejected }));
  return 0;
}

module.exports = { normalized, point, catalog };

if (require.main === module) process.exit(main(process.argv.slice(2)));
