'use strict';

// Lector mínimo de shapefiles en Node puro, sin dependencias. Cubre Point,
// PolyLine, Polygon y MultiPoint con sus variantes Z/M: todo lo que trae el
// RNC 2025 de IMT. Los archivos del RNC son geográficos (lon/lat ITRF2008,
// prácticamente WGS84) y UTF-8 según su .prj/.cpg, así que no hay que
// reproyectar ni recodificar.
//
// Se leen en streaming (bloques de 8 MB) porque red_vial.shp pesa ~890 MB y
// su .dbf ~2.36 GB con 4.35 millones de registros: cargarlo entero revienta.
//
//   const { shpRecords, dbfRows, zip } = require('./shapefile');
//   for (const [shape, row] of zip(shpRecords(a), dbfRows(b))) { ... }
//
// Por especificación el .shp y el .dbf comparten el orden de registros, así
// que zip() los empareja 1 a 1. Las formas nulas y las filas borradas se
// emiten igual (como null / borrada) para no descuadrar esa correspondencia.

const fs = require('node:fs');

const SHP_HEADER_BYTES = 100;
const CHUNK_BYTES = 8 << 20; // bytes por lectura: pocos syscalls en archivos de GB

function shpHeader(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const head = Buffer.alloc(SHP_HEADER_BYTES);
    fs.readSync(fd, head, 0, SHP_HEADER_BYTES, 0);
    if (head.readInt32BE(0) !== 9994) throw new Error(`No es un .shp válido: ${path}`);
    return {
      fileLengthBytes: head.readInt32BE(24) * 2,
      shapeType: head.readInt32LE(32),
      // Xmin, Ymin, Xmax, Ymax
      bbox: [head.readDoubleLE(36), head.readDoubleLE(44), head.readDoubleLE(52), head.readDoubleLE(60)]
    };
  } finally {
    fs.closeSync(fd);
  }
}

// El contenido de un registro empieza con el tipo en LE. Las variantes Z/M
// (11/13/15/18 y 21/23/25/28) repiten el mismo layout 2D al principio, así
// que la Z/M se ignora: para georreferenciar un pin sobra con X/Y.
function parseShape(buf) {
  const type = buf.readInt32LE(0);
  if (type === 0) return null; // Null shape
  if (type === 1 || type === 11 || type === 21) {
    return { type: 1, parts: [[[buf.readDoubleLE(4), buf.readDoubleLE(12)]]] };
  }
  if (type === 3 || type === 5 || type === 13 || type === 15 || type === 23 || type === 25) {
    const numParts = buf.readInt32LE(36);
    const numPoints = buf.readInt32LE(40);
    const partsOffset = 44;
    const pointsOffset = partsOffset + numParts * 4;
    const parts = [];
    let start = buf.readInt32LE(partsOffset);
    for (let p = 1; p <= numParts; p++) {
      const end = p < numParts ? buf.readInt32LE(partsOffset + p * 4) : numPoints;
      const part = [];
      for (let i = start; i < end; i++) {
        const off = pointsOffset + i * 16;
        part.push([buf.readDoubleLE(off), buf.readDoubleLE(off + 8)]);
      }
      parts.push(part);
      start = end;
    }
    return { type, parts };
  }
  if (type === 8 || type === 18 || type === 28) {
    const numPoints = buf.readInt32LE(36);
    const part = [];
    for (let i = 0; i < numPoints; i++) {
      const off = 40 + i * 16;
      part.push([buf.readDoubleLE(off), buf.readDoubleLE(off + 8)]);
    }
    return { type, parts: [part] };
  }
  throw new Error(`Tipo de forma no soportado: ${type}`);
}

function* shpRecords(path) {
  const fd = fs.openSync(path, 'r');
  try {
    shpHeader(path);
    let buffer = Buffer.alloc(CHUNK_BYTES);
    let pos = 0;
    let end = 0;
    let filePos = SHP_HEADER_BYTES;
    let eof = false;

    const compact = () => {
      if (pos > 0) {
        buffer.copy(buffer, 0, pos, end);
        end -= pos;
        pos = 0;
      }
    };
    const readMore = () => {
      if (eof) return 0;
      const read = fs.readSync(fd, buffer, end, buffer.length - end, filePos);
      filePos += read;
      end += read;
      if (read === 0) eof = true;
      return read;
    };
    // Garantiza `bytes` disponibles desde pos; false si el archivo termina.
    const ensure = (bytes) => {
      while (end - pos < bytes) {
        compact();
        if (end === buffer.length) buffer = Buffer.concat([buffer, Buffer.alloc(buffer.length)]);
        if (!readMore()) return end - pos >= bytes;
      }
      return true;
    };

    while (ensure(8)) {
      const contentBytes = buffer.readInt32BE(pos + 4) * 2;
      if (!ensure(8 + contentBytes)) throw new Error(`Registro truncado en ${path}`);
      yield parseShape(buffer.subarray(pos + 8, pos + 8 + contentBytes));
      pos += 8 + contentBytes;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readDbfHeader(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const head = Buffer.alloc(32);
    fs.readSync(fd, head, 0, 32, 0);
    const headerSize = head.readUInt16LE(8);
    const descriptor = Buffer.alloc(headerSize - 32);
    fs.readSync(fd, descriptor, 0, descriptor.length, 32);
    return {
      recordCount: head.readUInt32LE(4),
      headerSize,
      recordSize: head.readUInt16LE(10),
      fields: parseFieldDescriptors(descriptor)
    };
  } finally {
    fs.closeSync(fd);
  }
}

function parseFieldDescriptors(descriptor) {
  const fields = [];
  for (let o = 0; o + 32 <= descriptor.length; o += 32) {
    if (descriptor[o] === 0x0d) break; // fin de descriptores
    fields.push({
      name: descriptor.toString('latin1', o, o + 11).replace(/\0[\s\S]*$/, ''),
      type: String.fromCharCode(descriptor[o + 11]),
      length: descriptor[o + 16],
      decimals: descriptor[o + 17]
    });
  }
  return fields;
}

// El .cpg manda, pero no todos los shapefiles lo traen: si falta, se decide
// por una muestra. Un texto en UTF-8 válido suele ser UTF-8; bytes de
// acentos en CP1252/Latin-1 casi siempre rompen la validación estricta.
function detectEncoding(fd, start, length) {
  const sample = Buffer.alloc(Math.min(length, 1 << 20));
  fs.readSync(fd, sample, 0, sample.length, start);
  const cut = sample.subarray(0, Math.max(0, sample.length - 3)); // corta multibyte final
  const hasHigh = cut.some(b => b >= 0x80);
  if (!hasHigh) return 'utf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(cut);
    return 'utf8';
  } catch {
    return 'latin1';
  }
}

function decodeValue(raw, field, decode) {
  switch (field.type) {
    case 'N':
    case 'F': {
      const text = decode(raw).trim();
      if (!text) return null;
      const value = Number(text);
      // "*****" o similar: se queda el texto crudo en vez de NaN.
      return Number.isNaN(value) ? text : value;
    }
    case 'L': {
      const flag = String.fromCharCode(raw[0]);
      if (flag === 'Y' || flag === 'T') return true;
      if (flag === 'N' || flag === 'F') return false;
      return null;
    }
    case 'D': {
      const text = decode(raw).trim();
      return /^\d{8}$/.test(text)
        ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
        : null;
    }
    default: // C y cualquier tipo desconocido: texto
      return decode(raw).replace(/\0/g, '').trim();
  }
}

function* dbfRows(path, encoding = 'auto') {
  const fd = fs.openSync(path, 'r');
  try {
    const { recordCount, headerSize, recordSize, fields } = readDbfHeader(path);
    const chosen = encoding === 'auto'
      ? detectEncoding(fd, headerSize, recordSize * recordCount)
      : encoding;
    const decode = (buf) => buf.toString(chosen);
    // Bloques de registros: un readSync por fila serían millones de syscalls
    // sobre el .dbf de 2.36 GB.
    const recordsPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / recordSize));
    const chunk = Buffer.alloc(recordsPerChunk * recordSize);
    for (let base = 0; base < recordCount; base += recordsPerChunk) {
      const count = Math.min(recordsPerChunk, recordCount - base);
      fs.readSync(fd, chunk, 0, count * recordSize, headerSize + base * recordSize);
      for (let i = 0; i < count; i++) {
        const record = chunk.subarray(i * recordSize, (i + 1) * recordSize);
        const row = { deleted: record[0] === 0x2a };
        let offset = 1;
        for (const field of fields) {
          row[field.name] = decodeValue(record.subarray(offset, offset + field.length), field, decode);
          offset += field.length;
        }
        yield row;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Empareja dos generadores; si uno termina antes, el faltante entra como null.
function* zip(left, right) {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done && y.done) return;
    yield [x.done ? null : x.value, y.done ? null : y.value];
  }
}

module.exports = { shpHeader, shpRecords, readDbfHeader, dbfRows, zip };
