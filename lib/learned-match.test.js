const test = require('node:test'), assert = require('node:assert/strict');
const { keyOf, sameState, isSpecificPlace, matchLearned, selectHints } = require('./learned-match');

test('km 8 no empata con km 84 (tokens completos)', () => {
  const rows = [{ match_key: keyOf('Autopista 57D km 8'), label: 'Autopista 57D km 8', latitude: 1, longitude: 1 }];
  assert.equal(matchLearned(rows, 'Accidente en la Autopista 57D km 84 dirección Querétaro'), null);
  assert.ok(matchLearned(rows, 'Accidente en la Autopista 57D km 8 dirección Querétaro'));
});
test('exige el mismo estado cuando ambos lo traen', () => {
  const rows = [{ match_key: keyOf('Caseta Tepotzotlán'), label: 'Caseta Tepotzotlán', state: 'Estado de México' }];
  assert.equal(matchLearned(rows, 'Fila en la caseta Tepotzotlán', { state: 'Puebla' }), null);
  assert.ok(matchLearned(rows, 'Fila en la caseta Tepotzotlán', { state: 'Edomex' }));
  assert.ok(matchLearned(rows, 'Fila en la caseta Tepotzotlán', {}));
});
test('kilómetro del lugar aprendido debe aparecer en el texto', () => {
  const rows = [{ match_key: keyOf('Arco Norte puente Tula'), label: 'Arco Norte puente Tula', kilometer: 38 }];
  assert.equal(matchLearned(rows, 'Arco Norte puente Tula km 90'), null);
  assert.ok(matchLearned(rows, 'Arco Norte puente Tula km 38'));
});
test('alias: la frase original que falló también resuelve', () => {
  const rows = [{ match_key: keyOf('Entronque Jorobas'), label: 'Entronque Jorobas', aliases: ['la curva del diablo de jorobas'] }];
  assert.ok(matchLearned(rows, 'Choque en la curva del diablo de Jorobas'));
});
test('CDMX y Ciudad de México son el mismo estado', () => {
  assert.ok(sameState('CDMX', 'Ciudad de México'));
  assert.ok(!sameState('Ciudad de México', 'Estado de México'));
});
test('una autopista completa no es lugar específico', () => {
  assert.equal(isSpecificPlace('Autopista México-Querétaro', null), false);
  assert.equal(isSpecificPlace('Caseta Palmillas', null), true);
  assert.equal(isSpecificPlace('Autopista México-Querétaro', 84), true);
});
test('selectHints solo trae lugares relacionados y del mismo estado', () => {
  const rows = [
    { label: 'Caseta Tepotzotlán', state: 'Estado de México' },
    { label: 'Caseta Palmillas', state: 'Querétaro' },
    { label: 'Puente Atenco', state: 'Estado de México' }
  ];
  assert.deepEqual(selectHints(rows, 'Fila larga en caseta Tepotzotlán', 'Estado de México'), ['Caseta Tepotzotlán']);
});
test('km con formato carretero 164+500 empata con 164.5', () => {
  assert.equal(keyOf('km 164+500'), '164 5');
  const rows = [{ match_key: keyOf('Autopista México-Puebla km 164.5'), label: 'Autopista México-Puebla km 164.5', kilometer: 164.5 }];
  assert.ok(matchLearned(rows, 'Accidente en la Autopista México-Puebla km 164+500'));
  assert.ok(matchLearned(rows, 'Accidente en la Autopista México-Puebla km 164.5'));
  assert.equal(matchLearned(rows, 'Accidente en la Autopista México-Puebla km 164'), null);
});
test('un kilometer vacío no se toma como km 0', () => {
  const rows = [{ match_key: keyOf('Caseta Palmillas'), label: 'Caseta Palmillas', kilometer: '' }];
  assert.ok(matchLearned(rows, 'Fila en la caseta Palmillas'));
});
test('aliases con km: la frase «vía km N» reconoce el lugar', () => {
  const rows = [{ match_key: keyOf('Entronque Tepeji'), label: 'Entronque Tepeji', aliases: ['Autopista Arco Norte km 38'] }];
  assert.ok(matchLearned(rows, 'Bloqueo en la Autopista Arco Norte km 38'));
});
