'use strict';

// Inspección rápida de un shapefile del RNC: cabecera, columnas del .dbf y
// primeras filas. Sirve para revisar columnas antes de tocar build-rnc.js.
// Uso: node tools/shp-inspect.js rnc-work/redvial/red_vial.shp [nFilas]

const { shpHeader, shpRecords, readDbfHeader, dbfRows, zip } = require('./shapefile');

function main(argv) {
  const [source, countArg] = argv;
  if (!source) {
    console.error('Usage: node tools/shp-inspect.js ruta/archivo.shp [filas]');
    return 1;
  }
  const dbfPath = source.replace(/\.shp$/i, '.dbf');
  const header = shpHeader(source);
  const dbf = readDbfHeader(dbfPath);
  console.log(JSON.stringify({
    shapeType: header.shapeType,
    bbox: header.bbox.map(v => Math.round(v * 1e6) / 1e6),
    records: dbf.recordCount,
    fields: dbf.fields.map(f => `${f.name}:${f.type}(${f.length}${f.decimals ? '.' + f.decimals : ''})`)
  }, null, 2));

  const limit = Number(countArg) || 5;
  let index = 0;
  for (const [shape, row] of zip(shpRecords(source), dbfRows(dbfPath))) {
    if (index++ >= limit) break;
    console.log(JSON.stringify({ shape: shape && shape.parts[0].slice(0, 3), row }, null, 2));
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
