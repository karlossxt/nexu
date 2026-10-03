'use strict';

// Port a Node de tools/rnc-gpkg-extract.py. Extrae solo la región piloto
// 54D/150D del GeoPackage oficial RNC 2025.
// Uso: node tools/rnc-gpkg-extract.js rnc2025.gpkg /ruta/salida

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// minLon, minLat, maxLon, maxLat. Acota a Jalisco/Colima y Puebla/Veracruz.
const BOXES = {
  '54D': [-104.6, 18.8, -102.5, 21.0],
  '150D': [-98.6, 18.1, -96.3, 19.5]
};

// A diferencia de rnc-national-review.js, aquí la salida es GeoJSON porque la
// consume rnc-km-pilot.mjs, no el revisor nacional.
function geometry(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (!buffer.length || buffer.toString('latin1', 0, 2) !== 'GP') {
    throw new Error('Expected GeoPackage geometry');
  }
  const envelope = [0, 32, 48, 48, 64, 0, 0, 0][(buffer[3] >> 1) & 7];
  let pos = 8 + envelope;
  const little = buffer[pos] === 1;
  const u32 = at => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const f64 = at => (little ? buffer.readDoubleLE(at) : buffer.readDoubleBE(at));

  const kind = u32(pos + 1) % 1000;
  pos += 5;
  if (kind === 1) return { type: 'Point', coordinates: [f64(pos), f64(pos + 8)] };
  if (kind !== 2) throw new Error(`Unexpected geometry type: ${kind}`);
  const count = u32(pos);
  pos += 4;
  const coordinates = [];
  for (let i = 0; i < count; i++) coordinates.push([f64(pos + 16 * i), f64(pos + 16 * i + 8)]);
  return { type: 'LineString', coordinates };
}

function inBox([lon, lat], [minLon, minLat, maxLon, maxLat]) {
  return minLon <= lon && lon <= maxLon && minLat <= lat && lat <= maxLat;
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('Usage: node tools/rnc-gpkg-extract.js rnc2025.gpkg output-directory');
    return 1;
  }
  const [source, target] = argv;
  fs.mkdirSync(target, { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });

  const roads = [];
  const roadQuery = db.prepare(
    "select geom,ID_RED,CODIGO,NOMBRE from red_vial where CODIGO in ('54','150') and PEAJE='Si'"
  );
  roadQuery.setReturnArrays(true);
  for (const [geom, idRed, code, name] of roadQuery.all()) {
    const shape = geometry(geom);
    const route = `${code}D`;
    if (shape.coordinates.some(vertex => inBox(vertex, BOXES[route]))) {
      roads.push({
        type: 'Feature',
        properties: { Codigo: route, Id_Red: idRed, Nombre: name },
        geometry: shape
      });
    }
  }

  const posts = [];
  const postQuery = db.prepare('select geom,ID_KM,KM from poste_de_referencia');
  postQuery.setReturnArrays(true);
  for (const [geom, idKm, km] of postQuery.all()) {
    const shape = geometry(geom);
    if (Object.values(BOXES).some(box => inBox(shape.coordinates, box))) {
      posts.push({
        type: 'Feature',
        properties: { Id_Km: idKm, Km: km },
        geometry: shape
      });
    }
  }
  db.close();

  for (const [name, features] of [['roads', roads], ['posts', posts]]) {
    fs.writeFileSync(
      path.join(target, `${name}.geojson`),
      JSON.stringify({ type: 'FeatureCollection', features })
    );
  }
  console.log(JSON.stringify({ roads: roads.length, posts: posts.length }));
  return 0;
}

module.exports = { geometry, inBox, BOXES };

if (require.main === module) process.exit(main(process.argv.slice(2)));
