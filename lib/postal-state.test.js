'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stateFromPostalLabel } = require('./postal-state');

test('lee el código estatal de la dirección postal', () => {
  assert.equal(stateFromPostalLabel('Autopista México-Puebla, 72710 Sanctorum, PUE, México · km 104'), 'Puebla');
  assert.equal(stateFromPostalLabel('Autopista Guadalajara - Morelia, 45422, JAL, México · km 114'), 'Jalisco');
  assert.equal(stateFromPostalLabel('De Las Torres (autopista Chamapa- 0, 52910 López Mateos, MEX, México · km 10'), 'Estado de México');
  assert.equal(stateFromPostalLabel('33010 Colonia Morelos (Cuatro Vientos), CHH, México · ref. colonia Morelos'), 'Chihuahua');
  assert.equal(stateFromPostalLabel('Autopista Tehuacán - Oaxaca, 68250, OAX, México'), 'Oaxaca');
});

test('no confunde la dirección de circulación con el estado', () => {
  assert.equal(stateFromPostalLabel('México - Querétaro · km 158 · sentido hacia CDMX'), '');
  assert.equal(stateFromPostalLabel('México–Puebla · km 24 · sentido dirección CDMX'), '');
  assert.equal(stateFromPostalLabel('Córdoba - Veracruz · km 95 · sentido hacia CDMX'), '');
  assert.equal(stateFromPostalLabel('Autopista Cuernavaca - Acapulco · km 60 · sentido dirección CDMX'), '');
});

test('ignora etiquetas sin dirección postal', () => {
  assert.equal(stateFromPostalLabel('La Pera - Cuautla · km 15 · ref. km 15'), '');
  assert.equal(stateFromPostalLabel(''), '');
  assert.equal(stateFromPostalLabel(null), '');
});
