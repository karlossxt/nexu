'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {requestFor,createEnricher}=require('../location-enrich');
const {resolveReference}=require('../api/location-reference');
const base={road:'Autopista La Pera - Cuautla',km:6,state:'Morelos',location:'km 6'};
test('existing and partial coordinates are never enriched',()=>{
 for(const field of ['latitude','longitude','lat','lon']) assert.equal(requestFor({...base,[field]:19}),null);
 assert.equal(requestFor({...base,km:null}),null);
 assert.equal(requestFor({...base,state:''}),null);
});
test('only reviewed road, km and state resolve',()=>{
 assert.equal(resolveReference({road:base.road,km:'6',state:'Morelos'}).source_post_id,1422);
 for(const km of ['7','6.5','2024','-6']) assert.equal(resolveReference({road:base.road,km,state:'Morelos'}),null);
 assert.equal(resolveReference({road:base.road,km:'6',state:'Sonora'}),null);
});
test('identical in-flight requests share work, references remain distinct, misses expire',async()=>{
 let calls=0,time=0;
 const enrich=createEnricher(async()=>{calls++;await Promise.resolve();return {ok:false}},()=>time);
 assert.deepEqual(await Promise.all([enrich(base),enrich(base)]),[null,null]);assert.equal(calls,1);
 await enrich(base);assert.equal(calls,1);
 await enrich({...base,location:'otro acceso'});assert.equal(calls,2);
 time=300001;await enrich(base);assert.equal(calls,3);
});
test('reviewed confidence is retained and arbitrary provider results are rejected',async()=>{
 const point=resolveReference({road:base.road,km:'6',state:'Morelos'});
 const enrich=createEnricher(async()=>({ok:true,json:async()=>point}));
 assert.equal((await enrich(base)).confidence,.78);
 const bad=createEnricher(async()=>({ok:true,json:async()=>({...point,precision:'road'})}));
 assert.equal(await bad(base),null);
});
