'use strict';
const {resolveRncPost,resolveRncEstimatedKm}=require('../worker/rnc-km-anchors');
function resolveReference(q) {
  const road=String(q.road||'').trim(), state=String(q.state||'').trim();
  if(!road || !state || road.length>200 || state.length>80) return null;
  if(q.km != null && String(q.km).trim()!=='') {
    if(!/^\d{1,3}(?:\.\d{1,3})?$/.test(String(q.km))) return null;
    const km=Number(q.km);
    return resolveRncPost(road,km,state) || resolveRncEstimatedKm(road,km,state);
  }
  return null;
}
module.exports=async(req,res)=>{
  if(req.method!=='GET') return res.status(405).json({error:'method_not_allowed'});
  res.setHeader('Cache-Control','public, max-age=300');
  const point=resolveReference(req.query||{});
  return point ? res.status(200).json(point) : res.status(404).json({error:'no_reviewed_reference'});
};
module.exports.resolveReference=resolveReference;
