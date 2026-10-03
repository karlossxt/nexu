'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {orientativeCorridorPoint}=require('./corridor-reference');

test('corridor point preserves only verified road identity, without claiming kilometre precision',()=>{
  const geo={latitude:15.8096872,longitude:-96.9902114,confidence:.74,route_verified:true,resolved_state:'Oaxaca'};
  const point=orientativeCorridorPoint('Autopista Barranca Larga - Ventanilla',geo);
  assert.equal(point.precision,'corridor_reference');
  assert.equal(point.confidence,.65);
  assert.equal(point.status,'approximate');
  assert.doesNotMatch(point.label,/km 27/);
  assert.equal(orientativeCorridorPoint('Autopista Barranca Larga - Ventanilla',{...geo,route_verified:false}),null);
  assert.equal(orientativeCorridorPoint('Autopista Barranca Larga - Ventanilla',{...geo,resolved_state:''}),null);
});
