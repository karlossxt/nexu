'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shpHeader, shpRecords, readDbfHeader, dbfRows, zip } = require('./shapefile');

// Escritores mínimos para fabricar shapefiles sintéticos: el .shp real del
// RNC no puede entrar a un test y hace falta provocar casos borde (récord
// más grande que el bloque de lectura, borrados, acentos).

function writeShp(file, shapeType, shapes) {
  const contents = shapes.map(shape => shapeContent(shapeType, shape));
  const total = 100 + contents.reduce((sum, c) => sum + 8 + c.length, 0);
  const head = Buffer.alloc(100);
  head.writeInt32BE(9994, 0);
  head.writeInt32BE(total / 2, 24);
  head.writeInt32LE(1000, 28);
  head.writeInt32LE(shapeType, 32);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    forEachCoord(shapeType, shape, (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
  }
  head.writeDoubleLE(minX, 36);
  head.writeDoubleLE(minY, 44);
  head.writeDoubleLE(maxX, 52);
  head.writeDoubleLE(maxY, 60);
  const chunks = [head];
  let record = 1;
  for (const content of contents) {
    const header = Buffer.alloc(8);
    header.writeInt32BE(record++, 0);
    header.writeInt32BE(content.length / 2, 4);
    chunks.push(header, content);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

function forEachCoord(shapeType, shape, fn) {
  if (!shape) return;
  if (shapeType === 1) {
    fn(shape[0], shape[1]);
    return;
  }
  // Una parte: [[x, y], ...]; varias: [[[x, y], ...], ...].
  const parts = typeof shape[0][0] === 'number' ? [shape] : shape;
  for (const part of parts) {
    for (const [x, y] of part) fn(x, y);
  }
}

function shapeContent(shapeType, shape) {
  if (shape === null) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(0, 0);
    return buf;
  }
  if (shapeType === 1) {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(1, 0);
    buf.writeDoubleLE(shape[0], 4);
    buf.writeDoubleLE(shape[1], 12);
    return buf;
  }
  // PolyLine
  const parts = shape;
  const numPoints = parts.reduce((sum, p) => sum + p.length, 0);
  const buf = Buffer.alloc(44 + parts.length * 4 + numPoints * 16);
  buf.writeInt32LE(shapeType, 0);
  let offset = 36;
  buf.writeInt32LE(parts.length, offset);
  offset += 4;
  buf.writeInt32LE(numPoints, offset);
  offset += 4;
  let index = 0;
  for (const part of parts) {
    buf.writeInt32LE(index, offset);
    offset += 4;
    index += part.length;
  }
  for (const part of parts) {
    for (const [x, y] of part) {
      buf.writeDoubleLE(x, offset);
      buf.writeDoubleLE(y, offset + 8);
      offset += 16;
    }
  }
  return buf;
}

function writeDbf(file, fields, rows, { encoding = 'utf8', deleted = [] } = {}) {
  const recordSize = 1 + fields.reduce((sum, f) => sum + f.length, 0);
  const headerSize = 32 + fields.length * 32 + 1;
  const head = Buffer.alloc(32);
  head[0] = 0x03;
  head.writeUInt32LE(rows.length, 4);
  head.writeUInt16LE(headerSize, 8);
  head.writeUInt16LE(recordSize, 10);
  const descriptors = Buffer.alloc(fields.length * 32);
  fields.forEach((f, i) => {
    const o = i * 32;
    descriptors.write(f.name, o, 'latin1');
    descriptors[o + 11] = f.type.charCodeAt(0);
    descriptors[o + 16] = f.length;
    descriptors[o + 17] = f.decimals || 0;
  });
  const terminator = Buffer.from([0x0d]);
  const records = rows.map((row, i) => {
    const buf = Buffer.alloc(recordSize);
    buf[0] = deleted.includes(i) ? 0x2a : 0x20;
    let offset = 1;
    fields.forEach((f) => {
      // dBase almacena ancho fijo en bytes; un acento UTF-8 ocupa 2-3.
      const bytes = Buffer.from(String(row[f.name] ?? ''), encoding).subarray(0, f.length);
      bytes.copy(buf, offset);
      for (let i = bytes.length; i < f.length; i++) buf[offset + i] = 0x20;
      offset += f.length;
    });
    return buf;
  });
  fs.writeFileSync(file, Buffer.concat([head, descriptors, terminator, ...records]));
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('polyline se recupera con todas sus partes y coordenadas', (t) => {
  const dir = tmpdir(t);
  const shp = path.join(dir, 'a.shp');
  const lines = [
    [[-99.1, 19.2], [-99.2, 19.3], [-99.3, 19.4]],
    [[-99.5, 19.5], [-99.6, 19.6]]
  ];
  writeShp(shp, 3, [lines, [[[1.5, 2.5]]]]);
  assert.deepEqual(shpHeader(shp).bbox, [-99.6, 2.5, 1.5, 19.6]);
  const shapes = [...shpRecords(shp)];
  assert.equal(shapes.length, 2);
  assert.deepEqual(shapes[0].parts, lines);
  assert.deepEqual(shapes[1].parts, [[[1.5, 2.5]]]);
});

test('las formas nulas se emiten como null para no descuadrar el .dbf', (t) => {
  const dir = tmpdir(t);
  const shp = path.join(dir, 'n.shp');
  writeShp(shp, 1, [[10, 20], null, [30, 40]]);
  assert.deepEqual([...shpRecords(shp)].map(s => s === null ? null : s.parts[0][0]),
    [[10, 20], null, [30, 40]]);
});

test('un récord más grande que el bloque de lectura no se trunca', (t) => {
  const dir = tmpdir(t);
  const shp = path.join(dir, 'big.shp');
  // ~600k puntos = ~9.6 MB de contenido: supera el bloque de 8 MB.
  const points = Array.from({ length: 600000 }, (_, i) => [-99 + i * 1e-6, 19]);
  writeShp(shp, 3, [[points]]);
  const shapes = [...shpRecords(shp)];
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].parts[0].length, 600000);
  assert.deepEqual(shapes[0].parts[0][599999], points[599999]);
});

test('el dbf decodifica C/N/D/L y marca borrados sin perder alineación', (t) => {
  const dir = tmpdir(t);
  const dbf = path.join(dir, 't.dbf');
  const fields = [
    { name: 'NOMBRE', type: 'C', length: 30 },
    { name: 'KM', type: 'N', length: 8, decimals: 2 },
    { name: 'ACTIVA', type: 'L', length: 1 },
    { name: 'FECHA', type: 'D', length: 8 }
  ];
  const rows = [
    { NOMBRE: 'Cuernavaca–Acapulco', KM: '45.50', ACTIVA: 'T', FECHA: '20250123' },
    { NOMBRE: 'N/D', KM: '', ACTIVA: '?', FECHA: '' },
    { NOMBRE: 'México-Querétaro', KM: '123', ACTIVA: 'N', FECHA: '20251006' }
  ];
  writeDbf(dbf, fields, rows, { deleted: [1] });
  const header = readDbfHeader(dbf);
  assert.equal(header.recordCount, 3);
  assert.deepEqual(header.fields.map(f => f.name), ['NOMBRE', 'KM', 'ACTIVA', 'FECHA']);
  const parsed = [...dbfRows(dbf)];
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].NOMBRE, 'Cuernavaca–Acapulco');
  assert.equal(parsed[0].KM, 45.5);
  assert.equal(parsed[0].ACTIVA, true);
  assert.equal(parsed[0].FECHA, '2025-01-23');
  assert.equal(parsed[1].KM, null);
  assert.equal(parsed[1].ACTIVA, null);
  assert.equal(parsed[1].deleted, true);
  assert.equal(parsed[2].NOMBRE, 'México-Querétaro');
  assert.equal(parsed[2].KM, 123);
  assert.equal(parsed[2].ACTIVA, false);
});

test('la autodetección elige latin1 cuando el texto no es UTF-8 válido', (t) => {
  const dir = tmpdir(t);
  const dbf = path.join(dir, 'l.dbf');
  const fields = [{ name: 'NOMBRE', type: 'C', length: 30 }];
  // "Cuauhtémoc" en CP1252: C3 nunca aparece, A9 sí suelto → UTF-8 inválido.
  writeDbf(dbf, fields, [{ NOMBRE: 'x' }], { encoding: 'latin1' });
  const raw = fs.readFileSync(dbf);
  const headerSize = raw.readUInt16LE(8);
  const name = Buffer.from([0x43, 0x75, 0x61, 0x75, 0x68, 0x74, 0xe9, 0x6d, 0x6f, 0x63]);
  name.copy(raw, headerSize + 1);
  fs.writeFileSync(dbf, raw);
  const row = [...dbfRows(dbf)][0];
  assert.equal(row.NOMBRE, 'Cuauhtémoc');
});

test('zip empareja ambos generadores y rellena con null si uno termina', (t) => {
  const dir = tmpdir(t);
  const shp = path.join(dir, 'z.shp');
  const dbf = path.join(dir, 'z.dbf');
  writeShp(shp, 1, [[1, 2], null, [3, 4]]);
  writeDbf(dbf, [{ name: 'NOMBRE', type: 'C', length: 5 }],
    [{ NOMBRE: 'a' }, { NOMBRE: 'b' }, { NOMBRE: 'c' }, { NOMBRE: 'd' }]);
  const pairs = [...zip(shpRecords(shp), dbfRows(dbf))];
  assert.equal(pairs.length, 4);
  assert.deepEqual(pairs.map(([s, r]) => [s === null ? null : 'shape', r.NOMBRE]),
    [['shape', 'a'], [null, 'b'], ['shape', 'c'], [null, 'd']]);
});
