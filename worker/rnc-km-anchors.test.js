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

test('reviewed 95D and 91D posts resolve only exact road, km and compatible state',()=>{
  const cuernavaca=resolveRncPost('Autopista Cuernavaca - Acapulco',142,'Morelos');
  assert.equal(cuernavaca?.source_post_id,1510);
  assert.equal(cuernavaca?.precision,'kilometer_rnc');
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco',142,'Guerrero'),null);
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco',141),null);
  const ixtla=resolveRncPost('Autopista Puente de Ixtla - Iguala',48,'Guerrero');
  assert.equal(ixtla?.source_post_id,1317);
  assert.equal(resolveRncPost('Autopista Puente de Ixtla - Iguala',48,'Morelos'),null);
  assert.equal(resolveRncPost('Autopista Zacapalco - Rancho Viejo',8),null);
  assert.equal(resolveRncPost('Autopista Querétaro - Irapuato',63),null);
  assert.equal(resolveRncPost('Autopista Plan de Ayala - El Porvenir',48),null);
  assert.equal(resolveRncPost('Carretera libre Puente de Ixtla - Iguala',48),null);
  for(const [km,id] of [[247,1237],[248,1238],[249,1239],[250,1240]]) {
    const point=resolveRncPost('Autopista Cuernavaca - Acapulco',km,'Guerrero');
    assert.equal(point?.source_post_id,id);
    assert.equal(point?.precision,'kilometer_rnc');
    assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco',km,'Morelos'),null);
    assert.equal(resolveRncPost('Carretera libre Cuernavaca - Acapulco',km,'Guerrero'),null);
  }
  // El alcance de la revision manual llegaba hasta el km 250, y estos dos `null`
  // afirmaban ese limite, no un defecto de los postes. La promocion en bloque los
  // cubre ahora: son postes RNC del MISMO ID_RED que 247-250, con la misma geometria
  // y el mismo estado. Excluirlos para conservar el `null` abriria un hueco entre
  // km 245 y 252, que si resuelven, en medio de un corredor verificado.
  for(const [km,id] of [[246,1236],[251,1241]]) {
    const point=resolveRncPost('Autopista Cuernavaca - Acapulco',km,'Guerrero');
    assert.equal(point?.source_post_id,id);
    assert.equal(point?.precision,'kilometer_rnc');
    assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco',km,'Morelos'),null);
  }
  // El limite sigue existiendo, ahora donde de verdad esta: el tramo siguiente
  // (km 259 en adelante) no tiene poste RNC.
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco',259,'Guerrero'),null);
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco',245,'Guerrero')?.source_post_id,1235);
  assert.equal(resolveRncPost('Autopista Cuernavaca - Acapulco',252,'Guerrero')?.source_post_id,1242);
});

test('September 30 exact posts reject neighboring routes, states and fractional km',()=>{
  const cases=[
    ['Autopista México-Cuernavaca',63,'Morelos',1405],
    ['Autopista Cd Mendoza - Córdoba',282,'Veracruz',6261],
    ['Autopista Cd. Mendoza - Córdoba',285,'Veracruz',6259],
    ['Autopista Ciudad Mendoza - Córdoba',286,'Veracruz',6258],
    ['Autopista Cd. Mendoza - Córdoba',289,'Veracruz',6255],
    ['Autopista La Pera - Cuautla',6,'Morelos',1422],
    ['Autopista La Pera - Cuautla',25,'Morelos',1720],
    ['Autopista Nuevo Teapa - Cosoleacaque',7,'Veracruz',6658]
  ];
  for(const [road,km,state,id] of cases) {
    const found=resolveRncPost(road,km,state);
    assert.equal(found?.source_post_id,id);
    assert.equal(found?.status,'approximate');
    assert.equal(found?.uncertainty_m,1500);
    assert.equal(resolveRncPost(road,km,'Sonora'),null);
    assert.equal(resolveRncPost(road,km+.5,state),null);
    assert.equal(resolveRncPost('Carretera libre '+road,km,state),null);
  }
  assert.equal(resolveRncPost('Autopista Córdoba-Puebla',282,'Veracruz'),null);
  assert.equal(resolveRncPost('Autopista Acatzingo - Cd. Mendoza',282,'Veracruz'),null);
  assert.equal(resolveRncPost('Autopista Cd. Mendoza - Córdoba',297,'Veracruz'),null);
  assert.equal(resolveRncPost('Autopista Nuevo Teapa - Cosoleacaque',17,'Veracruz'),null);
});
