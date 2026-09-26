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
    .replace(/\b(?:av|ave|avda)\.?\b/g, ' avenida ')
    .replace(/\b(?:blvd|bvd)\.?\b/g, ' boulevard ')
    .replace(/\b(?:perif|perifco)\.?\b/g, ' periferico ')
    .replace(/\bautop\.?\b/g, ' autopista ')
    .replace(/\b(?:calz)\.?\b/g, ' calzada ')
    .replace(/\b(?:carr)\.?\b/g, ' carretera ')
    .replace(/\b(carretera|autopista|federal|mexico|mex|ruta|libre|cuota|hacia|sentido|km|kilometro)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roadTokens(value) {
  return new Set(
    normalizeRoad(value)
      .split(' ')
      .filter(token => token.length >= 2)
      .filter(token => !/^\d+[a-z]?$/.test(token))
  );
}

function extractRouteCodes(value) {
  const text=String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/\bmex(?:ico)?[\s-]*/g,' ')
    .replace(/\b(?:carretera|autopista|federal|ruta|highway)[\s-]*/g,' ')
    .replace(/\b(\d{1,3})\s+([a-z])\b/g,'$1$2')
    .replace(/[^a-z0-9]+/g,' ');
  return [...new Set((text.match(/\b\d{1,3}[a-z]?\b/g) || []).map(code=>code.toUpperCase()))];
}

function routeFamily(code) {
  return String(code || '').toUpperCase().match(/^\d{1,3}/)?.[0] || '';
}

function roadMatches(expected, resolved) {
  const a = normalizeRoad(expected), b = normalizeRoad(resolved);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const expectedCodes=extractRouteCodes(expected);
  const resolvedCodes=extractRouteCodes(resolved);
  if(expectedCodes.length && resolvedCodes.length) {
    // Coincidencia exacta: MEX-57D, México 57D y Federal 57D son la misma ruta.
    if(expectedCodes.some(code=>resolvedCodes.includes(code))) return true;

    // No tratamos 57 y 57D como equivalentes por sí solos: pueden ser libre/cuota
    // o vías paralelas. Solo aceptamos la misma familia si además coinciden al
    // menos dos términos geográficos del corredor.
    const sameFamily=expectedCodes.some(code=>resolvedCodes.some(other=>routeFamily(code)===routeFamily(other)));
    if(sameFamily) {
      const aa=roadTokens(expected), bb=roadTokens(resolved);
      let shared=0;
      for(const token of aa) if(bb.has(token)) shared++;
      if(shared>=2) return true;
      return false;
    }

    // Si ambos textos traen número de ruta y son distintos, evitamos que nombres
    // parcialmente parecidos hagan aceptar una carretera equivocada.
    return false;
  }

  const aa = roadTokens(a), bb = roadTokens(b);
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;

  // Sin número de ruta exigimos una coincidencia nominal más fuerte.
  if(common >= 2) return true;
  if(common === 1 && Math.min(aa.size,bb.size)===1) return true;
  return false;
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

module.exports = { geoDistanceKm, normalizeRoad, roadTokens, extractRouteCodes, roadMatches, reverseGoogleRoad };
