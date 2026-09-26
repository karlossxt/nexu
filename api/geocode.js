// Geocodificacion segura para Zero Vial.
// Las llaves viven unicamente en Vercel y nunca llegan al navegador.

const { geoDistanceKm, normalizeRoad, roadMatches, reverseGoogleRoad } = require('../lib/road-match');
const { normalizeStateKey, stateMatches } = require('../lib/state-match');

const MAX_PER_MIN = 40;
const GLOBAL_MAX_PER_MIN = 320;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const rate = new Map();
const cache = new Map();
let globalRate = { n:0, t:Date.now() };

function validIp(value) {
  const ip=String(value||'').trim().replace(/^::ffff:/,'');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split('.').every(part=>Number(part)>=0 && Number(part)<=255) ? ip : '';
  }
  return /^[0-9a-f:]{2,45}$/i.test(ip) && ip.includes(':') ? ip.toLowerCase() : '';
}
function remoteIp(req) {
  // Vercel documenta x-vercel-forwarded-for como equivalente a la IP pública
  // y más estable cuando existe un proxy delante del deployment.
  const candidates = [
    req.headers['x-vercel-forwarded-for'],
    req.headers['x-forwarded-for'],
    req.headers['x-real-ip'],
    req.socket && req.socket.remoteAddress
  ];
  for (const raw of candidates) {
    const first=String(raw||'').split(',')[0].trim();
    const ip=validIp(first);
    if (ip) return ip;
  }
  return 'anon';
}
function rateLimited(ip) {
  const now = Date.now();
  if (now - globalRate.t > 60000) globalRate={n:0,t:now};
  globalRate.n += 1;
  if (globalRate.n > GLOBAL_MAX_PER_MIN) return true;

  const cur = rate.get(ip) || { n:0, t:now };
  if (now - cur.t > 60000) { cur.n=0; cur.t=now; }
  cur.n += 1;
  rate.set(ip, cur);

  // Evita crecimiento ilimitado del Map en instancias calientes.
  if (rate.size > 2000) {
    for (const [key,value] of rate) if (now - value.t > 120000) rate.delete(key);
    if (rate.size > 2000) rate.delete(rate.keys().next().value);
  }
  return cur.n > MAX_PER_MIN;
}
function clean(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function pruneCache() {
  if (cache.size < 500) return;
  const now = Date.now();
  for (const [key, value] of cache) if (now - value.time > CACHE_TTL) cache.delete(key);
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
}
function sendCached(res, cacheKey, data) {
  pruneCache();
  cache.set(cacheKey, { time: Date.now(), data });
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  return res.status(200).json(data);
}
function geoapifyConfidence(result) {
  const value = Number(result && result.rank && result.rank.confidence);
  return Number.isFinite(value) ? Math.max(.2, Math.min(.99, value)) : .62;
}
function normalizeGeoapify(result) {
  return {
    lat: Number(result.lat), lon: Number(result.lon), provider: 'geoapify',
    formatted_address: result.formatted || result.address_line2 || result.address_line1 || '',
    resolved_state: result.state || '',
    resolved_road: result.street || result.name || result.address_line1 || '',
    confidence: Number(geoapifyConfidence(result).toFixed(2)),
    location_type: result.result_type || result.category || 'APPROXIMATE',
    road_snapped: false
  };
}
async function requestGeoapify({ mode, query, lat, lon, limit, key }) {
  const endpoint = mode === 'reverse' ? 'reverse' : (mode === 'autocomplete' ? 'autocomplete' : 'search');
  const url = new URL(`https://api.geoapify.com/v1/geocode/${endpoint}`);
  if (mode === 'reverse') {
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
  } else {
    url.searchParams.set('text', query);
    url.searchParams.set('filter', 'countrycode:mx');
    url.searchParams.set('bias', 'countrycode:mx');
  }
  url.searchParams.set('format', 'json');
  url.searchParams.set('lang', 'es');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('apiKey', key);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`geoapify_${response.status}`);
  return Array.isArray(body.results) ? body.results : [];
}
function googleConfidence(result) {
  const kind = result && result.geometry && result.geometry.location_type;
  let score = ({ ROOFTOP: .97, RANGE_INTERPOLATED: .9, GEOMETRIC_CENTER: .82, APPROXIMATE: .55 }[kind] || .5);
  if (result && result.partial_match) score -= .2;
  return Math.max(.2, score);
}
async function requestGoogle(query, key) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('components', 'country:MX');
  url.searchParams.set('language', 'es');
  url.searchParams.set('region', 'mx');
  url.searchParams.set('key', key);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  const googleStatus=String(body.status || '');
  if (!response.ok || (googleStatus && !['OK','ZERO_RESULTS'].includes(googleStatus))) {
    throw new Error(`google_${googleStatus || response.status}`);
  }
  const result = body.results && body.results[0];
  if (!result) return null;
  const state = (result.address_components || []).find(c => (c.types || []).includes('administrative_area_level_1'));
  const route = (result.address_components || []).find(c => (c.types || []).includes('route'));
  return {
    lat: Number(result.geometry.location.lat), lon: Number(result.geometry.location.lng),
    provider: 'google', formatted_address: result.formatted_address || query,
    resolved_state: state && state.long_name || '',
    resolved_road: route && route.long_name || '',
    confidence: Number(googleConfidence(result).toFixed(2)),
    location_type: result.geometry.location_type || 'APPROXIMATE', road_snapped: false
  };
}
async function requestNominatim(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format','jsonv2');
  url.searchParams.set('addressdetails','1');
  url.searchParams.set('limit','1');
  url.searchParams.set('countrycodes','mx');
  url.searchParams.set('q',query);
  const response=await fetch(url,{
    headers:{
      'User-Agent':'ZeroVial/1.0 contacto@zerovial.mx',
      'Accept-Language':'es',
      Accept:'application/json'
    }
  });
  const body=await response.json().catch(()=>[]);
  if(!response.ok) throw new Error(`nominatim_${response.status}`);
  const result=Array.isArray(body) ? body[0] : null;
  if(!result) return null;
  const road=result.address?.road || result.address?.pedestrian || result.address?.motorway || result.address?.path || result.name || '';
  const state=result.address?.state || '';
  const roadTypes=new Set(['motorway','trunk','primary','secondary','tertiary','road','unclassified','residential']);
  const isRoad=roadTypes.has(String(result.type || '').toLowerCase());
  return {
    lat:Number(result.lat), lon:Number(result.lon), provider:'nominatim',
    formatted_address:result.display_name || query,
    resolved_state:state,
    resolved_road:road,
    confidence:isRoad ? .70 : .62,
    location_type:result.type || 'APPROXIMATE',
    road_snapped:false
  };
}

async function snapGoogleRoad(result, key, options={}) {
  if (!result) return result;
  const expectedRoad=clean(options.expectedRoad,120);
  const locationType=String(result.location_type || '').toUpperCase();
  if(expectedRoad && locationType==='GEOMETRIC_CENTER') {
    return { ...result, snap_rejected:'geometric_center' };
  }
  const minConfidence=expectedRoad ? .55 : .75;
  if(result.confidence < minConfidence) return result;
  const url = new URL('https://roads.googleapis.com/v1/nearestRoads');
  url.searchParams.set('points', `${result.lat},${result.lon}`);
  url.searchParams.set('key', key);
  const response = await fetch(url, { headers:{ Accept:'application/json' } });
  if (!response.ok) return result;
  const body = await response.json().catch(() => ({}));
  const point = body.snappedPoints && body.snappedPoints[0];
  if (!point || !point.location) return result;

  const snappedLat=Number(point.location.latitude), snappedLon=Number(point.location.longitude);
  const distanceKm=geoDistanceKm(result.lat,result.lon,snappedLat,snappedLon);
  const requestedMax=Number(options.maxDistanceKm)||.75;
  const maxDistanceKm=locationType==='APPROXIMATE' ? Math.min(requestedMax,.35) : requestedMax;
  if(!Number.isFinite(distanceKm) || distanceKm>maxDistanceKm) {
    return { ...result, snap_rejected:'distance', snap_distance_m:Number.isFinite(distanceKm)?Math.round(distanceKm*1000):null };
  }

  let resolvedRoad='';
  let routeVerified=false;
  if(expectedRoad) {
    resolvedRoad=await reverseGoogleRoad(snappedLat,snappedLon,key);
    routeVerified=roadMatches(expectedRoad,resolvedRoad);
    if(!routeVerified) {
      return {
        ...result,
        snap_rejected:'road_mismatch',
        snap_distance_m:Math.round(distanceKm*1000),
        expected_road:expectedRoad,
        resolved_road:resolvedRoad || null
      };
    }
  }

  return {
    ...result,
    lat:snappedLat,
    lon:snappedLon,
    road_snapped:true,
    route_verified:expectedRoad ? routeVerified : false,
    resolved_road:resolvedRoad || null,
    snap_distance_m:Math.round(distanceKm*1000)
  };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ error: 'metodo_no_permitido' });
  if (rateLimited(remoteIp(req))) {
    res.setHeader('Retry-After','60');
    res.setHeader('Cache-Control','no-store');
    return res.status(429).json({ error:'demasiadas_peticiones' });
  }

  const geoapifyKey = clean(process.env.GEOAPIFY_API_KEY, 200);
  const googleKey = clean(process.env.GOOGLE_MAPS_API_KEY, 200);
  const requestedMode = clean(req.query && req.query.mode, 20);
  const mode = ['search', 'autocomplete', 'reverse'].includes(requestedMode) ? requestedMode : 'search';

  if (req.query && req.query.check === '1') {
    return res.status(200).json({ available: true, provider: geoapifyKey ? 'geoapify' : (googleKey ? 'google' : 'nominatim') });
  }
  const query = clean(req.query && req.query.q);
  const expectedState = clean(req.query && req.query.state, 80);
  const expectedRoad = clean(req.query && req.query.road, 120);
  const snap = clean(req.query && req.query.snap, 2) === '1';
  const lat = Number(req.query && req.query.lat);
  const lon = Number(req.query && req.query.lon);
  const limit = mode === 'autocomplete' ? 5 : 1;
  if (mode === 'reverse') {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 14 || lat > 33.5 || lon < -119 || lon > -86) {
      return res.status(400).json({ error: 'coordenadas_invalidas' });
    }
  } else if (query.length < 3 || query.length > 240) {
    return res.status(400).json({ error: 'consulta_invalida' });
  }

  const cacheKey = mode === 'reverse' ? `reverse:${lat.toFixed(5)},${lon.toFixed(5)}` : `${mode}:${snap ? 'snap' : 'plain'}:${query.toLowerCase()}:${normalizeStateKey(expectedState)}:${normalizeRoad(expectedRoad)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.time < CACHE_TTL) return res.status(200).json({ ...hit.data, cached: true });

  try {
    let googleSnapError='';

    // Las correcciones de alertas conservan el ajuste a carretera de Google,
    // pero una caída/restricción de Google no debe tumbar todo /api/geocode.
    if (mode === 'search' && snap && googleKey) {
      try {
        let result = await requestGoogle(query, googleKey);
        if (result && (!expectedState || (result.resolved_state && stateMatches(expectedState, result.resolved_state)))) {
          result.state_filter_applied=!!expectedState;
          result.state_verified=!!expectedState && !!result.resolved_state && stateMatches(expectedState,result.resolved_state);
          result = await snapGoogleRoad(result, googleKey, { expectedRoad, maxDistanceKm:.75 });
          if(expectedRoad && (!result.road_snapped || !result.route_verified)) {
            return res.status(404).json({
              error:'snap_no_confiable',
              reason:result.snap_rejected || 'road_unverified',
              distance_m:result.snap_distance_m ?? null
            });
          }
          return sendCached(res, cacheKey, result);
        }
      } catch (error) {
        googleSnapError=String(error?.message || 'google_error').slice(0,80);
      }
    }

    let geoapifyError='';
    if (geoapifyKey) {
      try {
        const raw = await requestGeoapify({ mode, query, lat, lon, limit, key: geoapifyKey });
        const results = raw.map(normalizeGeoapify)
          .filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon))
          .filter(item => !expectedState || (!!item.resolved_state && stateMatches(expectedState, item.resolved_state)))
          .map(item => ({
            ...item,
            state_filter_applied:!!expectedState,
            state_verified:!!expectedState && !!item.resolved_state && stateMatches(expectedState,item.resolved_state),
            route_verified:!!expectedRoad && !!item.resolved_road && roadMatches(expectedRoad,item.resolved_road)
          }));
        if (results.length) {
          if(mode==='search' && snap) {
            const fallback={ ...results[0], snap_unavailable:true, snap_provider:'google', snap_error:googleSnapError || null };
            return sendCached(res, cacheKey, fallback);
          }
          const data = mode === 'autocomplete' ? { provider: 'geoapify', results } : results[0];
          return sendCached(res, cacheKey, data);
        }
      } catch(error) {
        geoapifyError=String(error?.message || 'geoapify_error').slice(0,80);
      }
    }

    if (mode !== 'search') {
      const reason=String(geoapifyError || 'geoapify_unavailable').toLowerCase().replace(/[^a-z0-9_]+/g,'_').slice(0,80);
      return res.status(503).json({ error:'modo_requiere_geoapify', provider:'geoapify', reason });
    }

    let googlePlainError=googleSnapError;
    if(googleKey) {
      try {
        const result = await requestGoogle(query, googleKey);
        if (result && (!expectedState || (result.resolved_state && stateMatches(expectedState, result.resolved_state)))) {
          result.state_filter_applied=!!expectedState;
          result.state_verified=!!expectedState && !!result.resolved_state && stateMatches(expectedState,result.resolved_state);
          result.route_verified=!!expectedRoad && !!result.resolved_road && roadMatches(expectedRoad,result.resolved_road);
          return sendCached(res, cacheKey, result);
        }
      } catch(error) {
        googlePlainError=String(error?.message || 'google_error').slice(0,80);
      }
    }

    try {
      const result=await requestNominatim(query);
      if(result && Number.isFinite(result.lat) && Number.isFinite(result.lon)) {
        const stateOk=!expectedState || (!!result.resolved_state && stateMatches(expectedState,result.resolved_state));
        if(stateOk) {
          result.state_filter_applied=!!expectedState;
          result.state_verified=!!expectedState && !!result.resolved_state && stateMatches(expectedState,result.resolved_state);
          result.route_verified=!!expectedRoad && !!result.resolved_road && roadMatches(expectedRoad,result.resolved_road);
          return sendCached(res, cacheKey, result);
        }
      }
    } catch(error) {
      // Nominatim es el último respaldo; si falla, conservamos el diagnóstico
      // de los proveedores con llave y devolvemos el error normal.
    }

    if(googlePlainError || geoapifyError) {
      const sanitize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9_]+/g,'_').slice(0,80);
      return res.status(503).json({
        error:'proveedores_no_disponibles',
        google:googlePlainError ? sanitize(googlePlainError) : null,
        geoapify:geoapifyError ? sanitize(geoapifyError) : null
      });
    }

    return res.status(404).json({ error:'sin_resultados' });
  } catch (error) {
    const reason=String(error?.message || 'provider_error').toLowerCase().replace(/[^a-z0-9_]+/g,'_').slice(0,80);
    return res.status(503).json({ error: 'proveedor_no_disponible', reason });
  }
};
