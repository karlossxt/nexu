'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {kilometersConflict,normalizedKilometer,parseKilometer}=require('./alert-km');

test('different reported kilometres cannot collapse at one orientative road point',()=>{
  assert.equal(kilometersConflict(27,102),true);
  assert.equal(kilometersConflict(27,27),false);
  assert.equal(kilometersConflict(27,28),false);
  assert.equal(kilometersConflict(null,102),false);
  assert.equal(kilometersConflict(undefined,0),false);
});

test('a missing classifier kilometre never becomes km 0',()=>{
  assert.equal(normalizedKilometer(null,'Choque en la Autopista 15D'),null);
  assert.equal(normalizedKilometer(undefined,'Choque en la Autopista 15D'),null);
  assert.equal(normalizedKilometer('','Choque en la Autopista 15D'),null);
  assert.equal(normalizedKilometer('   ','Choque en la Autopista 15D'),null);
  assert.equal(normalizedKilometer('sin dato','Choque en la Autopista 15D'),null);
  assert.equal(normalizedKilometer(0,'Cierre total en la carretera'),null);
});

test('the note body never overwrites a kilometre the classifier already found',()=>{
  assert.equal(normalizedKilometer(27,'Reporte del 2024 + 300 MHz'),27);
  assert.equal(normalizedKilometer(27,'Costo 1500 + 45 pesos'),27);
  assert.equal(normalizedKilometer(27,'Cierre km 12+500'),27);
  assert.equal(normalizedKilometer(121,'Actualizado en 2026'),121);
});

test('kilometres outside the physical range of a mexican road are discarded',()=>{
  assert.equal(normalizedKilometer(2024,'Cierre total'),null);
  assert.equal(normalizedKilometer(1500.045,'Cierre total'),null);
  assert.equal(normalizedKilometer(-5,'Cierre total'),null);
});

test('textual rescue reads ordered kilometres and only with an explicit km prefix',()=>{
  assert.equal(normalizedKilometer(null,'Bloqueo en el km 66+500'),66.5);
  assert.equal(normalizedKilometer(null,'Bloqueo en el kilómetro 74.6'),74.6);
  assert.equal(normalizedKilometer(null,'Cierre en el km 102'),102);
  assert.equal(normalizedKilometer(null,'Archivo 2024 + 300'),null);
  assert.equal(normalizedKilometer(null,'Costo 1500 + 45 pesos'),null);
  assert.equal(normalizedKilometer(null,'Sin referencia de kilometraje'),null);
});

test('parseKilometer normalises the formats the classifier can emit',()=>{
  assert.equal(parseKilometer(27),27);
  assert.equal(parseKilometer('27'),27);
  assert.equal(parseKilometer('66.5'),66.5);
  assert.equal(parseKilometer('66,5'),66.5);
  assert.equal(parseKilometer('66+500'),66.5);
  assert.equal(parseKilometer('km 66+500'),66.5);
  assert.equal(parseKilometer(null),null);
  assert.equal(parseKilometer(0),null);
});

 test('does not truncate invalid km and preserves explicit origins and large chainage',()=>{
  assert.equal(normalizedKilometer(null,'Cierre km 2024'),null);
  assert.equal(normalizedKilometer(null,'Cierre km 12345'),null);
  assert.equal(parseKilometer('27 basura'),null);
  assert.equal(normalizedKilometer(null,'La Pera Cuautla km 0'),0);
  assert.equal(normalizedKilometer(0,'La Pera Cuautla km 0'),0);
  assert.equal(normalizedKilometer(500,'Cierre'),500);
  assert.equal(normalizedKilometer(null,'Cierre km 500'),500);
 });
