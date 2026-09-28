'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRncPost } = require('./rnc-km-anchors');

test('matches only reviewed route and exact kilometre', () => {
  const colima=resolveRncPost('Autopista Guadalajara - Colima',117);
  assert.equal(colima.source_post_id,40870);
  assert.equal(colima.precision,'kilometer_rnc');
  assert.equal(colima.status,'approximate');
  assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',229).source_post_id,5725);
  assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',228),null);
  assert.equal(resolveRncPost('Carretera libre Guadalajara - Colima',117),null);
  assert.equal(resolveRncPost('Carretera Federal 54 Guadalajara - Colima',117),null);
  assert.equal(resolveRncPost('Autopista Córdoba - Veracruz',229),null);
  assert.equal(resolveRncPost('Autopista Guadalajara - Colima',117.5),null);
});
