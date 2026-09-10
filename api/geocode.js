// Geocodificación segura para Nexus Vial.
// GOOGLE_MAPS_API_KEY vive únicamente en Vercel; nunca llega al navegador.

const MAX_PER_MIN = 30;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const rate = new Map();
const cache = new Map();

function remoteIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'anon';
}

function rateLimited(ip) {
  const now = Date.now();
  const cur = rate.get(ip) || { n: 0, t: now };
  if (now - cur.t > 60000) { cur.n = 0; cur.t = now; }
  cur.n += 1; rate.set(ip, cur);
  return cur.n > MAX_PER_MIN;
}

function confidenceFor(result) {
  const kind = result && result.geometry && result.geometry.location_type;
  let score = ({ ROOFTOP: 0.97, RANGE_INTERPOLATED: 0.90, GEOMETRIC_CENTER: 0.82, APPROXIMATE: 0.55 }[kind] || 0.50);
  if (result && result.partial_match) score -= 0.20;
  return Math.max(0.20, score);
}

function pruneCache() {
  if (cache.size < 500) return;
  const now = Date.now();
  for (const [key, value] of cache) if (now - value.time > CACHE_TTL) cache.delete(key);
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'método no permitido' });

  const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  const appToken = String(process.env.APP_TOKEN || '');
  if (req.query && req.query.check === '1') return res.status(200).json({ available: !!key, provider: key ? 'google' : 'fallback' });
  if (!key) return res.status(503).json({ error: 'google_no_configurado', fallback: true });
  if (appToken && req.headers['x-app-token'] !== appToken) return res.status(403).json({ error: 'token de acceso requerido' });
  if (rateLimited(remoteIp(req))) return res.status(429).json({ error: 'demasiadas peticiones' });

  const query = String((req.query && req.query.q) || '').replace(/\s+/g, ' ').trim();
  const snap = String((req.query && req.query.snap) || '') === '1';
  if (query.length < 3 || query.length > 240) return res.status(400).json({ error: 'consulta inválida' });

  const cacheKey = `${snap ? '1' : '0'}:${query.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.time < CACHE_TTL) return res.status(200).json({ ...hit.data, cached: true });

  try {
    const geoUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    geoUrl.searchParams.set('address', query);
    geoUrl.searchParams.set('components', 'country:MX');
    geoUrl.searchParams.set('language', 'es');
    geoUrl.searchParams.set('region', 'mx');
    geoUrl.searchParams.set('key', key);
    const upstream = await fetch(geoUrl, { headers: { Accept: 'application/json' } });
    const body = await upstream.json();
    if (!upstream.ok || body.status === 'REQUEST_DENIED') return res.status(502).json({ error: 'google_rechazado', providerStatus: body.status });
    const result = body.results && body.results[0];
    if (!result) return res.status(404).json({ error: 'sin_resultados', providerStatus: body.status });

    let lat = Number(result.geometry.location.lat);
    let lon = Number(result.geometry.location.lng);
    let confidence = confidenceFor(result);
    let roadSnapped = false;

    // No ajustar resultados muy aproximados: podría elegir una carretera equivocada.
    if (snap && confidence >= 0.75) {
      const roadsUrl = new URL('https://roads.googleapis.com/v1/nearestRoads');
      roadsUrl.searchParams.set('points', `${lat},${lon}`);
      roadsUrl.searchParams.set('key', key);
      const roadsResponse = await fetch(roadsUrl, { headers: { Accept: 'application/json' } });
      if (roadsResponse.ok) {
        const roads = await roadsResponse.json();
        const point = roads.snappedPoints && roads.snappedPoints[0];
        if (point && point.location) {
          lat = Number(point.location.latitude); lon = Number(point.location.longitude);
          roadSnapped = true; confidence = Math.max(confidence, 0.86);
        }
      }
    }

    const data = {
      lat, lon,
      provider: 'google',
      formatted_address: result.formatted_address || query,
      location_type: result.geometry.location_type || 'APPROXIMATE',
      partial_match: !!result.partial_match,
      road_snapped: roadSnapped,
      confidence: Number(confidence.toFixed(2))
    };
    pruneCache(); cache.set(cacheKey, { time: Date.now(), data });
    return res.status(200).json(data);
  } catch (error) {
    return res.status(502).json({ error: 'proveedor_no_disponible', fallback: true });
  }
};
