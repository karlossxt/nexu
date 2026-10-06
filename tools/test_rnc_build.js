'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  maximalRuns,
  runStats,
  mergeRuns,
  calibrate,
  mirrorChain,
  attachDroppedPosts
} = require('./build-rnc');

// Fixtures: postes como los deja snapPosts ({km oficial, snappedKm}).
const off = p => p.km - p.snappedKm;
const posts = specs => specs.map(([acc, km]) => ({ snappedKm: acc, km, lat: 19, lon: -99 }));

function fixtureChain(total, list) {
  return {
    id: 'T:0',
    code: 'T',
    total,
    pts: list.map(p => [p.snappedKm, 19, -99]), // [km acumulado, lat, lon]
    sections: [],
    posts: list
  };
}

test('maximalRuns parte el run en cuanto el offset sale de ventana', () => {
  const ps = posts([[0, 1], [1, 2], [2, 3], [3, 13], [4, 5], [5, 6], [6, 7]]);
  const runs = maximalRuns(ps, off);
  assert.deepEqual(runs.map(r => r.ranges), [[[0, 3]], [[3, 4]], [[4, 7]]]);
  const st = runStats(runs[0], ps, off);
  assert.equal(st.n, 3);
  assert.equal(st.spread, 0);
  assert.equal(st.fromAcc, 0);
  assert.equal(st.toAcc, 2);
});

test('mergeRuns ignora el run de un solo poste corrupto y fusiona a sus vecinos', () => {
  const ps = posts([[0, 1], [1, 2], [2, 3], [3, 13], [4, 5], [5, 6], [6, 7]]);
  const runs = mergeRuns(maximalRuns(ps, off), ps, off);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].ranges, [[0, 3], [4, 7]]);
  const st = runStats(runs[0], ps, off);
  assert.equal(st.n, 6); // el corrupto (índice 3) queda fuera
  assert.equal(st.spread, 0);
});

test('mergeRuns no fusiona si la numeración combinada excede la ventana', () => {
  // Dos numeraciones distintas separadas por un run corto: no deben unirse.
  const ps = posts([
    [0, 10], [1, 11], [2, 12],   // offset 10
    [3, 43],                      // corto: offset 40 (ni run ni puente)
    [4, 54], [5, 55], [6, 56]    // offset 50
  ]);
  const runs = mergeRuns(maximalRuns(ps, off), ps, off);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].ranges, [[0, 3]]);
  assert.deepEqual(runs[1].ranges, [[4, 7]]);
});

test('calibrate certifica dos numeraciones independientes en la misma cadena', () => {
  // Réplica de la 150:33: numeración original con origen en la Ciudad de
  // México (offset −171, km 1–23) y reinicio en Córdoba (offset +129.4, km 197–217).
  const list = [];
  for (let acc = 68; acc <= 88; acc += 2) list.push({ snappedKm: acc, km: acc + 129.4, lat: 19, lon: -99 });
  for (let acc = 172; acc <= 194; acc += 2) list.push({ snappedKm: acc, km: acc - 171, lat: 19, lon: -99 });
  const chain = fixtureChain(300, list);
  calibrate(chain);

  assert.equal(chain.calibrated, true);
  assert.equal(chain.cals.length, 2, 'las dos numeraciones certifican aparte');
  const [primary, secondary] = chain.cals;
  // Primaria = la de más anclas (12 vs 11).
  assert.equal(primary.anchors, 12);
  assert.equal(secondary.anchors, 11);
  assert.ok(Math.abs(primary.kmStart - -171) < 0.01);
  assert.ok(Math.abs(secondary.kmStart - 129.4) < 0.01);
  // Ventanas: [0.5, 23.5] y [196.9, 217.9] — disjuntas, sin solaparse.
  assert.ok(Math.abs(primary.validFrom - 0.5) < 0.01);
  assert.ok(Math.abs(primary.validTo - 23.5) < 0.01);
  assert.ok(Math.abs(secondary.validFrom - 196.9) < 0.01);
  assert.ok(Math.abs(secondary.validTo - 217.9) < 0.01);
  assert.equal(chain.validFrom, primary.validFrom, 'el nivel superior refleja la primaria');
  assert.equal(chain.anchorPosts, 23);
  assert.equal(chain.dropped.length, 0, 'todos los postes son anclas');
  assert.equal(chain.posts.length, 23);
});

test('calibrate fusiona los runs partidos por un poste corrupto (95:6)', () => {
  // Numeración continua de 61 postes con un poste corrupto en medio.
  const list = [];
  for (let i = 0; i <= 60; i++) {
    const acc = 179.6 + i * 1.5;
    list.push({ snappedKm: acc, km: acc + 25.5 + (i === 30 ? 4.5 : 0), lat: 19, lon: -99 });
  }
  const chain = fixtureChain(90, list);
  calibrate(chain);

  assert.equal(chain.calibrated, true);
  assert.equal(chain.cals.length, 1, 'un corrupto no debe partir la numeración');
  assert.equal(chain.cals[0].anchors, 60);
  assert.equal(chain.dropped.length, 1, 'solo el poste corrupto queda fuera');
  assert.ok(Math.abs(chain.cals[0].kmStart - 25.5) < 0.01);
  assert.ok(chain.cals[0].validFrom <= 179.6 + 25.5 - 0.4);
  assert.ok(chain.cals[0].validTo >= 269.6 + 25.5 + 0.4);
});

test('calibrate no certifica con menos de 3 postes', () => {
  const chain = fixtureChain(100, posts([[0, 50], [5, 55]]));
  calibrate(chain);
  assert.equal(chain.calibrated, false);
  assert.equal(chain.cals.length, 0);
  assert.equal(chain.posts.length, 2, 'los postes quedan como auditoría');
  assert.equal(chain.dropped.length, 0);
});

test('calibrate rechaza la cadena sin numeración dominante', () => {
  const list = posts([[0, 10], [5, 15], [10, 20], [15, 25]]); // 4 coherentes (offset 10)
  for (let i = 0; i < 96; i++) {
    const acc = 20 + i;
    list.push({ snappedKm: acc, km: acc + 15 + i * 4, lat: 19, lon: -99 }); // runs de a 1
  }
  const chain = fixtureChain(200, list);
  calibrate(chain);
  assert.equal(chain.calibrated, false, 'la fracción primaria es 4% y no alcanza 8 anclas');
});

test('mirrorChain refleja geometría, secciones y postes', () => {
  const chain = {
    total: 100,
    pts: [[10, 19.1, -99.1], [60, 19.2, -99.2]],
    sections: [{ name: 'A', from: 10, to: 60 }],
    posts: [{ snappedKm: 30, km: 40 }]
  };
  mirrorChain(chain);
  assert.equal(chain.reversed, true);
  assert.deepEqual(chain.pts.map(p => p[0]), [40, 90]);
  assert.deepEqual(chain.sections, [{ name: 'A', from: 40, to: 90 }]);
  assert.equal(chain.posts[0].snappedKm, 70);
});

// Dos cadenas gemelas con una sola traza compartida (el RNC duplica alineaciones):
// el segmento pertenece a cand y el poste caído vive en owner.
function twinFixture(post) {
  const cand = {
    id: '9:1', code: '9', calibrated: true, reversed: false, total: 100,
    cals: [{ kmStart: 101, validFrom: 148, validTo: 151, anchors: 5, residualKm: 0.2 }],
    validFrom: 148, validTo: 151, anchorPosts: 5, posts: [], dropped: []
  };
  const owner = {
    id: '9:0', code: '9', calibrated: true, reversed: false, total: 100,
    cals: [{ kmStart: 0, validFrom: 40, validTo: 60, anchors: 5, residualKm: 0.2 }],
    validFrom: 40, validTo: 60, anchorPosts: 5, posts: [], dropped: [post]
  };
  const seg = { pts: [[-99, 19], [-98, 19]], loc: { chain: cand, startKm: 0, lenKm: 100 } };
  const key = `${Math.floor(post.lon / 0.01)}:${Math.floor(post.lat / 0.01)}`;
  const grid = new Map([[key, [{ code: '9', i: 0 }]]]);
  const byCode = new Map([['9', [seg]]]);
  return { cand, owner, grid, byCode, all: [owner, cand] };
}

test('attachDroppedPosts reasigna el poste caído a la cadena con cal compatible', () => {
  // Poste con km 152.4: encaja (±1.4 km) en la cal de cand (kmStart 101 en acc 50 → 151).
  const { cand, owner, grid, byCode, all } = twinFixture(
    { km: 152.4, snappedKm: 10, lat: 19, lon: -98.5 });
  const rescued = attachDroppedPosts(grid, byCode, all);
  assert.equal(rescued, 1);
  assert.equal(cand.posts.length, 1);
  assert.equal(cand.posts[0].km, 152.4);
  assert.equal(cand.posts[0].snappedKm, 50, 'recolocado en su posición real de la cadena');
  assert.equal(cand.anchorPosts, 6);
  assert.equal(cand.cals[0].anchors, 6);
  // La ventana se extiende hasta el poste rescatado (±0.5 km).
  assert.ok(Math.abs(cand.cals[0].validTo - 151.5) < 0.01);
  assert.equal(cand.validTo, cand.cals[0].validTo, 'el nivel superior sigue a la primaria');
  assert.equal(owner.posts.length, 0, 'el dueño no lo recupera');
  assert.equal(owner.dropped.length, 1, 'queda como auditoría en el dueño');
});

test('attachDroppedPosts ignora el poste cuyo km no encaja en ninguna cal', () => {
  const { cand, owner, grid, byCode, all } = twinFixture(
    { km: 170, snappedKm: 10, lat: 19, lon: -98.5 }); // diff 20 km ≫ ventana
  const rescued = attachDroppedPosts(grid, byCode, all);
  assert.equal(rescued, 0);
  assert.equal(cand.posts.length, 0);
  assert.equal(cand.cals[0].validTo, 151, 'la ventana no se mueve');
  assert.equal(owner.dropped.length, 1);
});
