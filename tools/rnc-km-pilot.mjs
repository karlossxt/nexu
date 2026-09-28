#!/usr/bin/env node
// Pilot only: build an auditable anchor report. Nothing produced here is used by the worker.
import { readFileSync, writeFileSync } from 'node:fs';

const [roadsPath, postsPath, outputPath] = process.argv.slice(2);
if (!roadsPath || !postsPath || !outputPath) {
  console.error('Usage: node tools/rnc-km-pilot.mjs roads.geojson posts.geojson report.json');
  process.exit(2);
}
const routes = new Set(['54D', '150D']);
const get = (p, ...keys) => {
  const entries = Object.entries(p || {});
  for (const key of keys) {
    const hit = entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
    if (hit && hit[1] != null) return hit[1];
  }
  return null;
};
const code = value => {
  const match = String(value || '').toUpperCase().replace(/\s+/g, '').match(/(?:MEX[-.]?)?(150D|54D)(?!\d)/);
  return match?.[1] || null;
};
const lines = geometry => geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
const kmDistance = ([x,y],[a,b]) => {
  const r = Math.PI/180;
  const dy = (y-b)*111.195;
  const dx = (x-a)*111.195*Math.cos((y+b)*r/2);
  return Math.hypot(dx,dy);
};
const segmentDistance = (p,a,b) => {
  const lat=(p[1]+a[1]+b[1])/3*Math.PI/180;
  const scale= Math.cos(lat);
  const ax=a[0]*scale, bx=b[0]*scale, px=p[0]*scale;
  const dy=b[1]-a[1], dx=bx-ax;
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
  return kmDistance(p,[a[0]+t*(b[0]-a[0]),a[1]+t*dy]);
};
const distanceToLine = (p,coords) => {
  let best=Infinity;
  for(let i=1;i<coords.length;i++) best=Math.min(best,segmentDistance(p,coords[i-1],coords[i]));
  return best;
};
const fc = path => {
  const data=JSON.parse(readFileSync(path,'utf8'));
  if(data.type!=='FeatureCollection' || !Array.isArray(data.features)) throw Error(`${path}: expected GeoJSON FeatureCollection`);
  return data.features;
};
const roads=fc(roadsPath).flatMap((f,i) => {
  const route=code(get(f.properties,'Codigo','route','ref'));
  if(!routes.has(route)) return [];
  return lines(f.geometry).filter(pts=>pts.length>1).map((pts,j)=>({ route, id:get(f.properties,'Id_Red','id') ?? `${i}:${j}`, name:get(f.properties,'Nombre','name'), pts }));
});
const report={ source:{ roads:roadsPath, posts:postsPath }, status:'review_required', rules:{ maxRoadDistanceKm:0.15, duplicateRoadToleranceKm:0.03 }, routes:{'54D':[], '150D':[]}, rejected:[] };
for(const [i,f] of fc(postsPath).entries()) {
  const p=f.geometry?.type==='Point' ? f.geometry.coordinates : null;
  const km=Number(get(f.properties,'Km','Kilometro','kilometer'));
  if(!p || p.length<2 || !p.every(Number.isFinite) || !Number.isFinite(km) || km<0) continue;
  const explicit=code(get(f.properties,'Codigo','route','ref'));
  const nearby=roads.filter(r=>!explicit || r.route===explicit).map(r=>({r,d:distanceToLine(p,r.pts)})).sort((a,b)=>a.d-b.d);
  const nearest=nearby[0];
  if(!nearest || nearest.d>0.15) continue;
  // Same-code parallel carriageways remain ambiguous until reviewed.
  const ambiguous=nearby.some(x=>x!==nearest && x.r.route!==nearest.r.route && x.d-nearest.d<0.03);
  const entry={ km, coordinate:p, roadId:nearest.r.id, roadName:nearest.r.name, distanceToRoadM:Math.round(nearest.d*1000), sourcePostId:get(f.properties,'Id_Km','id') ?? i, review:ambiguous?'ambiguous_route':'pending' };
  report.routes[nearest.r.route].push(entry);
  if(ambiguous) report.rejected.push(entry);
}
for(const entries of Object.values(report.routes)) entries.sort((a,b)=>a.km-b.km);
report.summary=Object.fromEntries(Object.entries(report.routes).map(([route,entries])=>[route,{posts:entries.length,distinctKm:new Set(entries.map(x=>x.km)).size,duplicates:entries.length-new Set(entries.map(x=>x.km)).size,minKm:entries[0]?.km??null,maxKm:entries.at(-1)?.km??null}]));
writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.summary));
