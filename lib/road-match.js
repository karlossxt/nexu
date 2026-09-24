// Utilidades compartidas de geocodificación vial para Zero Vial.
// Usadas tanto por api/geocode.js como por worker/index.js.
// Mantener esta lógica en un solo lugar evita que ambas rutas diverjan.

function geoDistanceKm(aLat, aLon, bLat, bLon) {
  const r = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const x = Math.sin(dLat/2) ** 2 + Math.cos(aLat*Math.PI/180) * Math.cos(bLat*Math.PI/180) * Math.sin(dLon/2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
}

function normalizeRoad(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(carretera|autopista|federal|mexico|mex|ruta|libre|cuota|hacia|sentido|km|kilometro)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roadTokens(value) {
  return new Set(normalizeRoad(value).split(' ').filter(token => token.length >= 2));
}

function roadMatches(expected, resolved) {
  const a = normalizeRoad(expected), b = normalizeRoad(resolved);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const an = (a.match(/\b\d+[a-z]?\b/g) || []);
  const bn = new Set(b.match(/\b\d+[a-z]?\b/g) || []);
  if (an.some(token => bn.has(token))) return true;

  const aa = roadTokens(a), bb = roadTokens(b);
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;
  return common >= 2 || (common >= 1 && Math.min(aa.size, bb.size) <= 2);
}

async function reverseGoogleRoad(lat, lon, key, { onError } = {}) {
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${lat},${lon}`);
    url.searchParams.set('language', 'es');
    url.searchParams.set('region', 'mx');
    url.searchParams.set('key', key);

    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status === 'REQUEST_DENIED') return '';

    for (const result of body.results || []) {
      const route = (result.address_components || []).find(c => (c.types || []).includes('route'));
      if (route && route.long_name) return route.long_name;
    }
    return '';
  } catch (error) {
    if (typeof onError === 'function') onError(error);
    return '';
  }
}

module.exports = { geoDistanceKm, normalizeRoad, roadTokens, roadMatches, reverseGoogleRoad };
