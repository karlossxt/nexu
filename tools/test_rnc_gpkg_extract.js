'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { geometry, inBox, BOXES } = require('./rnc-gpkg-extract');

const ENVELOPE = [0, 32, 48, 48, 64, 0, 0, 0];

function gpkgHeader(envelope, little, bodyBytes) {
  const buffer = Buffer.alloc(8 + ENVELOPE[envelope] + bodyBytes);
  buffer.write('GP', 0, 'latin1');
  buffer[2] = 0;
  buffer[3] = (envelope << 1) | (little ? 1 : 0);
  const pos = 8 + ENVELOPE[envelope];
  buffer[pos] = little ? 1 : 0;
  return { buffer, pos };
}

function gpkgPoint(x, y, { envelope = 0, little = true, code = 1 } = {}) {
  const { buffer, pos } = gpkgHeader(envelope, little, 21);
  if (little) {
    buffer.writeUInt32LE(code, pos + 1);
    buffer.writeDoubleLE(x, pos + 5);
    buffer.writeDoubleLE(y, pos + 13);
  } else {
    buffer.writeUInt32BE(code, pos + 1);
    buffer.writeDoubleBE(x, pos + 5);
    buffer.writeDoubleBE(y, pos + 13);
  }
  return buffer.subarray(0, pos + 21);
}

function gpkgLineString(points, { envelope = 0, little = true, code = 2 } = {}) {
  const { buffer, pos } = gpkgHeader(envelope, little, 9 + points.length * 16);
  const u32 = little ? buffer.writeUInt32LE.bind(buffer) : buffer.writeUInt32BE.bind(buffer);
  const f64 = little ? buffer.writeDoubleLE.bind(buffer) : buffer.writeDoubleBE.bind(buffer);
  u32(code, pos + 1);
  u32(points.length, pos + 5);
  points.forEach(([x, y], i) => {
    f64(x, pos + 9 + 16 * i);
    f64(y, pos + 17 + 16 * i);
  });
  return buffer;
}

test('gpkg point decodes to GeoJSON in both endiannesses and with envelopes', () => {
  for (const little of [true, false]) {
    for (const envelope of [0, 1, 2, 3, 4]) {
      assert.deepEqual(geometry(gpkgPoint(-102.5, 19.2, { envelope, little })), {
        type: 'Point', coordinates: [-102.5, 19.2]
      });
    }
  }
});

test('linestring vertex count and offsets are read from the blob', () => {
  const vertices = [[-104.6, 18.8], [-103.9, 19.4], [-103.1, 20.2], [-102.6, 20.9]];
  for (const little of [true, false]) {
    assert.deepEqual(geometry(gpkgLineString(vertices, { little })), {
      type: 'LineString', coordinates: vertices
    });
  }
});

test('a single-vertex linestring is not confused with an empty one', () => {
  assert.deepEqual(geometry(gpkgLineString([[-99.5, 19.5]])), {
    type: 'LineString', coordinates: [[-99.5, 19.5]]
  });
});

test('geometry type is read modulo 1000 so Z and M linestrings still decode', () => {
  const vertices = [[-99.5, 19.5], [-99.4, 19.6]];
  assert.deepEqual(geometry(gpkgLineString(vertices, { code: 2002 })).type, 'LineString');
  assert.deepEqual(geometry(gpkgLineString(vertices, { code: 3002 })).type, 'LineString');
});

test('polygons and unreadable blobs are refused instead of silently dropped', () => {
  const { buffer, pos } = gpkgHeader(0, true, 16);
  buffer.writeUInt32LE(3, pos + 1);
  assert.throws(() => geometry(buffer), /Unexpected geometry type: 3/);
  assert.throws(() => geometry(Buffer.alloc(0)), /Expected GeoPackage geometry/);
  assert.throws(() => geometry(Buffer.from('NOTAGEOBJECT')), /Expected GeoPackage geometry/);
});

test('box test is inclusive on every edge', () => {
  const box = [0, 0, 10, 10];
  for (const corner of [[0, 0], [10, 10], [0, 10], [10, 0]]) {
    assert.equal(inBox(corner, box), true);
  }
  assert.equal(inBox([10.0001, 5], box), false);
  assert.equal(inBox([-0.0001, 5], box), false);
  assert.equal(inBox([5, -0.0001], box), false);
  assert.equal(inBox([5, 10.0001], box), false);
  assert.equal(inBox([5, 5], box), true);
});

test('the two pilot boxes are ordered lon,lat and do not overlap', () => {
  for (const box of Object.values(BOXES)) {
    assert.equal(box[0] < box[2], true);
    assert.equal(box[1] < box[3], true);
  }
  const [a, b] = Object.values(BOXES);
  assert.equal(a[2] < b[0] || b[2] < a[0], true);
});
