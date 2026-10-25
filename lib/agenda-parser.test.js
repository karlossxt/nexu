const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAgenda, parseTime, parseDate, severityFor } = require('./agenda-parser');
const { buildRow, titleCase, externalId } = require('./agenda-alert');

const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'agenda-2026-10-23.txt'), 'utf8');
const parsed = parseAgenda(sample);
const find = (re) => parsed.events.filter(e => re.test(e.name));

test('lee la fecha del encabezado', () => {
  assert.equal(parsed.date, '2026-10-23');
  assert.equal(parseDate('AGENDA DE MOVILIZACIONES 5 DE ENERO 2027'), '2027-01-05');
  assert.equal(parseDate('sin fecha'), null);
});

test('separa bloques y expande lugares múltiples', () => {
  assert.equal(parsed.events.length, 11);
  assert.equal(find(/TEPEPAN/).length, 2);
  assert.equal(find(/PLATAFORMA/).length, 3);
  assert.deepEqual(parsed.warnings, []);
});

test('marcha con origen y destino', () => {
  const [m] = find(/SECCIÓN XXXII/);
  assert.equal(m.kind, 'marcha');
  assert.equal(m.time, '07:00');
  assert.equal(m.aforo, 400);
  assert.equal(m.destination, 'Zócalo Capitalino');
  assert.equal(m.severity, 'high');
  assert.equal(m.roadImpact, true);
});

test('horario "Durante el día" y campos ausentes', () => {
  const [p] = find(/VILLA ESTRELLA/);
  assert.equal(p.allDay, true);
  assert.equal(p.time, null);
  assert.equal(find(/MINERVA/)[0].aforo, null);
  assert.deepEqual(parseTime('Durante el día'), { time: null, allDay: true });
  assert.deepEqual(parseTime('9:05'), { time: '09:05', allDay: false });
});

test('solo hay afectación vial cuando se anuncia o hay recorrido', () => {
  assert.equal(find(/PLATAFORMA/)[0].roadImpact, false);
  assert.equal(find(/PLATAFORMA/)[0].severity, 'low');
  assert.equal(find(/UNIVERSIDAD AUTÓNOMA/)[0].roadImpact, true);   // trae Destino
  assert.equal(find(/TEPEPAN/)[0].roadImpact, true);                // lo dice en observaciones
});

test('severidad por aforo y afectación', () => {
  assert.equal(severityFor({ kind: 'concentracion', aforo: 50, roadImpact: false }), 'low');
  assert.equal(severityFor({ kind: 'concentracion', aforo: 50, roadImpact: true }), 'medium');
  assert.equal(severityFor({ kind: 'concentracion', aforo: 200, roadImpact: true }), 'high');
  assert.equal(severityFor({ kind: 'concentracion', aforo: 5000, roadImpact: false }), 'critical');
});

test('casos sensibles se anonimizan y nunca se publica la demanda', () => {
  const sensitive = parsed.events.filter(e => e.sensitive);
  assert.equal(sensitive.length, 2);
  for (const ev of parsed.events) {
    const row = buildRow(ev, { latitude: 19.43, longitude: -99.13 });
    const blob = `${row.title} ${row.detail} ${row.location_label}`.toLowerCase();
    assert.ok(!blob.includes('margarito'), 'no debe incluir nombres de personas');
    assert.ok(!blob.includes('abuso'), 'no debe incluir la demanda');
    assert.ok(!blob.includes('violencia familiar'), 'no debe incluir la demanda');
    assert.ok(!blob.includes('conflictos de intereses'), 'no debe incluir la demanda');
  }
  const anon = buildRow(sensitive[0], null);
  assert.match(anon.title, /^Concentración en Tribunal Superior de Justicia/);
});

test('fila lista para la tabla alerts', () => {
  const [m] = find(/SECCIÓN XXXII/);
  const row = buildRow(m, { latitude: 19.4270, longitude: -99.1677, precision: 'exact', confidence: 0.8 }, { sourceUrl: 'https://example.com/agenda' });
  assert.equal(row.title, 'Marcha: Sección XXXII de la Ciudad de México del Sindicato Nacional de Trabajadores del Seguro Social');
  assert.equal(row.event_type, 'scheduled_mobilization');
  assert.equal(row.traffic_status, 'scheduled');
  assert.equal(row.category, 'road');
  assert.equal(row.event_at, '2026-10-23T13:00:00.000Z');           // 07:00 CDMX (UTC-6)
  assert.equal(row.location_status, 'automatic');
  assert.equal(row.source_url, 'https://example.com/agenda');
  assert.match(row.detail, /Posible afectación de vialidades/);
  assert.ok(!/demanda|salario/i.test(row.detail));
});

test('todo el día, sin ubicación y url insegura', () => {
  const [p] = find(/VILLA ESTRELLA/);
  const row = buildRow(p, null, { sourceUrl: 'javascript:alert(1)' });
  assert.equal(row.traffic_status, 'allday');
  assert.equal(row.event_at, '2026-10-23T06:00:00.000Z');
  assert.equal(row.location_status, 'unlocated');
  assert.equal(row.latitude, null);
  assert.equal(row.source_url, null);
});

test('identificador estable y distinto por punto', () => {
  const [a, b] = find(/TEPEPAN/);
  assert.equal(externalId(a), externalId({ ...a }));
  assert.notEqual(externalId(a), externalId(b));
  assert.match(externalId(a), /^ssc-agenda:2026-10-23:[0-9a-f]{14}$/);
});

test('títulos en mayúsculas pasan a formato legible', () => {
  assert.equal(titleCase('COMUNIDAD ESTUDIANTIL DE LA UAM'), 'Comunidad Estudiantil de la UAM');
  assert.equal(titleCase('PLATAFORMA 4:20'), 'Plataforma 4:20');
});

test('texto vacío o ajeno no revienta', () => {
  assert.equal(parseAgenda('').events.length, 0);
  assert.ok(parseAgenda('hola mundo').warnings.length > 0);
});
