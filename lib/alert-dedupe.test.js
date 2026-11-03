'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isOngoingRepeat, repeatWindowHours } = require('./alert-dedupe');

const base = { sameRoad: true, sameKm: true, distanceKm: 0.1, similarity: 0.4, hoursApart: 5 };

test('mismo accidente reportado como crash y luego closure se fusiona', () => {
  assert.equal(isOngoingRepeat({ event_type: 'closure', title: 'Cierre parcial por accidente' }, { event_type: 'crash', title: 'Accidente en autopista' }, base), true);
});
test('tipos distintos con texto poco parecido no se fusionan', () => {
  assert.equal(isOngoingRepeat({ event_type: 'closure' }, { event_type: 'crash' }, { ...base, similarity: 0.1 }), false);
});
test('obras de mantenimiento vigentes varios días se fusionan (48 h)', () => {
  const r = { event_type: 'closure', title: 'Cierre parcial por mantenimiento del puente' };
  assert.equal(repeatWindowHours(r, r), 48);
  assert.equal(isOngoingRepeat(r, r, { ...base, hoursApart: 40 }), true);
  assert.equal(isOngoingRepeat(r, r, { ...base, hoursApart: 60 }), false);
});
test('un accidente distinto 14 h después en el mismo km no se fusiona', () => {
  const r = { event_type: 'crash', title: 'Accidente de tractocamión' };
  assert.equal(isOngoingRepeat(r, r, { ...base, hoursApart: 14 }), false);
});
test('carga vehicular repetida en la misma plaza dentro de 6 h se fusiona', () => {
  const t = { event_type: 'traffic_update', title: 'Carga vehicular en Plaza de Cobro Amozoc' };
  assert.equal(isOngoingRepeat(t, t, { ...base, sameKm: false, similarity: 0.9, hoursApart: 4 }), true);
  assert.equal(isOngoingRepeat(t, t, { ...base, sameKm: false, similarity: 0.9, hoursApart: 8 }), false);
});
test('otra vía nunca se fusiona', () => {
  const r = { event_type: 'crash' };
  assert.equal(isOngoingRepeat(r, r, { ...base, sameRoad: false }), false);
});
test('km distinto y lejos no se fusiona', () => {
  const r = { event_type: 'crash' };
  assert.equal(isOngoingRepeat(r, r, { ...base, sameKm: false, distanceKm: 1.2 }), false);
});
