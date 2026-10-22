'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addressMunicipality, googleMunicipality, geoapifyMunicipality } = require('./municipality');

test('Nominatim: prefiere municipality y cae a county/city/town/village', () => {
  assert.equal(addressMunicipality({ municipality: 'Centro', county: 'Otro', state: 'CDMX' }), 'Centro');
  assert.equal(addressMunicipality({ county: 'Santa María Colotepec', state: 'Oaxaca' }), 'Santa María Colotepec');
  assert.equal(addressMunicipality({ city: 'Puebla de Zaragoza', state: 'Puebla' }), 'Puebla de Zaragoza');
  assert.equal(addressMunicipality({ town: 'Boca del Río', state: 'Veracruz' }), 'Boca del Río');
  assert.equal(addressMunicipality({ village: 'San Vicente Ferrer', state: 'Querétaro' }), 'San Vicente Ferrer');
  // En CDMX la alcaldía viene en borough, no en city.
  assert.equal(addressMunicipality({ city: 'Ciudad de México', borough: 'Gustavo A. Madero', state: 'Ciudad de México' }), 'Gustavo A. Madero');
  assert.equal(addressMunicipality({ state: 'Jalisco' }), '');
});

test('Google: administrative_area_level_2 antes que locality', () => {
  assert.equal(googleMunicipality({
    address_components: [
      { long_name: 'Cuautitlán Izcalli', types: ['locality', 'political'] },
      { long_name: 'Cuautitlán Izcalli', types: ['administrative_area_level_2', 'political'] },
      { long_name: 'Estado de México', types: ['administrative_area_level_1', 'political'] }
    ]
  }), 'Cuautitlán Izcalli');
  assert.equal(googleMunicipality({
    address_components: [
      { long_name: 'El Marqués', types: ['administrative_area_level_2', 'political'] }
    ]
  }), 'El Marqués');
  assert.equal(googleMunicipality({ address_components: [] }), '');
});

test('Geoapify: municipality/city/county sin inventar', () => {
  assert.equal(geoapifyMunicipality({ municipality: 'Los Reyes de Juárez', city: 'Buenavista de Juárez' }), 'Los Reyes de Juárez');
  assert.equal(geoapifyMunicipality({ city: 'Acatlán de Juárez', county: 'Región Centro' }), 'Acatlán de Juárez');
  assert.equal(geoapifyMunicipality({ county: 'Cotaxtla', state: 'Veracruz' }), 'Cotaxtla');
  assert.equal(geoapifyMunicipality({ city: 'Ciudad de México', district: 'Tlalpan', state: 'Ciudad de México' }), 'Tlalpan');
  assert.equal(geoapifyMunicipality({ state: 'Veracruz' }), '');
});

test('Limpia espacios y valores vacíos', () => {
  assert.equal(addressMunicipality({ county: '  Municipio   de Puebla  ' }), 'Municipio de Puebla');
  assert.equal(googleMunicipality(), '');
  assert.equal(geoapifyMunicipality(), '');
});
