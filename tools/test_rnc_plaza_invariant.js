'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const inv = require('./rnc-plaza-invariant');

function chain(code, name, roadIds, posts) {
  const total = posts ?? roadIds.length;
  return {
    code, name, toll: true,
    posts: Array.from({ length: total }, (_, i) => ({ id: i, km: i, roadId: roadIds[i % roadIds.length] }))
  };
}

test('normalize folds accents and drops punctuation but keeps digits', () => {
  assert.equal(inv.normalize('Cuitláhuac - La Tinaja'), 'cuitlahuac la tinaja');
  assert.equal(inv.normalize('Circuito Exterior Mexiquense'), 'circuito exterior mexiquense');
  assert.equal(inv.normalize('16 de Septiembre'), '16 de septiembre');
});

test('toponyms drop connectors but keep meaningful short words', () => {
  assert.deepEqual([...inv.toponyms('San Martín Texmelucan - Tlaxcala')].sort(),
    ['martin', 'san', 'texmelucan', 'tlaxcala']);
  // "16" tiene dos caracteres: entra por ser topónimo, no por Connectors.
  assert.deepEqual([...inv.toponyms('16 de Septiembre')], ['16', 'septiembre']);
});

test('a plaza section that is a subsegment of the corridor is not a conflict', () => {
  // "Paso del Toro - Veracruz" es un tramo de "Cordoba - Veracruz".
  assert.equal(inv.nameAgreement('Córdoba - Veracruz', ['Paso del Toro - Veracruz']), 'shares_toponym');
  // Mismo corredor, direccion invertida.
  assert.equal(inv.nameAgreement('Gómez Palacio - Jiménez', ['Jiménez - Gómez Palacio']), 'shares_toponym');
});

test('an unrelated plaza section is reported as different, never silently equal', () => {
  assert.equal(inv.nameAgreement('Acatlán de Juárez - El Trapiche', ['Atoyac - Ciudad Guzmán']), 'different');
  assert.equal(inv.nameAgreement('Kantunil - Cancún', ['Kantunil - Valladolid']), 'shares_toponym');
  assert.equal(inv.nameAgreement('Mérida - Cancún', ['Kantunil - Pisté', 'Pisté - Valladolid']), 'different');
});

test('an exact section match wins over a partial one', () => {
  assert.equal(inv.nameAgreement('Cerritos - Rioverde',
    ['Ent. Cerritos - Ent. Villa Juárez', 'Cerritos - Rioverde']), 'exact');
});

test('a chain with no plaza on its road ids is reported as silent, not as passing', () => {
  const byCode = inv.indexByCode([{ idRed: 5, code: '150', names: [], sections: ['A - B'], plazaIds: [1] }]);
  const result = inv.checkChain(chain('150', 'Otro tramo', [7, 8]), byCode);
  assert.equal(result.verdict, 'no_plaza_on_road_ids');
  assert.equal(result.posts, 2);
});

test('a plaza on a road id of another code never corroborates this chain', () => {
  const byCode = inv.indexByCode([{ idRed: 7, code: '80', names: [], sections: ['A - B'], plazaIds: [1] }]);
  assert.equal(inv.checkChain(chain('150', 'A - B', [7, 8]), byCode).verdict, 'no_plaza_on_road_ids');
});

test('checkChain reports sections and plazas so a conflict is actionable', () => {
  const byCode = inv.indexByCode([
    { idRed: 7, code: '54', names: [], sections: ['Atoyac - Ciudad Guzmán'], plazaIds: [730, 731] }
  ]);
  const result = inv.checkChain(chain('54', 'Acatlán de Juárez - El Trapiche', [7, 7]), byCode);
  assert.equal(result.verdict, 'different');
  assert.deepEqual(result.sections, ['Atoyac - Ciudad Guzmán']);
  assert.deepEqual(result.plazaIds, [730, 731]);
  // La cadena no se toca: el invariante no modifica la geometria.
  assert.equal(result.posts, 2);
});

test('a plaza with N/D section cannot be compared and is not counted as agreement', () => {
  const byCode = inv.indexByCode([{ idRed: 7, code: '15', names: [], sections: [], plazaIds: [1] }]);
  const result = inv.checkChain(chain('15', 'A - B', [7]), byCode);
  assert.equal(result.verdict, 'no_section_declared');
  assert.equal(inv.summarize([result]).verdicts.no_section_declared, 1);
});

test('summarize separates the chains the invariant is silent about', () => {
  const byCode = inv.indexByCode([
    { idRed: 1, code: '150', names: [], sections: ['A - B'], plazaIds: [1] },
    { idRed: 2, code: '54', names: [], sections: ['X - Y'], plazaIds: [2] }
  ]);
  const results = [
    inv.checkChain(chain('150', 'A - B', [1, 1, 1]), byCode),
    inv.checkChain(chain('54', 'A - B', [2, 2]), byCode),
    inv.checkChain(chain('37', 'A - B', [9]), byCode)
  ];
  const s = inv.summarize(results);
  assert.equal(s.chains, 3);
  assert.equal(s.posts, 6);
  assert.equal(s.verdicts.exact, 1);
  assert.equal(s.verdicts.different, 1);
  assert.equal(s.verdicts.no_plaza_on_road_ids, 1);
  assert.equal(s.coveredByPlaza, 2);
});
