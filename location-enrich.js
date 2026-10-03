// Cache para enriquecer ubicaciones sin coordenadas (best-effort)
const locationEnrichCache = new Map();
const locationEnrichInFlight = new Map();

function locationEnrichKey(rowOrAlert) {
  const road = String(rowOrAlert.road || rowOrAlert.road_name || '').trim();
  const km = rowOrAlert.kilometer ?? rowOrAlert.km ?? null;
  const state = String(rowOrAlert.state || '').trim();
  const muni = String(rowOrAlert.municipality || '').trim();
  if (road && km != null && state) return `r:${road.toLowerCase()}|km:${km}|s:${state.toLowerCase()}`;
  if (road && km != null && muni) return `r:${road.toLowerCase()}|km:${km}|m:${muni.toLowerCase()}`;
  if (road && state) return `r:${road.toLowerCase()}|s:${state.toLowerCase()}`;
  const loc = String(rowOrAlert.location_label || rowOrAlert.location || '').trim();
  if (loc && state) return `l:${loc.toLowerCase()}|s:${state.toLowerCase()}`;
  return null;
}

async function enrichAlertLocationSafe(input) {
  const key = locationEnrichKey(input);
  if (!key) return null;
  if (locationEnrichCache.has(key)) return locationEnrichCache.get(key);
  if (locationEnrichInFlight.has(key)) return locationEnrichInFlight.get(key);

  const queryParts = [];
  if (input.road) queryParts.push(String(input.road));
  if (input.kilometer != null) queryParts.push(`km ${input.kilometer}`);
  if (input.location_label) queryParts.push(String(input.location_label));
  if (input.municipality) queryParts.push(String(input.municipality));
  if (input.state) queryParts.push(String(input.state));
  const query = queryParts.filter(Boolean).join(', ');

  const p = (async () => {
    try {
      const g = await geocodeBest(query, {
        expectedState: input.state || '',
        snapToRoad: true,
        countrycodes: 'mx'
      });
      if (!g) return null;
      const conf = Number(g.confidence || 0);
      if (conf < 0.58) return null;
      if (!isInMexico(g.lat, g.lon)) return null;
      const res = {
        lat: g.lat,
        lon: g.lon,
        confidence: Math.max(conf, 0.6),
        provider: g.provider || 'geocode',
        roadSnapped: !!g.roadSnapped,
        formattedAddress: g.formattedAddress || query
      };
      locationEnrichCache.set(key, res);
      return res;
    } catch (e) {
      return null;
    } finally {
      locationEnrichInFlight.delete(key);
    }
  })();

  locationEnrichInFlight.set(key, p);
  return p;
}
