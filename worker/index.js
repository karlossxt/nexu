'use strict';

const { createHash } = require('crypto');

const env = process.env;
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GROQ_API_KEY'];
const missing = REQUIRED.filter(key => !String(env[key] || '').trim());
if (missing.length) {
  console.error('[fatal] Faltan variables:', missing.join(', '));
  process.exit(1);
}

const SUPABASE_URL = env.SUPABASE_URL.replace(/\/$/, '');
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_KEY = env.GROQ_API_KEY;
const GROQ_MODEL = env.GROQ_MODEL || 'openai/gpt-oss-20b';
const GOOGLE_KEY = env.GOOGLE_MAPS_API_KEY || '';
const POLL_MS = Math.max(60_000, Number(env.WORKER_INTERVAL_MS) || 180_000);
const MAX_AGE_MS = Math.max(1, Number(env.ALERT_MAX_AGE_HOURS) || 24) * 3600_000;
const MAX_AI_PER_CYCLE = Math.max(1, Number(env.MAX_AI_PER_CYCLE) || 6);
const AI_DELAY_MS = Math.max(5_000, Number(env.AI_DELAY_MS) || 10_000);
const FEEDS = [env.RSS_PRI, env.RSS_SEC].map(x => String(x || '').trim()).filter(Boolean);
const DEFAULT_FEED = 'https://news.google.com/rss/search?q=accidente+OR+bloqueo+OR+asalto+carretera+mexico&hl=es-419&gl=MX&ceid=MX:es-419';
if (!FEEDS.length) FEEDS.push(DEFAULT_FEED);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (level, message, data) => console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...(data || {}) }));
const clean = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const tag = (regex, text) => (text.match(regex) || [,''])[1];
const decode = value => clean(String(value || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' '));

function itemDate(item) {
  const value = item.published_at || item.pubDate || item.date || item.published || item.updated;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function parseFeed(raw) {
  const text = raw.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    const list = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : data.data?.flatMap(x => x.items || []) || [];
    return list.map(item => ({
      title: clean(item.title || item.description_text),
      body: clean(item.description_text || item.description_html || item.description || item.content),
      source: clean(item.source_name || item.source || item.author),
      url: clean(item.url || item.link),
      published_at: itemDate(item)
    }));
  }
  const items = [];
  for (const match of text.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = match[0];
    items.push({
      title: decode(tag(/<title[^>]*>([\s\S]*?)<\/title>/i, block)),
      body: decode(tag(/<description[^>]*>([\s\S]*?)<\/description>/i, block)),
      source: decode(tag(/<(?:dc:creator|source|author)[^>]*>([\s\S]*?)<\/(?:dc:creator|source|author)>/i, block)),
      url: decode(tag(/<link[^>]*>([\s\S]*?)<\/link>/i, block)),
      published_at: itemDate({ pubDate: decode(tag(/<(?:pubDate|dc:date|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|dc:date|published|updated)>/i, block)) })
    });
  }
  return items;
}

const MX = ['mexico','cdmx','ciudad de mexico','estado de mexico','edomex','aguascalientes','baja california','campeche','chiapas','chihuahua','coahuila','colima','durango','guanajuato','guerrero','hidalgo','jalisco','michoacan','morelos','nayarit','nuevo leon','oaxaca','puebla','queretaro','quintana roo','san luis potosi','sinaloa','sonora','tabasco','tamaulipas','tlaxcala','veracruz','yucatan','zacatecas','guadalajara','monterrey','leon','toluca','pachuca','morelia'];
const INCIDENT = ['carretera','autopista','choque','accidente','volcadura','incendio','derrumbe','deslave','bloqueo','cierre','caseta','puente','inundacion','carril','trafico','trailer','asalto','balacera','manifestacion','operativo','km '];
const FOREIGN = ['venezuela','ecuador','espana','chile','argentina','colombia','peru','bolivia','honduras','guatemala','estados unidos','ucrania','israel','palestina'];

function relevant(item) {
  const text = norm(item.title + ' ' + item.body);
  if (item.title.length < 8 || item.body.length < 15) return false;
  const mx = MX.some(x => text.includes(x));
  const incident = INCIDENT.filter(x => text.includes(x)).length;
  const foreign = FOREIGN.some(x => text.includes(x));
  return incident >= 1 && (mx || incident >= 2) && !(foreign && !mx);
}

async function sb(path, options = {}) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error('Supabase ' + response.status + ': ' + (await response.text()).slice(0, 400));
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function alreadyExists(externalId) {
  const rows = await sb('alerts?external_id=eq.' + encodeURIComponent(externalId) + '&select=id&limit=1');
  return Array.isArray(rows) && rows.length > 0;
}

async function classify(text) {
  const prompt = `Clasifica esta noticia. Rechaza si no es un incidente vial o de seguridad en México o no incluye una ubicación útil. No inventes datos. Si rechazas, conserva los campos de texto vacíos. Resume el hecho sin agregar información. TEXTO: ${text.slice(0, 800)}`;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      reasoning_effort: 'minimal',
      max_completion_tokens: 700,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'alerta_vial',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              valido: { type: 'boolean' },
              ubicacion: { type: 'string' },
              carretera: { type: 'string' },
              kilometro: { type: ['number', 'null'] },
              municipio: { type: 'string' },
              estado: { type: 'string' },
              categoria: { type: 'string', enum: ['road', 'security'] },
              severidad: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              resumen: { type: 'string' },
              detail: { type: 'string' }
            },
            required: ['valido', 'ubicacion', 'carretera', 'kilometro', 'municipio', 'estado', 'categoria', 'severidad', 'resumen', 'detail']
          }
        }
      },
      messages: [
      { role: 'system', content: 'Eres analista de seguridad vial y logística en México.' },
      { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error('Groq ' + response.status + ': ' + (await response.text()).slice(0, 250));
  const data = await response.json();
  const message = data.choices?.[0]?.message || {};
  const raw = String(message.content || message.reasoning || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (!raw || start < 0 || end <= start) {
    throw new Error('Groq devolvió una respuesta vacía o sin JSON');
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error('Groq devolvió JSON inválido: ' + error.message);
  }
}

async function geocode(query, expectedState) {
  if (GOOGLE_KEY) {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('components', 'country:MX');
    url.searchParams.set('language', 'es');
    url.searchParams.set('region', 'mx');
    url.searchParams.set('key', GOOGLE_KEY);
    const response = await fetch(url);
    const body = await response.json();
    const result = body.results?.[0];
    if (result) {
      const type = result.geometry?.location_type || 'APPROXIMATE';
      const confidence = ({ ROOFTOP:.97, RANGE_INTERPOLATED:.9, GEOMETRIC_CENTER:.82, APPROXIMATE:.55 })[type] || .5;
      return { latitude:Number(result.geometry.location.lat), longitude:Number(result.geometry.location.lng), label:result.formatted_address, confidence, status:confidence >= .82 ? 'automatic' : 'approximate' };
    }
  }
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&addressdetails=1&q=' + encodeURIComponent(query + ', México');
  const response = await fetch(url, { headers: { 'User-Agent':'ZeroVial/1.0 contacto@zerovial.mx', 'Accept-Language':'es' } });
  const result = (await response.json())?.[0];
  if (!result) return null;
  const resolved = result.address?.state || '';
  if (expectedState && resolved && !norm(resolved).includes(norm(expectedState)) && !norm(expectedState).includes(norm(resolved))) return null;
  return { latitude:Number(result.lat), longitude:Number(result.lon), label:result.display_name, confidence:.62, status:'approximate' };
}

function sourceName(item, feed) {
  const raw = clean(item.source);
  const key = norm(raw);
  if (key.includes('capufe')) return 'CAPUFE';
  if (key.includes('guardia nacional')) return 'Guardia Nacional Carreteras';
  if (raw && !/rss\.app/i.test(raw)) return raw.slice(0, 80);
  if (norm(item.title).includes('capufe')) return 'CAPUFE';
  try { return new URL(feed).hostname.replace(/^www\./, ''); } catch { return 'Fuente RSS'; }
}

async function processItem(item, feed) {
  const externalId = hash(item.url || item.title + '|' + item.published_at);
  if (await alreadyExists(externalId)) return 'duplicate';
  const ai = await classify((item.title + '. ' + item.body).slice(0, 1400));
  if (!ai?.valido || !['road','security'].includes(ai.categoria)) return 'rejected';
  const title = clean(ai.resumen);
  const detail = clean(ai.detail);
  if (title.length < 8 || detail.length < 15) return 'rejected';
  const locationQuery = [ai.carretera, ai.kilometro != null ? 'km ' + ai.kilometro : '', ai.ubicacion, ai.municipio, ai.estado].filter(Boolean).join(', ');
  if (locationQuery.length < 4) return 'no_location';
  const geo = await geocode(locationQuery, ai.estado);
  if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return 'no_location';
  const eventAt = item.published_at && Date.now() - new Date(item.published_at).getTime() <= MAX_AGE_MS ? item.published_at : new Date().toISOString();
  const row = {
    external_id: externalId,
    title,
    detail,
    category: ai.categoria,
    severity: ['critical','high','medium','low'].includes(ai.severidad) ? ai.severidad : 'medium',
    state: clean(ai.estado) || null,
    municipality: clean(ai.municipio) || null,
    road: clean(ai.carretera) || null,
    kilometer: Number.isFinite(Number(ai.kilometro)) ? Number(ai.kilometro) : null,
    location_label: geo.label || locationQuery,
    latitude: geo.latitude,
    longitude: geo.longitude,
    location_confidence: geo.confidence,
    location_status: geo.status,
    source_name: sourceName(item, feed),
    source_url: item.url || null,
    event_at: eventAt
  };
  await sb('alerts?on_conflict=external_id', { method:'POST', headers:{ Prefer:'resolution=ignore-duplicates,return=minimal' }, body:JSON.stringify(row) });
  return 'inserted';
}

async function health(values) {
  try {
    await sb('worker_status?on_conflict=id', { method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body:JSON.stringify({ id:'main', updated_at:new Date().toISOString(), ...values }) });
  } catch (error) { log('error', 'No se pudo actualizar la salud', { error:error.message }); }
}

async function cycle() {
  const started = new Date().toISOString();
  const stats = { received:0, relevant:0, analyzed:0, inserted:0, duplicates:0, rejected:0, no_location:0, errors:0 };
  await health({ status:'running', last_started_at:started, last_error:null });
  try {
    const candidates = [];
    for (const feed of FEEDS) {
      const response = await fetch(feed, { headers:{ 'User-Agent':'Mozilla/5.0 (Zero Vial worker)' } });
      if (!response.ok) throw new Error('RSS ' + response.status + ' ' + feed);
      const items = parseFeed(await response.text()).slice(0, 40);
      stats.received += items.length;
      for (const item of items) {
        if (!relevant(item)) continue;
        const date = item.published_at ? new Date(item.published_at) : null;
        if (date && (Date.now() - date.getTime() > MAX_AGE_MS || date.getTime() - Date.now() > 30 * 60_000)) continue;
        candidates.push({ item, feed });
      }
    }
    stats.relevant = candidates.length;
    const unique = new Map(candidates.map(x => [x.item.url || x.item.title, x]));
    for (const { item, feed } of [...unique.values()].slice(0, MAX_AI_PER_CYCLE)) {
      const externalId = hash(item.url || item.title + '|' + item.published_at);
      if (await alreadyExists(externalId)) { stats.duplicates++; continue; }
      stats.analyzed++;
      try {
        const result = await processItem(item, feed);
        if (result === 'inserted') stats.inserted++;
        else if (result === 'no_location') stats.no_location++;
        else if (result === 'duplicate') stats.duplicates++;
        else stats.rejected++;
      } catch (error) {
        stats.errors++;
        log('error','Error procesando noticia',{ title:item.title.slice(0,80), error:error.message });
      }
      await sleep(AI_DELAY_MS);
    }
    await health({
      status: stats.errors > 0 ? 'error' : 'healthy',
      last_success_at: stats.errors < stats.analyzed ? new Date().toISOString() : null,
      last_stats: stats,
      last_error: stats.errors > 0 ? `${stats.errors} noticia(s) fallaron durante el análisis` : null
    });
    log('info','Ciclo completado',stats);
  } catch (error) {
    await health({ status:'error', last_error:error.message.slice(0,1000) });
    log('error','Ciclo fallido',{ error:error.message });
  }
}

async function main() {
  log('info','Worker Zero Vial iniciado',{ feeds:FEEDS.length, interval_ms:POLL_MS, model:GROQ_MODEL });
  await cycle();
  if (env.WORKER_ONCE === '1') return;
  setInterval(cycle, POLL_MS);
}

main().catch(error => { console.error(error); process.exit(1); });
