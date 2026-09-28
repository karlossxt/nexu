'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolveOfficialTollReference,officialNameExists}=require('./rnc-toll-reference');

test('official Atizapán plaza resolves only on Chamapa–Lechería',()=>{
  const plaza=resolveOfficialTollReference('Plaza de Cobro Atizapán','Autopista Chamapa - Lechería');
  assert.deepEqual(plaza.source_plaza_ids,[730,731]);
  assert.equal(plaza.latitude,19.58254042);
  assert.equal(plaza.longitude,-99.27111721);
  assert.equal(plaza.precision,'toll_reference');
  assert.equal(plaza.status,'approximate');
  assert.equal(resolveOfficialTollReference('Plaza de Cobro Atizapán','Autopista Guadalajara - Colima'),null);
  assert.equal(officialNameExists('Plaza de Cobro Atizapán'),true);
});

test('same-named plazas on distinct corridors remain ambiguous without a road',()=>{
  const catalog=[
    {name:'La Joya',section:'Ruta Alfa - Beta',lat:19,lon:-99,sourceIds:[1]},
    {name:'La Joya',section:'Ruta Gamma - Delta',lat:20,lon:-100,sourceIds:[2]}
  ];
  assert.equal(resolveOfficialTollReference('Caseta La Joya','',catalog),null);
  assert.deepEqual(resolveOfficialTollReference('Caseta La Joya','Autopista Alfa - Beta',catalog)?.source_plaza_ids,[1]);
  assert.equal(resolveOfficialTollReference('Caseta La Joya','Autopista Beta - Delta',catalog),null);
});
