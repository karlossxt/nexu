// Prueba de integración de /api/agenda con Supabase simulado (sin red).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
process.env.SUPABASE_SERVICE_ROLE_KEY='svc'; process.env.SUPABASE_URL='https://fake.supabase.co';
let inserted=null;
const roles={'tok-op':'operator','tok-user':'user'};
global.fetch=async(url,opt={})=>{
  const auth=(opt.headers||{}).Authorization||'';
  if(url.endsWith('/auth/v1/user')){const t=auth.replace('Bearer ','');return roles[t]?{ok:true,json:async()=>({id:'u-'+t})}:{ok:false,json:async()=>({})};}
  if(url.includes('/rest/v1/profiles')){const id=decodeURIComponent(url.split('id=eq.')[1].split('&')[0]);return {ok:true,json:async()=>[{role:roles[id.slice(2)]}]};}
  if(url.includes('/rest/v1/alerts')){inserted=JSON.parse(opt.body);return {ok:true,text:async()=>''};}
  throw new Error('url inesperada '+url);
};
const handler=require('../api/agenda.js');
function call(body,token,ip='1.1.1.1'){return new Promise(resolve=>{
  const res={h:{},setHeader(k,v){this.h[k]=v},status(c){this.c=c;return this},json(o){resolve({code:this.c,body:o})}};
  handler({method:'POST',headers:{authorization:token?'Bearer '+token:'','x-forwarded-for':ip},body},res);
});}
test('api/agenda: auth, rol, publicación y anonimización', async () => {
  const text=fs.readFileSync(require('path').join(__dirname,'..','lib','fixtures','agenda-2026-10-23.txt'),'utf8');
  assert.equal((await call({action:'parse',text},null)).code,401);
  assert.equal((await call({action:'parse',text},'tok-bad')).code,401);
  assert.equal((await call({action:'parse',text},'tok-user')).code,403);
  const ok=await call({action:'parse',text},'tok-op');
  assert.equal(ok.code,200); assert.equal(ok.body.events.length,11);
  // publicar: forzamos "hoy" cambiando la fecha de los eventos a hoy (CDMX)
  const today=new Date(Date.now()-6*3600e3).toISOString().slice(0,10);
  const evs=ok.body.events.map((e,i)=>({...e,date:today,geo:i===0?{latitude:19.427,longitude:-99.1677,precision:'exact',confidence:.8}:null}));
  const pub=await call({action:'publish',events:evs,sourceUrl:'https://ssc.cdmx.gob.mx/x'},'tok-op');
  assert.equal(pub.code,200); assert.equal(pub.body.saved,11);
  assert.equal(inserted.length,11);
  assert.ok(inserted.every(r=>r.event_type==='scheduled_mobilization'&&r.source_name.startsWith('SSC CDMX')));
  assert.equal(inserted[0].latitude,19.427); assert.equal(inserted[1].location_status,'unlocated');
  // un cliente manipulado que intenta quitar la marca de sensible igual se anonimiza
  const tampered=ok.body.events.filter(e=>e.sensitive).map(e=>({...e,date:today,sensitive:false,publicName:e.name}));
  await call({action:'publish',events:tampered},'tok-op');
  assert.ok(inserted.every(r=>!/abuso|v[ií]ctima/i.test(r.title+r.detail)),'sensible no debe filtrarse');
  // fecha lejana rechazada, coordenadas fuera de México ignoradas
  assert.equal((await call({action:'publish',events:[{...evs[0],date:'2020-01-01'}]},'tok-op')).code,400);
  await call({action:'publish',events:[{...evs[0],geo:{latitude:40,longitude:-3}}]},'tok-op');
  assert.equal(inserted[0].latitude,null);
});
