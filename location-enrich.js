/* Enrichment only from reviewed references. Never replaces an existing pin. */
(function(root) {
  'use strict';
  const TTL = 5 * 60 * 1000, MAX_CACHE = 500;
  const clean = value => String(value ?? '').trim();
  function hasCoordinates(a) {
    return ['latitude','longitude','lat','lon'].some(k => a[k] != null && clean(a[k]) !== '');
  }
  function requestFor(a) {
    if (!a || hasCoordinates(a)) return null;
    const road=clean(a.road || a.road_name), state=clean(a.state);
    const value=a.kilometer ?? a.km;
    const km=value == null || clean(value)==='' ? null : Number(value);
    if (!road || !state || (km != null && (!Number.isFinite(km) || km < 0))) return null;
    const reference=clean(a.location_label || a.location);
    if (km == null) return null;
    return {road,state,km,reference,municipality:clean(a.municipality)};
  }
  function createEnricher(fetcher, now=Date.now) {
    const cache = new Map(), inFlight = new Map();
    return async function enrich(input) {
      const request=requestFor(input);
      if (!request) return null;
      const key=JSON.stringify(request), existing=cache.get(key);
      if(existing && now()-existing.at<TTL) return existing.result;
      if(inFlight.has(key)) return inFlight.get(key);
      const task=Promise.resolve().then(async()=>{
        try {
          const params=new URLSearchParams({road:request.road,state:request.state,reference:request.reference});
          if(request.km != null) params.set('km',String(request.km));
          const response=await fetcher('/api/location-reference?'+params,{signal:AbortSignal.timeout(10000)});
          if(!response.ok) return null;
          const p=await response.json();
          if(!p || !['kilometer_rnc','kilometer_rnc_estimated','toll_reference'].includes(p.precision) || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || !Number.isFinite(p.confidence) || p.confidence<0 || p.confidence>1 || p.latitude<14 || p.latitude>33 || p.longitude < -119 || p.longitude > -86) return null;
          return p;
        } catch (_) { return null; }
      }).then(result=>{
        cache.set(key,{at:now(),result});
        if(cache.size>MAX_CACHE) cache.delete(cache.keys().next().value);
        return result;
      }).finally(()=>inFlight.delete(key));
      inFlight.set(key,task);
      return task;
    };
  }
  const api={hasCoordinates,requestFor,createEnricher};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  else root.enrichAlertLocationSafe=createEnricher(root.fetch.bind(root));
})(typeof globalThis!=='undefined'?globalThis:this);
