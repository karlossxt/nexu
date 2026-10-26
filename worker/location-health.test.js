'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, evaluate, createMonitor } = require('./location-health');

const rows = (unlocated, approx, ok) => [
  ...Array(unlocated).fill({ location_precision: 'unlocated', kilometer: '10' }),
  ...Array(approx).fill({ location_precision: 'road_approximate', kilometer: '12' }),
  ...Array(ok).fill({ location_precision: 'rnc_poste', kilometer: '7' })
];

test('summarize cuenta sin ubicación y aproximadas entre las alertas con kilómetro', () => {
  const s = summarize(rows(3, 5, 2));
  assert.deepEqual(s, { with_km: 10, unlocated_with_km: 3, unlocated_with_km_pct: 30, approx_with_km_pct: 50 });
  assert.equal(summarize(null).with_km, 0);
  assert.equal(summarize([{ location_precision: null }]).unlocated_with_km, 1);
});

test('funcionamiento normal (~15 %) no alarma; la caída de septiembre (~80 %) sí', () => {
  assert.equal(evaluate(summarize(rows(3, 10, 7))).alarm, false);   // 15 %
  assert.equal(evaluate(summarize(rows(16, 2, 2))).alarm, true);    // 80 %
});

test('con muy pocas alertas no alarma aunque todas fallen', () => {
  const v = evaluate(summarize(rows(4, 0, 0)));
  assert.equal(v.enough_sample, false);
  assert.equal(v.alarm, false);
});

test('el aviso se manda una vez, se repite pasado el plazo y avisa al normalizarse', async () => {
  const monitor = createMonitor();
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push(JSON.parse(opts.body).text); return { ok: true, status: 200 }; };
  let data = rows(16, 2, 2);
  const sb = async () => data;
  const run = (now) => monitor.check({ sb, now, webhookUrl: 'https://hooks.example/x', fetchImpl, log() {} });
  const t0 = Date.parse('2026-10-26T12:00:00Z');

  assert.equal((await run(t0)).alarm, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /16 de 20 alertas con kilómetro/);

  await run(t0 + 30 * 60_000);                       // media hora después: no repite
  assert.equal(sent.length, 1);

  await run(t0 + 7 * 3600_000);                      // pasadas 6 h sigue roto: repite
  assert.equal(sent.length, 2);

  data = rows(2, 10, 8);                             // se normaliza
  assert.equal((await run(t0 + 8 * 3600_000)).alarm, false);
  assert.equal(sent.length, 3);
  assert.match(sent[2], /volvieron a la normalidad/);
});

test('sin webhook configurado no intenta enviar nada y un webhook caído no rompe el ciclo', async () => {
  const monitor = createMonitor();
  let called = 0;
  const sb = async () => rows(16, 2, 2);
  await monitor.check({ sb, webhookUrl: '', fetchImpl: async () => { called++; return { ok: true }; }, log() {} });
  assert.equal(called, 0);

  const broken = createMonitor();
  const logs = [];
  const result = await broken.check({ sb, webhookUrl: 'https://x', fetchImpl: async () => { throw new Error('red caída'); }, log: (lvl, msg) => logs.push(lvl + ':' + msg) });
  assert.equal(result.alarm, true);
  assert.ok(logs.some(l => l.startsWith('warn:No se pudo enviar')));
});

test('la consulta pide solo alertas con kilómetro creadas dentro de la ventana', async () => {
  let path = '';
  await createMonitor().check({ sb: async (p) => { path = p; return []; }, now: Date.parse('2026-10-26T12:00:00Z'), log() {} });
  assert.match(path, /^alerts\?select=location_precision,kilometer&kilometer=not\.is\.null&created_at=gte\.2026-10-26T06%3A00%3A00\.000Z&limit=2000$/);
});
