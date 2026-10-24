'use strict';

// Rellena el municipio de alertas históricas que ya tienen coordenadas pero
// fueron guardadas sin municipio. Por defecto solo muestra el resultado
// (dry-run). Para escribir en Supabase:
//
//   node tools/backfill-municipality.js --apply
//
// Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Usa Google o Geoapify si
// sus llaves están configuradas; si no, cae a Nominatim (1 request/segundo).
// No toca alertas sin coordenadas: esas necesitan resolver primero la vía/km.

const fs = require('fs');
const path = require('path');
const { normalizeStateKey } = require('../lib/state-match');
const { addressMunicipality, googleMunicipality, geoapifyMunicipality, isMunicipalityLike } = require('../lib/municipality');
const { stateFromPostalLabel } = require('../lib/postal-state');
const { geoDistanceKm, normalizeRoad } = require('../lib/road-match');
const RNC = require('../worker/rnc-loader');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const env = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    txt.split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    });
  } catch {}
  return Object.assign(env, process.env);
}

const ENV = loadEnv();
const SUPABASE_URL = String(ENV.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(ENV.SUPABASE_SERVICE_ROLE_KEY || '');
const GOOGLE_KEY = String(ENV.GOOGLE_MAPS_API_KEY || '');
const GEOAPIFY_KEY = String(ENV.GEOAPIFY_API_KEY || '');
const NOMINATIM_UA = String(ENV.NOMINATIM_USER_AGENT || 'ZeroVialBackfill/1.0 (https://zero-vial.com.mx)');

const args = process.argv.slice(2);
const hasFlag = name => args.includes('--' + name);
const option = (name, fallback) => {
  const item = args.find(arg => arg.startsWith('--' + name + '='));
  return item ? item.slice(name.length + 3) : fallback;
};

const numberOption = (name, fallback) => {
  const value = Number(option(name, fallback));
  return Number.isFinite(value) ? value : fallback;
};
const APPLY = hasFlag('apply');
const NO_LABEL = hasFlag('no-label');
const LIMIT = Math.max(1, numberOption('limit', 0) || Number.MAX_SAFE_INTEGER);
const OFFSET = Math.max(0, numberOption('offset', 0));
const PAGE_SIZE = Math.max(1, Math.min(500, numberOption('page-size', 250)));
const MAX_PRINT = Math.max(0, numberOption('max-print', 30));
const DELAY_MS = GOOGLE_KEY || GEOAPIFY_KEY
  ? Math.max(0, numberOption('delay', 100))
  : Math.max(1000, numberOption('delay', 1100));
const SINCE = option('since', '');
const ALLOW_UNVERIFIED_STATE = hasFlag('allow-unverified-state');
const ALLOW_VERIFIED_LOCATION = hasFlag('allow-verified-location');
const RNC_MAX_DISTANCE_KM = Math.max(0, numberOption('rnc-max-distance-km', 1));
const CACHE_PATH = option('cache', '');
const REPORT_PATH = option('report', '');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. Configúralas en .env o en el entorno.');
  process.exit(1);
}

const clean = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadGeoCache() {
  if (!CACHE_PATH) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))));
  } catch {
    return new Map();
  }
}

function saveGeoCache(cache) {
  if (!CACHE_PATH) return;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(cache), null, 2));
}

function usableMunicipality(value, state) {
  const municipality = clean(value);
  if (!municipality || !isMunicipalityLike(municipality)) return '';
  if (normalizeStateKey(municipality) === 'cdmx' && normalizeStateKey(state) === 'cdmx') return '';
  return municipality;
}

function rncVerification(row, lat, lon) {
  if (!row.road || row.kilometer == null) return { verified: false, distance: null, label: null };
  const km = Number(row.kilometer);
  if (!Number.isFinite(km)) return { verified: false, distance: null, label: null };
  const hit = RNC.resolveNetworkKilometer(row.road, km);
  if (!hit) return { verified: false, distance: null, label: null };
  const distance = geoDistanceKm(lat, lon, hit.latitude, hit.longitude);
  const hitRoad = String(hit.label || '').split(/\s*·\s*/)[0];
  const labelRoad = String(row.location_label || '').split(/\s*·\s*/)[0];
  const exactRoad = normalizeRoad(row.road) === normalizeRoad(hitRoad);
  const exactLabel = normalizeRoad(labelRoad) === normalizeRoad(hitRoad);
  return {
    verified: distance <= RNC_MAX_DISTANCE_KM && (exactRoad || exactLabel),
    distance,
    label: hit.label || null
  };
}

function stateFromGoogle(result = {}) {
  return clean(result.address_components?.find(item => item.types?.includes('administrative_area_level_1'))?.long_name);
}

async function sb(pathname, options = {}) {
  const response = await fetch(SUPABASE_URL + pathname, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase ${response.status}: ${body.slice(0, 300)}`);
  }
  return response;
}

async function fetchPage(offset, limit) {
  const params = new URLSearchParams({
    select: 'id,title,state,municipality,road,kilometer,location_label,latitude,longitude,event_at',
    municipality: 'is.null',
    latitude: 'not.is.null',
    longitude: 'not.is.null',
    order: 'event_at.desc',
    limit: String(limit),
    offset: String(offset)
  });
  if (SINCE) params.set('event_at', 'gte.' + SINCE);
  const response = await sb('/rest/v1/alerts?' + params.toString());
  return response.json();
}

async function reverseGoogle(lat, lon) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${lat},${lon}`);
  url.searchParams.set('language', 'es');
  url.searchParams.set('region', 'mx');
  url.searchParams.set('key', GOOGLE_KEY);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== 'OK') return null;
  for (const result of body.results || []) {
    const municipality = googleMunicipality(result);
    const state = stateFromGoogle(result);
    if (municipality || state) return { municipality, state, provider: 'google' };
  }
  return null;
}

async function reverseGeoapify(lat, lon) {
  const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('format', 'json');
  url.searchParams.set('lang', 'es');
  url.searchParams.set('limit', '1');
  url.searchParams.set('apiKey', GEOAPIFY_KEY);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  const result = body?.results?.[0];
  if (!response.ok || !result) return null;
  return {
    municipality: geoapifyMunicipality(result),
    state: clean(result.state),
    provider: 'geoapify'
  };
}

async function reverseNominatim(lat, lon) {
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&lat='
    + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon);
  const response = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_UA, 'Accept-Language': 'es', Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.address?.country_code !== 'mx') return null;
  return {
    municipality: addressMunicipality(body.address),
    state: clean(body.address?.state),
    provider: 'nominatim'
  };
}

async function reverseMunicipality(lat, lon) {
  if (GOOGLE_KEY) return reverseGoogle(lat, lon);
  if (GEOAPIFY_KEY) return reverseGeoapify(lat, lon);
  return reverseNominatim(lat, lon);
}

function proposedLabel(row, municipality) {
  const base = clean(row.location_label) || [row.road, row.state].map(clean).filter(Boolean).join(', ');
  if (!base || !municipality) return base;
  return norm(base).includes(norm(municipality)) ? base : base + ' · ' + municipality;
}

async function updateAlert(row, municipality, state) {
  const body = { municipality };
  if (!clean(row.state) && state) body.state = state;
  if (!NO_LABEL) {
    const label = proposedLabel(row, municipality);
    if (label && label !== clean(row.location_label)) body.location_label = label;
  }
  await sb('/rest/v1/alerts?id=eq.' + encodeURIComponent(row.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
}

async function main() {
  const provider = GOOGLE_KEY ? 'google' : GEOAPIFY_KEY ? 'geoapify' : 'nominatim';
  console.log(`Backfill de municipio (${APPLY ? 'APPLY' : 'dry-run'})`);
  console.log(`Proveedor: ${provider} · delay: ${DELAY_MS} ms · límite: ${LIMIT === Number.MAX_SAFE_INTEGER ? 'todos' : LIMIT}${SINCE ? ' · desde ' + SINCE : ''}`);
  if (CACHE_PATH) console.log(`Caché: ${CACHE_PATH}`);
  if (REPORT_PATH) console.log(`Reporte: ${REPORT_PATH}`);

  const geoCache = loadGeoCache();
  let cacheDirty = false;
  const report = [];
  let fetchOffset = OFFSET;
  let scanned = 0;
  let proposed = 0;
  let stateMatched = 0;
  let stateUnverified = 0;
  let labelStateMatched = 0;
  let rncVerified = 0;
  let stateMismatch = 0;
  let noMunicipality = 0;
  let updated = 0;
  let heldUnverifiedState = 0;
  let heldVerifiedLocation = 0;
  let failed = 0;
  let printed = 0;
  let reverseCalls = 0;
  let reusedPoints = 0;

  // Se recolectan todas las filas antes de escribir. Paginar con offset
  // mientras se actualiza municipality hace que las filas actualizadas
  // desaparezcan del filtro y el offset salte alertas pendientes.
  const pendingRows = [];
  while (pendingRows.length < LIMIT) {
    const limit = Math.min(PAGE_SIZE, LIMIT - pendingRows.length);
    const rows = await fetchPage(fetchOffset, limit);
    if (!Array.isArray(rows) || rows.length === 0) break;
    pendingRows.push(...rows);
    fetchOffset += rows.length;
    if (rows.length < limit) break;
  }
  for (const row of pendingRows) {
    scanned++;
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      noMunicipality++;
      report.push({ id:row.id, title:row.title, status:'invalid_coordinates' });
      continue;
    }
    try {
      // Varias alertas comparten el mismo punto (duplicados de fuentes o del
      // mismo tramo). Se resuelve una sola vez por coordenada.
      const cacheKey = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      let result;
      if (geoCache.has(cacheKey)) {
        result = geoCache.get(cacheKey);
        reusedPoints++;
      } else {
        result = await reverseMunicipality(lat, lon);
        geoCache.set(cacheKey, result);
        cacheDirty = true;
        reverseCalls++;
        if (DELAY_MS) await sleep(DELAY_MS);
      }

      const rowState = clean(row.state);
      const reverseState = clean(result?.state);
      const municipality = usableMunicipality(result?.municipality, rowState || reverseState);
      const mismatch = rowState && reverseState &&
        normalizeStateKey(rowState) !== normalizeStateKey(reverseState);
      const labelState = !rowState && reverseState ? stateFromPostalLabel(row.location_label) : '';
      const rnc = !rowState && reverseState && !mismatch
        ? rncVerification(row, lat, lon)
        : { verified: false, distance: null, label: null };
      // El código postal corrobora el estado, pero si la coordenada está lejos
      // del punto RNC de la vía/km declarados, no se usa como respaldo.
      const labelStateVerified = !!labelState &&
        normalizeStateKey(labelState) === normalizeStateKey(reverseState) &&
        (rnc.distance == null || rnc.distance <= RNC_MAX_DISTANCE_KM);
      const locationVerified = !rowState && !!reverseState && (labelStateVerified || rnc.verified);
      let status;
      let heldReason = '';
      let printedMessage = '';

      if (!municipality) {
        status = 'no_municipality';
        noMunicipality++;
        printedMessage = `- sin municipio  ${row.id}  ${clean(row.title).slice(0, 90)}`;
      } else if (mismatch) {
        status = 'state_mismatch';
        stateMismatch++;
        printedMessage = `! estado ${rowState} != ${reverseState} · ${municipality}  ${row.id}  ${clean(row.title).slice(0, 90)}`;
      } else {
        if (rowState) {
          status = 'state_matched';
          stateMatched++;
        } else if (labelStateVerified) {
          status = 'label_state_matched';
          labelStateMatched++;
        } else if (rnc.verified) {
          status = 'rnc_verified';
          rncVerified++;
        } else {
          status = 'state_unverified';
          stateUnverified++;
        }
        proposed++;
        printedMessage = `- ${municipality}${reverseState && !rowState ? ' · ' + reverseState : ''}  ${row.id}  ${clean(row.title).slice(0, 90)}`;
        if (APPLY) {
          const allowed = !!rowState || ALLOW_UNVERIFIED_STATE ||
            (ALLOW_VERIFIED_LOCATION && locationVerified);
          if (!allowed) {
            status = 'held_unverified_state';
            heldUnverifiedState++;
            if (locationVerified) heldVerifiedLocation++;
            heldReason = locationVerified ? 'verified_location_disabled' : 'state_unverified';
          } else {
            await updateAlert(row, municipality, reverseState);
            updated++;
          }
        }
      }

      report.push({
        id: row.id,
        title: row.title,
        road: row.road,
        kilometer: row.kilometer,
        row_state: rowState || null,
        reverse_state: reverseState || null,
        municipality: municipality || null,
        label_state: labelState || null,
        label_state_verified: labelStateVerified,
        rnc_verified: rnc.verified,
        rnc_distance_km: rnc.distance,
        rnc_label: rnc.label,
        held_reason: heldReason || null,
        status
      });
      if (printed < MAX_PRINT) {
        console.log(printedMessage);
        printed++;
      }
    } catch (error) {
      failed++;
      report.push({ id:row.id, title:row.title, status:'error', error:error.message });
      console.error(`! ${row.id}: ${error.message}`);
    }
  }

  if (cacheDirty) saveGeoCache(geoCache);
  if (REPORT_PATH) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }

  const wouldUpdate = stateMatched +
    (ALLOW_UNVERIFIED_STATE ? stateUnverified : 0) +
    ((ALLOW_UNVERIFIED_STATE || ALLOW_VERIFIED_LOCATION) ? labelStateMatched + rncVerified : 0);

  console.log('');
  console.log(JSON.stringify({
    scanned,
    proposed,
    state_matched: stateMatched,
    state_unverified: stateUnverified,
    label_state_matched: labelStateMatched,
    rnc_verified: rncVerified,
    state_mismatch: stateMismatch,
    no_municipality: noMunicipality,
    updated: APPLY ? updated : 0,
    held_unverified_state: heldUnverifiedState,
    held_verified_location: heldVerifiedLocation,
    would_update: APPLY ? 0 : wouldUpdate,
    rnc_max_distance_km: RNC_MAX_DISTANCE_KM,
    failed,
    reverse_calls: reverseCalls,
    points_reused: reusedPoints,
    dry_run: !APPLY,
    report: REPORT_PATH || undefined,
    hint: APPLY ? undefined : 'Ejecuta con --apply para escribir los cambios.'
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
