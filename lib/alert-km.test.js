'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {kilometersConflict}=require('./alert-km');

test('different reported kilometres cannot collapse at one orientative road point',()=>{
  assert.equal(kilometersConflict(27,102),true);
  assert.equal(kilometersConflict(27,27),false);
  assert.equal(kilometersConflict(27,28),false);
  assert.equal(kilometersConflict(null,102),false);
  assert.equal(kilometersConflict(undefined,0),false);
});
