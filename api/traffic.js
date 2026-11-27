// Proxy seguro para mosaicos de TomTom Traffic Flow.
// La clave vive exclusivamente en TOMTOM_API_KEY (Vercel).

const MAX_ZOOM = 22;
const MAX_PER_MIN = 240; // un mapa pide muchos mosaicos por minuto
const { sharedRateLimited } = require('../lib/shared-rate-limit');
const rate = new Map();

function remoteIp(req) {
  const fwd = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'anon';
}

function rateLimited(ip) {
  const now = Date.now();
  const cur = rate.get(ip) || { n: 0, t: now };
  if (now - cur.t > 60000) { cur.n = 0; cur.t = now; }
  cur.n += 1;
  rate.set(ip, cur);
  if (rate.size > 2000) {
    for (const [k, v] of rate) if (now - v.t > 120000) rate.delete(k);
    if (rate.size > 2000) rate.delete(rate.keys().next().value);
  }
  return cur.n > MAX_PER_MIN;
}

function validInteger(value, min, max) {
  return /^\d+$/.test(String(value)) && Number(value) >= min && Number(value) <= max;
}

function tileUrl(key, z, x, y) {
  return `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?tileSize=256&key=${encodeURIComponent(key)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'método no permitido' });
  const clientIp = remoteIp(req);
  if (rateLimited(clientIp) || await sharedRateLimited('traffic', clientIp, MAX_PER_MIN)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'demasiadas peticiones, espera un minuto' });
  }

  const key = (process.env.TOMTOM_API_KEY || '').trim();
  if (req.query && req.query.check === '1') {
    res.setHeader('Cache-Control', 'no-store');
    if (!key) return res.status(503).json({ available: false, reason: 'missing_key' });
    try {
      const probe = await fetch(tileUrl(key, 5, 7, 14), { headers: { Accept: 'image/png' }, signal: AbortSignal.timeout(8000) });
      if (!probe.ok) return res.status(503).json({ available: false, reason: probe.status === 403 ? 'key_forbidden' : 'provider_error', providerStatus: probe.status });
      return res.status(200).json({ available: true });
    } catch (error) {
      return res.status(503).json({ available: false, reason: 'provider_unreachable' });
    }
  }
  if (!key) return res.status(503).json({ error: 'tráfico no configurado' });

  const z = String((req.query && req.query.z) || '');
  const x = String((req.query && req.query.x) || '');
  const y = String((req.query && req.query.y) || '');
  if (!validInteger(z, 0, MAX_ZOOM)) return res.status(400).json({ error: 'zoom inválido' });
  const tileMax = Math.pow(2, Number(z)) - 1;
  if (!validInteger(x, 0, tileMax) || !validInteger(y, 0, tileMax)) return res.status(400).json({ error: 'mosaico inválido' });

  try {
    const upstream = await fetch(tileUrl(key, z, x, y), { headers: { Accept: 'image/png' }, signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'TomTom Traffic no disponible' });
    const image = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    return res.status(200).send(image);
  } catch (error) {
    return res.status(502).json({ error: 'no se pudo consultar TomTom Traffic' });
  }
};
