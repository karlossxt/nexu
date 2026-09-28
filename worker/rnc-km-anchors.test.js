'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRncPost, resolveRncEstimatedKm } = require('./rnc-km-anchors');
const reviewed150D = require('./rnc-150d-reviewed.json');

test('matches only reviewed route and exact kilometre', () => {
  const colima=resolveRncPost('Autopista Guadalajara - Colima',117);
  assert.equal(colima.source_post_id,40870);
  assert.equal(colima.precision,'kilometer_rnc');
  assert.equal(colima.status,'approximate');
  assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',229).source_post_id,5725);
  assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',229,'Puebla'),null);
  assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',229,'Veracruz').source_post_id,5725);
  assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',228),null);
  assert.equal(resolveRncPost('Carretera libre Guadalajara - Colima',117),null);
  assert.equal(resolveRncPost('Carretera Federal 54 Guadalajara - Colima',117),null);
  assert.equal(resolveRncPost('Autopista Córdoba - Veracruz',229),null);
  assert.equal(resolveRncPost('Autopista Guadalajara - Colima',117.5),null);
});

test('150D reviewed posts use the original reference point and its state', () => {
  assert.equal(reviewed150D.length,23);
  assert.equal(new Set(reviewed150D.map(p=>p.km)).size,reviewed150D.length);
  for(const post of reviewed150D) {
    const found=resolveRncPost('Autopista Acatzingo - Cd. Mendoza',post.km,post.state);
    assert.equal(found?.source_post_id,post.sourcePostId,`km ${post.km}`);
    assert.equal(found?.latitude,post.lat);
    assert.equal(found?.longitude,post.lon);
    assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',post.km,post.state==='Puebla'?'Veracruz':'Puebla'),null);
  }
  for(const km of [202,207,210,223,224,225,226,228,231,232,235,240]) {
    assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',km),null,`km ${km} remains unlocated`);
  }
  assert.equal(resolveRncPost('Carretera libre Acatzingo - Cd. Mendoza',220),null);
  assert.equal(resolveRncPost('Autopista Cd. Mendoza - Córdoba',220),null);
});

test('54D short-gap estimates never pose as official posts',()=>{
  const km104=resolveRncEstimatedKm('Autopista Guadalajara - Colima',104,'Jalisco');
  const km105=resolveRncEstimatedKm('Autopista Guadalajara - Colima',105);
  assert.equal(km104.precision,'kilometer_rnc_estimated');
  assert.deepEqual(km104.source_post_ids,[40864,40865]);
  assert.equal(km104.latitude,19.559756961439334);
  assert.equal(km105.longitude,-103.43525405303387);
  assert.equal(resolveRncPost('Autopista Guadalajara - Colima',104),null);
  for(const km of [101,102,103,106,108,117]) assert.equal(resolveRncEstimatedKm('Autopista Guadalajara - Colima',km),null);
  assert.equal(resolveRncEstimatedKm('Carretera libre Guadalajara - Colima',104),null);
  assert.equal(resolveRncEstimatedKm('Autopista Guadalajara - Colima',104,'Colima'),null);
  assert.equal(resolveRncEstimatedKm('Autopista Acatzingo - Cd. Mendoza',104),null);
});
