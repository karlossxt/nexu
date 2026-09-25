'use strict';

const { createHash } = require('crypto');
const { geoDistanceKm, roadMatches, reverseGoogleRoad } = require('../lib/road-match');
const RED_VIAL = require('./red-vial');
const CASETAS = require('./casetas');
const TOMTOM_TRAFFIC = require('./tomtom-traffic');

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
const GEMINI_KEY = env.GEMINI_API_KEY || '';
const GEMINI_MODEL = env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEOAPIFY_KEY = env.GEOAPIFY_API_KEY || '';
const GOOGLE_KEY = env.GOOGLE_MAPS_API_KEY || '';
const STRICT_LOCATION_MODE = String(env.STRICT_LOCATION_MODE || 'true').toLowerCase() !== 'false';
const POLL_MS = Math.max(60_000, Number(env.WORKER_INTERVAL_MS) || 60_000);
const MAX_AGE_MS = Math.max(1, Number(env.ALERT_MAX_AGE_HOURS) || 24) * 3600_000;
const MAX_AI_PER_CYCLE = Math.max(1, Number(env.MAX_AI_PER_CYCLE) || 6);
const AI_DELAY_MS = Math.max(5_000, Number(env.AI_DELAY_MS) || 10_000);
const AI_MAX_PER_HOUR = Math.max(1, Math.min(60, Number(env.AI_MAX_PER_HOUR) || 8));
const FAST_LANE_MAX_PER_HOUR = Math.max(0, Math.min(20, Number(env.FAST_LANE_MAX_PER_HOUR) || 6));
const FAST_LANE_MIN_INTERVAL_MS = Math.max(60_000, Number(env.FAST_LANE_MIN_INTERVAL_MS) || 120_000);
const AI_MIN_INTERVAL_MS = Math.ceil(3600_000 / AI_MAX_PER_HOUR);
const QUEUE_MAX_ATTEMPTS = Math.max(1, Number(env.QUEUE_MAX_ATTEMPTS) || 5);
const FEEDS = [env.RSS_PRI, env.RSS_SEC].map(x => String(x || '').trim()).filter(Boolean);
const DEFAULT_FEED = 'https://news.google.com/rss/search?q=accidente+OR+bloqueo+OR+asalto+carretera+mexico&hl=es-419&gl=MX&ceid=MX:es-419';
if (!FEEDS.length) FEEDS.push(DEFAULT_FEED);
const processedIds = new Map();
let groqCooldownUntil = 0;
let aiNextAllowedAt = 0;
let lastAiProvider = 'none';
let strictLocationRejects = Object.create(null);
let roadSnapMetrics = { attempted:0, success:0, rejected_distance:0, rejected_road_mismatch:0, reverse_failed:0 };
let fastLaneHistory = [];
let fastLaneLastAt = 0;

function noteStrictLocationReject(reason) {
  const key=String(reason || 'unknown');
  strictLocationRejects[key]=(strictLocationRejects[key] || 0) + 1;
}

class GroqRateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'GroqRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (level, message, data) => console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...(data || {}) }));
const clean = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const seenRecently = id => (processedIds.get(id) || 0) > Date.now();
const markProcessed = (id, ttl = MAX_AGE_MS) => processedIds.set(id, Date.now() + ttl);
const tag = (regex, text) => (text.match(regex) || [,''])[1];
const decode = value => clean(String(value || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' '));
const inMexico = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= 14.3 && lat <= 32.8 && lon >= -118.5 && lon <= -86.4;

function retryDelayMs(response, body) {
  const headerSeconds = Number(response.headers?.get?.('retry-after'));
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) return Math.ceil(headerSeconds * 1000);
  const match = String(body || '').match(/try again in\s+(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (match) {
    const milliseconds = ((Number(match[1]) || 0) * 60 + (Number(match[2]) || 0)) * 1000;
    if (milliseconds > 0) return Math.ceil(milliseconds);
  }
  return 10 * 60_000;
}

function stateKey(value) {
  const key = norm(value).replace(/\b(estado de|state of)\b/g, '').replace(/\s+/g, ' ').trim();
  const aliases = { 'ciudad de mexico':'cdmx', 'distrito federal':'cdmx', 'mexico':'edomex', 'estado mexico':'edomex', 'nuevo leon':'nuevo leon', 'michoacan de ocampo':'michoacan', 'veracruz de ignacio de la llave':'veracruz' };
  return aliases[key] || key;
}

function stateMatches(expected, resolved) {
  if (!expected || !resolved) return true;
  const a = stateKey(expected), b = stateKey(resolved);
  return a === b || a.includes(b) || b.includes(a);
}

function usableMunicipality(municipality, state) {
  const value = clean(municipality);
  if (!value) return '';
  // En CDMX, "Ciudad de México/CDMX/Distrito Federal" describe la entidad, no una alcaldía.
  // Mantenerlo como municipio hace que los geocodificadores tiendan al centro de la ciudad.
  if (stateKey(value) === 'cdmx' && stateKey(state) === 'cdmx') return '';
  return value;
}

function normalizedKilometer(value, text) {
  const source = `${value ?? ''} ${text || ''}`;
  const plus = source.match(/(?:km|kil[oó]metro)?\s*[:.]?\s*(\d{1,4})\s*\+\s*(\d{1,3})/i);
  if (plus) return Number(plus[1]) + Number(plus[2]) / 1000;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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
const INCIDENT = ['carretera','autopista','choque','accidente','volcadura','derrapado','atropellado','carambola','incendio','derrumbe','deslave','bloqueo','cierre','caseta','puente','inundacion','encharcamiento','socavon','carril','trafico','trailer','asalto','balacera','disparos','ataque armado','manifestacion','operativo','robo de vehiculo','km '];
const FOREIGN = ['venezuela','ecuador','espana','chile','argentina','colombia','peru','bolivia','honduras','guatemala','estados unidos','ucrania','israel','palestina'];
const PROMOTIONAL = ['vacante','bolsa de trabajo','oportunidad laboral','postulate','postúlate','envia tu cv','envía tu cv','contratacion','contratación','patrocinadores','siguiente paso en tu carrera','inscripciones abiertas','promocion','promoción','descuento','venta de boletos','siguenos','síguenos','unete a nuestro canal','únete a nuestro canal','canal de whatsapp','pacto contra la extorsion','pacto contra la extorsión'];
const LOCATION_SIGNAL = ['carretera','autopista','avenida',' av ','calzada','periferico','periférico','libramiento','boulevard','bulevar','calle','cruce','esquina','a la altura','colonia','alcaldia','alcaldía','municipio','entronque','caseta','puente','km ','kilometro','kilómetro'];
const IMPACT_SIGNAL = ['cierre total','cierre parcial','cierre de circulacion','cierre de circulación','bloqueo','bloqueada','bloqueado','interrumpido el paso','ambos sentidos','afectacion vial','afectación vial','precaucion vial','precaución vial','servicios de emergencia','transito lento','tránsito lento','reduccion de carriles','reducción de carriles'];
const LOW_VALUE = ['convivio','por sus medios','foto fotografia','photo photography'];

function relevanceScore(item) {
  const text = norm(item.title + ' ' + item.body);
  if (item.title.length < 8 || item.body.length < 15) return { score:-99, incident:0, location:0, impact:0, mx:false, foreign:false, promotional:false };
  const incident = INCIDENT.filter(x => text.includes(norm(x))).length;
  const location = LOCATION_SIGNAL.filter(x => text.includes(norm(x))).length;
  const impact = IMPACT_SIGNAL.filter(x => text.includes(norm(x))).length;
  const mx = MX.some(x => text.includes(x));
  const foreign = FOREIGN.some(x => text.includes(x));
  const promotional = PROMOTIONAL.some(x => text.includes(norm(x)));
  const lowValue = LOW_VALUE.some(x => text.includes(norm(x)));
  let score = incident * 3 + Math.min(location, 3) * 2 + Math.min(impact, 2) * 3;
  if (mx) score += 2;
  if (foreign && !mx) score -= 8;
  if (promotional) score -= 12;
  if (lowValue && impact === 0) score -= 4;
  // Una incidencia clara con ubicación explícita puede pasar aunque no mencione México:
  // p. ej. publicaciones locales de OVIAL o JaliscoRojo.
  return { score, incident, location, impact, mx, foreign, promotional };
}

function relevant(item) {
  const r = relevanceScore(item);
  if (r.promotional || (r.foreign && !r.mx)) return false;
  return r.incident >= 1 && r.score >= 5 && (r.mx || r.location >= 1 || r.impact >= 1 || r.incident >= 2);
}

function trustedRoadSource(item) {
  const source=norm(item?.source || '');
  const text=norm(`${item?.title || ''} ${item?.body || ''}`);
  return /capufe|guardia nacional|red via corta|redviacorta|ovial|c5\b|proteccion civil|secretaria de seguridad|autopista/.test(`${source} ${text}`);
}

function isFastLaneCandidate(item) {
  if (!GEMINI_KEY || FAST_LANE_MAX_PER_HOUR<=0) return false;
  const raw=`${item?.title || ''} ${item?.body || ''}`;
  const text=norm(raw);
  const incident=/accidente|choque|volcadura|cierre total|cierre parcial|bloqueo|incendio|derrumbe|inundacion|asalto|ataque armado/.test(text);
  if(!incident) return false;

  const road=/autopista|carretera|libramiento|caseta/.test(text);
  const km=/\bkm\s*\d{1,4}(?:\s*\+\s*\d{1,3})?\b/.test(text);
  if(trustedRoadSource(item) && road && km) return true;

  // Reportes ciudadanos también pueden saltar la cola cuando mencionan
  // una caseta explícita que sí existe en nuestro catálogo CASETAS.
  const tollReference=extractExplicitTollReference(raw);
  return !!resolveTollReference(tollReference);
}

function fastLaneAvailable() {
  const now=Date.now();
  fastLaneHistory=fastLaneHistory.filter(ts=>now-ts<3600_000);
  return fastLaneHistory.length<FAST_LANE_MAX_PER_HOUR && now-fastLaneLastAt>=FAST_LANE_MIN_INTERVAL_MS;
}

function markFastLaneUsed() {
  const now=Date.now();
  fastLaneHistory.push(now);
  fastLaneLastAt=now;
}

function incidentPriority(item) {
  const text = norm(`${item.title} ${item.body}`);
  const source = norm(item.source);
  let score = 0;
  if (/capufe|guardia nacional|proteccion civil|secretaria de seguridad|c5\b|red via corta|redviacorta|ovial/.test(`${source} ${text}`)) score += 8;
  if (/cierre total|cierre parcial|cierre de circulacion|bloqueo|balacera|asalto|ataque armado|enfrentamiento/.test(text)) score += 7;
  if (isFastLaneCandidate(item)) score += 20;
  if (/accidente|choque|volcadura|incendio|derrumbe|deslave|inundacion/.test(text)) score += 5;
  if (/autopista|carretera|km\s*\d|caseta/.test(text)) score += 3;
  const published = item.published_at ? new Date(item.published_at).getTime() : 0;
  if (Number.isFinite(published) && Date.now() - published < 90 * 60_000) score += 3;
  return score;
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

function dedupeTokens(value) {
  const stop=new Set(['para','por','con','sin','desde','hasta','sobre','entre','tras','ante','del','las','los','una','uno','unos','unas','que','esta','este','esto','como','más','mas','km','kilometro','kilómetro','carretera','autopista','avenida','calle']);
  return new Set(norm(value).split(/[^a-z0-9]+/).filter(token=>token.length>=3 && !stop.has(token)));
}

function textSimilarity(a,b) {
  const aa=dedupeTokens(a), bb=dedupeTokens(b);
  if (!aa.size || !bb.size) return 0;
  let common=0;
  for (const token of aa) if (bb.has(token)) common++;
  return common / Math.max(aa.size,bb.size);
}

function roadSimilarity(a,b) {
  const aa=roadKey(a), bb=roadKey(b);
  if (!aa || !bb) return false;
  return aa===bb || aa.includes(bb) || bb.includes(aa);
}

async function findSpatialDuplicate(row) {
  const eventTime=new Date(row.event_at || Date.now()).getTime();
  const since=new Date(eventTime - 2*3600_000).toISOString();
  const until=new Date(eventTime + 30*60_000).toISOString();
  const path='alerts?select=id,title,detail,event_type,category,road,kilometer,latitude,longitude,source_name,event_at,location_label'
    +'&category=eq.'+encodeURIComponent(row.category)
    +'&event_at=gte.'+encodeURIComponent(since)
    +'&event_at=lte.'+encodeURIComponent(until)
    +'&order=event_at.desc&limit=80';
  const recent=await sb(path) || [];
  for (const existing of recent) {
    const lat=Number(existing.latitude), lon=Number(existing.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distanceKm=geoDistanceKm(row.latitude,row.longitude,lat,lon);
    if (!Number.isFinite(distanceKm) || distanceKm>1.5) continue;

    const sameEvent=!!row.event_type && !!existing.event_type && row.event_type===existing.event_type;
    const sameRoad=roadSimilarity(row.road,existing.road);
    const kmA=Number(row.kilometer), kmB=Number(existing.kilometer);
    const sameKm=Number.isFinite(kmA) && Number.isFinite(kmB) && Math.abs(kmA-kmB)<=1;
    const similarity=textSimilarity(
      [row.title,row.detail,row.location_label].filter(Boolean).join(' '),
      [existing.title,existing.detail,existing.location_label].filter(Boolean).join(' ')
    );

    let duplicate=false;
    if (sameEvent && distanceKm<=0.25 && similarity>=0.20) duplicate=true;
    else if (sameEvent && sameRoad && distanceKm<=1.0 && similarity>=0.30) duplicate=true;
    else if (sameEvent && sameRoad && sameKm && distanceKm<=1.5) duplicate=true;
    else if (!existing.event_type && sameRoad && distanceKm<=0.5 && similarity>=0.48) duplicate=true;

    if (duplicate) {
      return {
        id:existing.id,
        distance_m:Math.round(distanceKm*1000),
        similarity:Number(similarity.toFixed(2)),
        same_road:sameRoad,
        same_km:sameKm,
        source:existing.source_name || null
      };
    }
  }
  return null;
}

async function enqueueCandidate(item, feed, priority) {
  const externalId = hash(item.url || item.title + '|' + item.published_at);
  await sb('ingest_queue?on_conflict=external_id', {
    method:'POST',
    headers:{ Prefer:'resolution=ignore-duplicates,return=minimal' },
    body:JSON.stringify({
      external_id:externalId,
      item,
      feed_url:feed,
      priority,
      published_at:item.published_at || new Date().toISOString()
    })
  });
  return externalId;
}

async function recoverStaleQueue() {
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  await sb(`ingest_queue?status=eq.processing&processing_started_at=lt.${encodeURIComponent(staleBefore)}`, {
    method:'PATCH',
    headers:{ Prefer:'return=minimal' },
    body:JSON.stringify({ status:'retry', next_attempt_at:new Date().toISOString(), processing_started_at:null, last_error:'Procesamiento interrumpido; recuperado automáticamente' })
  });
}

async function purgeExpiredQueue() {
  const oldestAllowed = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const removed = await sb(
    `ingest_queue?select=external_id&status=in.(pending,retry,processing)&published_at=lt.${encodeURIComponent(oldestAllowed)}`,
    {
      method:'DELETE',
      headers:{ Prefer:'return=representation' }
    }
  ) || [];
  const count = Array.isArray(removed) ? removed.length : 0;
  if (count) {
    log('info','Cola vencida depurada',{ removed:count, max_age_hours:Math.round(MAX_AGE_MS/3600000) });
  }
  return count;
}

async function queuedItems(limit) {
  const now = new Date().toISOString();
  const oldestAllowed = new Date(Date.now() - MAX_AGE_MS).toISOString();
  return await sb(`ingest_queue?select=external_id,item,feed_url,priority,published_at,attempts,enqueued_at&status=in.(pending,retry)&next_attempt_at=lte.${encodeURIComponent(now)}&published_at=gte.${encodeURIComponent(oldestAllowed)}&order=priority.desc,published_at.desc&limit=${limit}`) || [];
}

async function updateQueue(externalId, values) {
  await sb('ingest_queue?external_id=eq.' + encodeURIComponent(externalId), {
    method:'PATCH', headers:{ Prefer:'return=minimal' }, body:JSON.stringify({ ...values, updated_at:new Date().toISOString() })
  });
}

async function queueMetrics() {
  const rows = await sb('ingest_queue?select=status,enqueued_at&status=in.(pending,retry,processing,failed)&order=enqueued_at.asc&limit=1000') || [];
  const pending = rows.filter(row => ['pending','retry','processing'].includes(row.status));
  const oldest = pending[0]?.enqueued_at ? Math.max(0, Math.round((Date.now() - new Date(pending[0].enqueued_at).getTime()) / 60_000)) : 0;
  return { queue_pending:pending.length, queue_failed:rows.filter(row => row.status === 'failed').length, queue_oldest_min:oldest };
}

const GEMINI_ALERT_SCHEMA = {
  type:'OBJECT',
  properties:{
    valido:{type:'BOOLEAN'}, ubicacion:{type:'STRING',nullable:true}, carretera:{type:'STRING',nullable:true},
    kilometro:{type:'NUMBER',nullable:true}, referencia:{type:'STRING',nullable:true}, municipio:{type:'STRING',nullable:true}, estado:{type:'STRING',nullable:true},
    categoria:{type:'STRING',enum:['road','security','irrelevant']}, severidad:{type:'STRING',enum:['critical','high','medium','low']},
    event_type:{type:'STRING',enum:['traffic_update','crash','closure','blockage','protest','road_hazard','security_incident','emergency','other']},
    traffic_status:{type:'STRING',enum:['flowing','slow','partial','blocked','closed','restored','unknown']},
    resumen:{type:'STRING',nullable:true}, detail:{type:'STRING',nullable:true}, sentido:{type:'STRING',nullable:true}
  },
  required:['valido','ubicacion','carretera','kilometro','referencia','municipio','estado','categoria','severidad','event_type','traffic_status','resumen','detail','sentido']
};

function classificationPrompt(text) {
  return `Clasifica esta noticia. Rechaza si no es un incidente vial o de seguridad relacionado con calles, carreteras o movilidad en México, o si no incluye una ubicación útil. Una balacera, delito o emergencia dentro de una escuela, vivienda o inmueble sin afectación vial debe marcarse como irrelevante. Distingue el TIPO DE EVENTO de su ESTADO VIAL ACTUAL. event_type describe qué ocurrió; traffic_status describe cómo está la circulación AHORA. Si el texto actual dice "tránsito fluido", "circulación normal", "vía libre", "se restablece", "reabierta" o equivalente, usa flowing/restored aunque se mencione un bloqueo o cierre previo. Usa blocked/closed únicamente cuando el texto indique que la afectación sigue activa; partial para cierre/reducción parcial; slow para tránsito lento. Extrae el sentido de circulación cuando aparezca (por ejemplo: hacia Querétaro o dirección CDMX). Extrae también una referencia física explícita si aparece: caseta, plaza de cobro, entronque, puente, distribuidor vial, localidad, colonia o punto conocido cercano. Si la ubicación expresa un cruce o tramo entre dos vialidades (por ejemplo "Av. 608 hasta Av. 412", "entre X y Y", "esquina con", "cruce con" o "Rep. de Cuba a la altura de Héroes del 57"), conserva ambas vialidades en ubicacion; no reduzcas la ubicación a una sola calle. Convierte kilómetros con formato 66+500 a 66.5. No inventes datos ni coordenadas. Si rechazas usa valido=false, categoria=irrelevant y cadenas vacías cuando no exista el dato. Para resumen: escribe un titular operativo corto de 10 a 14 palabras, indicando qué ocurrió y el lugar principal. Para detail: amplía con carriles afectados, sentido, km, referencia, impacto o estado actual de circulación cuando esos datos existan; no repitas literalmente el resumen ni empieces detail copiando el resumen. Resume el hecho sin agregar información. TEXTO: ${text.slice(0, 800)}`;
}

async function classifyWithGroq(prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.1,
      reasoning_effort: 'low',
      max_completion_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
      { role: 'system', content: 'Eres analista de seguridad vial y logística en México. Devuelve únicamente un objeto JSON válido con todas las claves solicitadas.' },
      { role: 'user', content: prompt }
      ]
    })
  });
  const responseText = await response.text();
  if (response.status === 429) {
    throw new GroqRateLimitError('Groq alcanzó su límite temporal', retryDelayMs(response, responseText));
  }
  if (!response.ok) throw new Error('Groq ' + response.status + ': ' + responseText.slice(0, 250));
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (error) {
    throw new Error('Groq devolvió una respuesta no JSON: ' + responseText.slice(0, 120));
  }
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

async function classifyWithGemini(prompt) {
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`);
  url.searchParams.set('key', GEMINI_KEY);
  const response = await fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(35_000),
    body:JSON.stringify({
      systemInstruction:{parts:[{text:'Eres un analista de seguridad vial y logística en México. Devuelve únicamente datos sustentados por el texto.'}]},
      contents:[{role:'user',parts:[{text:prompt}]}],
      generationConfig:{temperature:.1,maxOutputTokens:700,responseMimeType:'application/json',responseSchema:GEMINI_ALERT_SCHEMA}
    })
  });
  const rawBody=await response.text();
  if(!response.ok) throw new Error('Gemini '+response.status+': '+rawBody.slice(0,250));
  let body;
  try { body=JSON.parse(rawBody); } catch { throw new Error('Gemini devolvió una respuesta no JSON'); }
  const raw=String(body.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('')||'').trim();
  if(!raw) throw new Error('Gemini devolvió una respuesta vacía');
  try { return JSON.parse(raw); } catch(error) { throw new Error('Gemini devolvió JSON inválido: '+error.message); }
}

async function classify(text, options={}) {
  const prompt=classificationPrompt(text);
  if(options.preferGemini && GEMINI_KEY) {
    try {
      const result=await classifyWithGemini(prompt);
      lastAiProvider='gemini';
      return result;
    } catch(error) {
      log('warn','Fast lane Gemini no disponible; usando flujo normal',{reason:error.message.slice(0,120)});
    }
  }
  if(Date.now()>=groqCooldownUntil) {
    try {
      const result=await classifyWithGroq(prompt);
      lastAiProvider='groq';
      return result;
    } catch(error) {
      if(error instanceof GroqRateLimitError) groqCooldownUntil=Date.now()+Math.max(60_000,error.retryAfterMs)+15_000;
      if(!GEMINI_KEY) throw error;
      log('warn','Groq no disponible; usando Gemini',{reason:error.message.slice(0,120)});
    }
  } else if(!GEMINI_KEY) {
    throw new GroqRateLimitError('Groq continúa en pausa',groqCooldownUntil-Date.now());
  }
  const result=await classifyWithGemini(prompt);
  lastAiProvider='gemini';
  return result;
}

function normalizedTrafficStatus(ai, sourceText) {
  const title=norm(ai?.resumen || '');
  const detail=norm(ai?.detail || '');
  const source=norm(sourceText || '');
  const current=[title,detail].filter(Boolean).join(' ');
  const restored=/transito fluido|trafico fluido|circulacion normal|circulacion fluida|via libre|vialidad libre|se restablec|restablecida|restablecido|reabiert|normalizada/.test(title)
    || /se restablec|via libre|reabiert|circulacion normal/.test(current);
  if(restored) return /restablec|reabiert|normalizada|via libre/.test(current) ? 'restored' : 'flowing';
  if(/cierre total|bloqueo total|sin paso|circulacion cerrada|vialidad cerrada|permanece cerrad|continua cerrad/.test(current)) return 'closed';
  if(/bloqueo|bloqueada|bloqueado|interrumpido el paso|manifestantes mantienen|continua el bloqueo/.test(current)) return 'blocked';
  if(/cierre parcial|reduccion de carriles|reducción de carriles|un carril|paso parcial/.test(current)) return 'partial';
  if(/transito lento|tránsito lento|carga vehicular|trafico lento|tráfico lento/.test(current)) return 'slow';
  const declared=String(ai?.traffic_status||'').toLowerCase();
  return ['flowing','slow','partial','blocked','closed','restored','unknown'].includes(declared) ? declared : 'unknown';
}

function locationTerms(value) {
  const ignored=new Set(['avenida','av','calle','carretera','autopista','circuito','interior','eje','norte','sur','este','oeste','de','del','la','las','los','y','con','hasta']);
  return norm(value).split(/[^a-z0-9]+/).filter(x=>x && !ignored.has(x) && (x.length>=3 || /^\d+$/.test(x)));
}

function candidateMatchesIntersection(query,label) {
  const first=clean(query).split(',')[0];
  const parts=first.split(/\s+(?:&|y|con|hasta)\s+/i).map(clean).filter(Boolean);
  if(parts.length<2) return true;
  const hay=new Set(locationTerms(label));
  return parts.slice(0,2).every(part => locationTerms(part).some(token=>hay.has(token)));
}

function requiresRoadPrecision(precision) {
  return ['intersection','reference','kilometer','road'].includes(precision);
}

function googleLocationTypeAllowed(type, precision) {
  if (!requiresRoadPrecision(precision)) return true;
  return !['APPROXIMATE','GEOMETRIC_CENTER'].includes(String(type || '').toUpperCase());
}

function geoapifyLocationTypeAllowed(result, precision) {
  if (!requiresRoadPrecision(precision)) return true;
  const type=norm(result?.result_type || result?.category || '');
  if (!type) return false;
  return !/(state|county|city|municipality|district|postcode|suburb|neighbourhood|administrative)/.test(type);
}

function geocodeCandidateScore(query,label,stateOk,baseConfidence,precision) {
  if(!stateOk) return -999;
  let score=Math.round((Number(baseConfidence)||0)*50);
  const qTerms=locationTerms(query), lTerms=new Set(locationTerms(label));
  score+=qTerms.filter(t=>lTerms.has(t)).length*8;
  if(precision==='intersection') {
    if(!candidateMatchesIntersection(query,label)) return -999;
    score+=30;
  }
  return score;
}

async function snapRoadCandidate(candidate, precision, expectedRoad='') {
  if (!GOOGLE_KEY || !candidate || !['road','kilometer','reference'].includes(precision)) return candidate;
  const lat=Number(candidate.latitude), lon=Number(candidate.longitude);
  if (!inMexico(lat,lon)) return candidate;
  roadSnapMetrics.attempted++;

  const url=new URL('https://roads.googleapis.com/v1/nearestRoads');
  url.searchParams.set('points', `${lat},${lon}`);
  url.searchParams.set('key', GOOGLE_KEY);

  try {
    const response=await fetch(url,{headers:{Accept:'application/json'}});
    const raw=await response.text();
    if (!response.ok || !/^\s*[\[{]/.test(raw)) {
      log('warn','Google Roads no pudo hacer snap',{ precision, status:response.status, label:candidate.label });
      return candidate;
    }
    const body=JSON.parse(raw);
    const point=body.snappedPoints?.[0]?.location;
    if (!point) return candidate;

    const snappedLat=Number(point.latitude), snappedLon=Number(point.longitude);
    if (!inMexico(snappedLat,snappedLon)) return candidate;

    const distanceKm=geoDistanceKm(lat,lon,snappedLat,snappedLon);
    const maxDistanceKm=precision==='road' ? 1.5 : .75;
    if (!Number.isFinite(distanceKm) || distanceKm>maxDistanceKm) {
      roadSnapMetrics.rejected_distance++;
      log('warn','Snap vial descartado por distancia',{
        precision,
        distance_m:Number.isFinite(distanceKm)?Math.round(distanceKm*1000):null,
        max_m:Math.round(maxDistanceKm*1000),
        label:candidate.label
      });
      return candidate;
    }

    const expected=clean(expectedRoad);
    let resolvedRoad='';
    let routeVerified=false;
    if(expected) {
      resolvedRoad=await reverseGoogleRoad(snappedLat,snappedLon,GOOGLE_KEY);
      if(!resolvedRoad) {
        roadSnapMetrics.reverse_failed++;
        log('warn','Snap vial descartado: reverse geocode sin nombre de vía',{
          precision,
          expected_road:expected,
          distance_m:Math.round(distanceKm*1000),
          label:candidate.label
        });
        return candidate;
      }
      routeVerified=roadMatches(expected,resolvedRoad);
      if(!routeVerified) {
        roadSnapMetrics.rejected_road_mismatch++;
        log('warn','Snap vial descartado por carretera distinta',{
          precision,
          expected_road:expected,
          resolved_road:resolvedRoad,
          distance_m:Math.round(distanceKm*1000),
          label:candidate.label
        });
        return candidate;
      }
    }

    const snapped={
      ...candidate,
      latitude:snappedLat,
      longitude:snappedLon,
      road_snapped:true,
      snap_distance_m:Math.round(distanceKm*1000),
      provider:`${candidate.provider || 'geocoder'}+google_roads`,
      status:candidate.confidence>=.82?'automatic':'approximate',
      route_verified:expected ? routeVerified : false,
      resolved_road:resolvedRoad || null
    };
    roadSnapMetrics.success++;
    log('info','Google Roads snap aplicado',{
      precision,
      distance_m:snapped.snap_distance_m,
      provider:candidate.provider || 'geocoder',
      expected_road:expected || null,
      resolved_road:resolvedRoad || null,
      route_verified:expected ? routeVerified : false,
      label:candidate.label
    });
    return snapped;
  } catch (error) {
    log('warn','Google Roads no disponible; se conserva geocodificación validada',{ precision, error:error.message });
    return candidate;
  }
}

async function geocode(query, expectedState, precision = 'zone', expectedRoad = '') {
  const confidenceCaps = { exact:.97, intersection:.90, reference:.86, kilometer:.84, road:.78, zone:.68, municipality:.56, state:.36 };
  const cap = confidenceCaps[precision] || .7;
  if (GEOAPIFY_KEY) {
    const url = new URL('https://api.geoapify.com/v1/geocode/search');
    url.searchParams.set('text', query);
    url.searchParams.set('filter', 'countrycode:mx');
    url.searchParams.set('bias', 'countrycode:mx');
    url.searchParams.set('format', 'json');
    url.searchParams.set('lang', 'es');
    url.searchParams.set('limit', '5');
    url.searchParams.set('apiKey', GEOAPIFY_KEY);
    try {
      const response = await fetch(url, { headers:{ Accept:'application/json' } });
      const body = await response.json();
      if (response.ok && Array.isArray(body.results) && body.results.length) {
        const ranked=body.results.map(result=>{
          const lat=Number(result.lat), lon=Number(result.lon), resolvedState=result.state || '';
          if(!inMexico(lat,lon)) return null;
          if(!geoapifyLocationTypeAllowed(result,precision)) return null;
          const rankConfidence=Number(result.rank?.confidence);
          const confidence=Math.min(cap, Number.isFinite(rankConfidence) ? rankConfidence : .62);
          const label=result.formatted || query;
          const score=geocodeCandidateScore(query,label,stateMatches(expectedState,resolvedState),confidence,precision);
          return score>-900 ? {
            latitude:lat, longitude:lon, label, confidence,
            status:confidence >= .82 ? 'automatic' : 'approximate',
            precision, location_type:result.result_type || result.category || null, provider:'geoapify',
            resolved_state:resolvedState || null, score
          } : null;
        }).filter(Boolean).sort((a,b)=>b.score-a.score);
        if(ranked.length) {
          const best=ranked[0]; delete best.score;
          return await snapRoadCandidate(best,precision,expectedRoad);
        }
        if(precision==='intersection') throw new Error('ningún candidato coincide con ambas vialidades');
      }
    } catch (error) {
      log('warn', 'Geoapify no pudo geocodificar; usando respaldo', { query, error:error.message });
    }
  }
  if (GOOGLE_KEY) {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('components', 'country:MX');
    url.searchParams.set('language', 'es');
    url.searchParams.set('region', 'mx');
    url.searchParams.set('key', GOOGLE_KEY);
    try {
      const response = await fetch(url);
      const raw = await response.text();
      if (response.ok && /^\s*[\[{]/.test(raw)) {
        const body = JSON.parse(raw);
        if (Array.isArray(body.results) && body.results.length) {
          const ranked=body.results.map(result=>{
            const country=result.address_components?.find(x=>x.types?.includes('country'))?.short_name || '';
            const resolvedState=result.address_components?.find(x=>x.types?.includes('administrative_area_level_1'))?.long_name || '';
            const lat=Number(result.geometry.location.lat), lon=Number(result.geometry.location.lng);
            if((country && country!=='MX') || !inMexico(lat,lon)) return null;
            const type=result.geometry?.location_type || 'APPROXIMATE';
            if(!googleLocationTypeAllowed(type,precision)) return null;
            const confidence=Math.min(cap,({ROOFTOP:.97,RANGE_INTERPOLATED:.9,GEOMETRIC_CENTER:.62,APPROXIMATE:.45})[type]||.45);
            const label=result.formatted_address || query;
            const score=geocodeCandidateScore(query,label,stateMatches(expectedState,resolvedState),confidence,precision);
            return score>-900 ? {
              latitude:lat,longitude:lon,label,confidence,
              status:confidence>=.82?'automatic':'approximate',
              precision,location_type:type,provider:'google',resolved_state:resolvedState || null,score
            } : null;
          }).filter(Boolean).sort((a,b)=>b.score-a.score);
          if(ranked.length){
            const best=ranked[0]; delete best.score;
            return await snapRoadCandidate(best,precision,expectedRoad);
          }
          if(precision==='intersection') throw new Error('ningún candidato coincide con ambas vialidades');
        }
      }
    } catch (error) {
      log('warn', 'Google no pudo geocodificar; usando respaldo', { query, error:error.message });
    }
  }
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&addressdetails=1&q=' + encodeURIComponent(query + ', México');
  let result;
  try {
    const response = await fetch(url, { headers: { 'User-Agent':'ZeroVial/1.0 contacto@zerovial.mx', 'Accept-Language':'es', Accept:'application/json' } });
    const raw = await response.text();
    if (!response.ok || !/^\s*\[/.test(raw)) {
      log('warn', 'Geocodificador de respaldo devolvió una respuesta no JSON', { query, status:response.status, preview:raw.slice(0,80) });
      return null;
    }
    result = JSON.parse(raw)?.[0];
  } catch (error) {
    log('warn', 'Geocodificador de respaldo no disponible', { query, error:error.message });
    return null;
  }
  if (!result) return null;
  const resolved = result.address?.state || '';
  const lat = Number(result.lat), lon = Number(result.lon);
  if (result.address?.country_code && result.address.country_code !== 'mx') return null;
  if (!inMexico(lat, lon) || !stateMatches(expectedState, resolved)) return null;
  const roadTypes=['motorway','trunk','primary','secondary','tertiary','road','unclassified','residential'];
  if (requiresRoadPrecision(precision) && !roadTypes.includes(result.type)) return null;
  const base = roadTypes.includes(result.type) ? .70 : result.type === 'administrative' ? .48 : .58;
  return await snapRoadCandidate({
    latitude:lat, longitude:lon, label:result.display_name,
    confidence:Math.min(cap,base), status:'approximate', precision,
    location_type:result.type || null, provider:'nominatim', resolved_state:resolved || null
  },precision,expectedRoad);
}

function roadKey(value) {
  return norm(value).replace(/\b(autopista|carretera|federal|mexico|mex)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findRoadCorridor(road) {
  const raw = norm(road);
  const key = roadKey(road);
  if (!raw || !key) return null;
  let best = null;
  for (const corridor of RED_VIAL) {
    const names = [corridor.name, ...(corridor.aliases || [])];
    for (const name of names) {
      const candidateRaw = norm(name);
      const candidateKey = roadKey(name);
      let score = 0;
      if (raw === candidateRaw) score = 100;
      else if (key === candidateKey) score = 95;
      else if (candidateRaw && (raw.includes(candidateRaw) || candidateRaw.includes(raw))) score = 88;
      else if (candidateKey && key.length >= 3 && (key.includes(candidateKey) || candidateKey.includes(key))) score = 82;
      if (score && (!best || score > best.score)) best = { corridor, score, matched:name };
    }
  }
  return best && best.score >= 82 ? best : null;
}

function pointAtRoadKilometer(corridor, kilometer) {
  const km = Number(kilometer);
  const start = Number(corridor?.kmStart), end = Number(corridor?.kmEnd);
  const pts = corridor?.pts || [];
  if (!Number.isFinite(km) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || pts.length < 2) return null;
  if (km < start || km > end) return null;
  const segments = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const length = geoDistanceKm(pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
    segments.push(length);
    total += length;
  }
  if (!(total > 0)) return null;
  const target = ((km - start) / (end - start)) * total;
  let walked = 0;
  for (let i = 0; i < segments.length; i++) {
    const next = walked + segments[i];
    if (target <= next || i === segments.length - 1) {
      const ratio = segments[i] > 0 ? Math.max(0, Math.min(1, (target - walked) / segments[i])) : 0;
      const a = pts[i], b = pts[i+1];
      return {
        latitude:a[0] + (b[0] - a[0]) * ratio,
        longitude:a[1] + (b[1] - a[1]) * ratio,
        route_distance_km:target
      };
    }
    walked = next;
  }
  return null;
}

async function resolvedStateAtPoint(lat, lon) {
  if (GEOAPIFY_KEY) {
    try {
      const url=new URL('https://api.geoapify.com/v1/geocode/reverse');
      url.searchParams.set('lat',String(lat));
      url.searchParams.set('lon',String(lon));
      url.searchParams.set('format','json');
      url.searchParams.set('lang','es');
      url.searchParams.set('limit','1');
      url.searchParams.set('apiKey',GEOAPIFY_KEY);
      const response=await fetch(url,{headers:{Accept:'application/json'}});
      const body=await response.json().catch(()=>({}));
      const state=clean(body?.results?.[0]?.state);
      if(response.ok && state) return { state, provider:'geoapify' };
    } catch {}
  }

  if (GOOGLE_KEY) {
    try {
      const url=new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('latlng',`${lat},${lon}`);
      url.searchParams.set('language','es');
      url.searchParams.set('region','mx');
      url.searchParams.set('key',GOOGLE_KEY);
      const response=await fetch(url,{headers:{Accept:'application/json'}});
      const body=await response.json().catch(()=>({}));
      if(response.ok && body.status==='OK') {
        for(const result of body.results || []) {
          const state=result.address_components?.find(x=>x.types?.includes('administrative_area_level_1'))?.long_name || '';
          if(state) return { state:clean(state), provider:'google' };
        }
      }
    } catch {}
  }

  return { state:'', provider:'' };
}

function resolveStaticRoadKilometer(road, kilometer) {
  if (!road || kilometer == null) return null;
  const match = findRoadCorridor(road);
  if (!match) return null;
  const point = pointAtRoadKilometer(match.corridor, kilometer);
  if (!point || !inMexico(point.latitude, point.longitude)) return null;
  return {
    latitude:point.latitude,
    longitude:point.longitude,
    label:`${match.corridor.name} · km ${kilometer}`,
    // RED_VIAL interpola el km sobre la geometría del corredor: útil, pero no equivale a un punto físico exacto.
    confidence:match.score >= 95 ? .90 : .86,
    status:'automatic',
    precision:'kilometer_static',
    corridor:match.corridor.badge,
    matched_alias:match.matched
  };
}

function extractExplicitTollReference(text) {
  const source=clean(text);
  if (!source) return '';

  const quoted=source.match(/(?:plaza\s+de\s+cobro|caseta(?:\s+de\s+cobro)?|peaje)\s*['"“”‘’]([^'"“”‘’]{2,80})['"“”‘’]/i);
  if (quoted) return clean(`Plaza de Cobro ${quoted[1]}`);

  const plain=source.match(/(?:plaza\s+de\s+cobro|caseta(?:\s+de\s+cobro)?|peaje)\s+(?:de\s+)?([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .-]{2,60}?)(?=\s+(?:a\s+la\s+altura|ubicad[ao]|sobre|en\s+el\s+km|km\b|toluca\b|edo\.?\s*m[eé]x|estado\s+de)|[,.;]|$)/i);
  return plain ? clean(`Plaza de Cobro ${plain[1]}`) : '';
}

function tollKey(value) {
  return norm(value)
    .replace(/\b(caseta|casetas|plaza|plazas|cobro|peaje|de|del|la|el|nro|no|numero|km)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistanceAtMostOne(a,b) {
  a=String(a||''); b=String(b||'');
  if(a===b) return true;
  if(Math.abs(a.length-b.length)>1) return false;
  let i=0,j=0,diff=0;
  while(i<a.length && j<b.length) {
    if(a[i]===b[j]) { i++; j++; continue; }
    diff++;
    if(diff>1) return false;
    if(a.length>b.length) i++;
    else if(b.length>a.length) j++;
    else { i++; j++; }
  }
  if(i<a.length || j<b.length) diff++;
  return diff<=1;
}

function tollMatchScore(reference, name) {
  const a=tollKey(reference), b=tollKey(name);
  if (!a || !b) return 0;
  if (a===b) return 100;
  if (a.length>=5 && b.includes(a)) return 96;
  if (b.length>=5 && a.includes(b)) return 94;
  const aa=new Set(a.split(' ').filter(x=>x.length>2));
  const bb=new Set(b.split(' ').filter(x=>x.length>2));
  if (!aa.size || !bb.size) return 0;
  const common=[...aa].filter(x=>bb.has(x)).length;
  const overlap=Math.round((common/Math.max(aa.size,bb.size))*90);
  if(overlap>=82) return overlap;

  // Tolerancia muy acotada a un error tipográfico en nombres distintivos
  // de 6+ caracteres (p.ej. "Tepozotlan" vs "Tepotzotlan").
  const longA=[...aa].filter(x=>x.length>=6);
  const longB=[...bb].filter(x=>x.length>=6);
  if(longA.some(x=>longB.some(y=>editDistanceAtMostOne(x,y)))) return 88;

  return overlap;
}

function resolveTollReference(reference) {
  if (!reference || !/(caseta|plaza\s+de\s+cobro|peaje)/i.test(reference)) return null;
  let best=null;
  for (const toll of CASETAS) {
    const score=tollMatchScore(reference,toll.name);
    if (!best || score>best.score) best={toll,score};
  }
  if (!best || best.score<82) return null;
  return {
    latitude:Number(best.toll.lat),
    longitude:Number(best.toll.lon),
    label:best.toll.name,
    confidence:best.score>=94 ? .96 : .9,
    status:'automatic',
    precision:'toll_reference',
    matched_reference:best.toll.name,
    match_score:best.score
  };
}

async function resolveRoadLocation(ai, kilometer, reference) {
  if (!ai.carretera) return null;
  const staticKm = resolveStaticRoadKilometer(ai.carretera, kilometer);
  if (staticKm) {
    const expectedState=clean(ai.estado);
    if(expectedState) {
      const verified=await resolvedStateAtPoint(staticKm.latitude, staticKm.longitude);
      if(!verified.state || !stateMatches(expectedState, verified.state)) {
        log('warn','RED_VIAL descartado por estado inconsistente',{
          road:ai.carretera,
          kilometer,
          corridor:staticKm.corridor,
          expected_state:expectedState,
          resolved_state:verified.state || null,
          verifier:verified.provider || null
        });
      } else {
        staticKm.state_verified=true;
        staticKm.resolved_state=verified.state;
        staticKm.state_verifier=verified.provider;
        log('info','Kilómetro resuelto con RED_VIAL',{
          road:ai.carretera,
          kilometer,
          corridor:staticKm.corridor,
          confidence:staticKm.confidence,
          state_verified:true,
          resolved_state:verified.state,
          verifier:verified.provider
        });
        return staticKm;
      }
    } else {
      log('info','Kilómetro resuelto con RED_VIAL',{ road:ai.carretera, kilometer, corridor:staticKm.corridor, confidence:staticKm.confidence });
      return staticKm;
    }
  }
  const candidates = [];
  const queries = [
    { query:[reference, ai.carretera, ai.municipio, ai.estado].map(clean).filter(Boolean).join(', '), precision:'reference' },
    { query:[ai.carretera, kilometer != null ? 'km ' + kilometer : '', reference, ai.municipio, ai.estado].map(clean).filter(Boolean).join(', '), precision:'kilometer' },
    { query:[ai.carretera, ai.municipio, ai.estado].map(clean).filter(Boolean).join(', '), precision:'road' }
  ].filter(x => x.query.length >= 4).filter((x,i,a) => a.findIndex(y => y.query === x.query) === i);
  for (const candidate of queries) {
    const result = await geocode(candidate.query, ai.estado, candidate.precision, ai.carretera);
    if (result) candidates.push(result);
    if (!GEOAPIFY_KEY && !GOOGLE_KEY) await sleep(1100);
  }
  if (!candidates.length) return null;
  if (reference && candidates.length >= 2) {
    const ref = candidates[0];
    const near = candidates.filter(x => geoDistanceKm(ref.latitude, ref.longitude, x.latitude, x.longitude) <= 25);
    if (near.length) {
      near.sort((a,b) => b.confidence - a.confidence);
      const best = near[0];
      return { ...best, confidence:Math.min(.95, Math.max(best.confidence,.88)), status:'automatic', precision:'reference' };
    }
  }
  candidates.sort((a,b) => b.confidence - a.confidence);
  return candidates[0];
}

function intersectionParts(value) {
  const text = clean(value);
  if (!text) return null;

  // Algunas fuentes entregan ubicación + contexto separados por comas.
  // Probamos primero cada segmento para evitar que "Ciudad de México, CDMX"
  // termine formando parte del nombre de una vialidad.
  const candidates = [text, ...text.split(/[,;|]/).map(clean).filter(Boolean)];
  const patterns = [
    /^entre\s+(.+?)\s+y\s+(.+)$/i,
    /^desde\s+(.+?)\s+hasta\s+(.+)$/i,
    /^(.+?)\s+a\s+la\s+altura\s+de\s+(.+)$/i,
    /^(.+?)\s+altura\s+de\s+(.+)$/i,
    /^(.+?)\s+(?:hasta|esquina(?:\s+con)?|cruce(?:\s+con)?|intersecci[oó]n(?:\s+con)?|con|y)\s+(.+)$/i
  ];

  for (const candidate of candidates) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      if (!match) continue;
      const a = clean(match[1]), b = clean(match[2]);
      if (a.length < 3 || b.length < 3) continue;
      // Evita devolver dos veces la misma vialidad cuando la fuente repite el inicio del tramo.
      if (norm(a) === norm(b)) continue;
      return [a,b];
    }
  }
  return null;
}

function urbanIntersection(ai) {
  const location=clean(ai.ubicacion);
  const reference=clean(ai.referencia);
  const candidates = [
    location,
    reference,
    location && reference ? location + ' a la altura de ' + reference : ''
  ].map(clean).filter(Boolean);

  for (const candidate of candidates) {
    const parts = intersectionParts(candidate);
    if (parts) return parts;
  }
  return null;
}

async function resolveUrbanIntersection(ai) {
  const streets = urbanIntersection(ai);
  if (!streets) return null;
  const municipality = usableMunicipality(ai.municipio, ai.estado);
  const context = [municipality, ai.estado].map(clean).filter(Boolean);
  const variants = [
    [streets[0] + ' & ' + streets[1], ...context].join(', '),
    [streets[0] + ' y ' + streets[1], ...context].join(', ')
  ];
  for (const query of variants) {
    const geo = await geocode(query, ai.estado, 'intersection');
    if (!geo) continue;
    // No elevamos artificialmente la confianza: conservamos la evidencia del proveedor.
    return { ...geo, precision:'intersection', status:geo.confidence >= .82 ? 'automatic' : 'approximate' };
  }
  return null;
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

function normalizeAlertCopy(summary, detail) {
  const title=clean(summary);
  let body=clean(detail);
  if (!title || !body) return { title, detail:body };

  const titleNorm=norm(title).replace(/[.!?:;]+$/g,'').trim();
  const bodyNorm=norm(body);
  if (titleNorm && bodyNorm.startsWith(titleNorm)) {
    body=body.slice(title.length).replace(/^[\s\-–—:;,.]+/,'').trim();
  }
  if (!body || norm(body)===titleNorm) body='';
  return { title, detail:body };
}

function strictLocationDecision(ai, geo, context={}) {
  if (!STRICT_LOCATION_MODE) return { ok:true, reason:'strict_mode_disabled' };
  if (!geo || !Number.isFinite(Number(geo.latitude)) || !Number.isFinite(Number(geo.longitude))) {
    return { ok:false, reason:'missing_coordinates' };
  }

  const precision=String(geo.precision || '').toLowerCase();
  const confidence=Number(geo.confidence) || 0;
  const status=String(geo.status || '').toLowerCase();
  const provider=String(geo.provider || '').toLowerCase();
  const locationType=String(geo.location_type || '').toUpperCase();
  const roadSnapped=!!geo.road_snapped || provider.includes('google_roads');
  const road=clean(ai?.carretera);
  const location=clean(ai?.ubicacion);
  const municipality=clean(context.municipality);
  const state=clean(ai?.estado);
  const kilometer=context.kilometer;
  const explicitIntersection=context.explicitIntersection;
  const reference=clean(context.reference);

  if (precision==='toll_reference') {
    return confidence>=.88 ? {ok:true,reason:'trusted_toll'} : {ok:false,reason:'low_confidence_toll'};
  }
  if (precision==='kilometer_static') {
    if(state && !geo.state_verified) return {ok:false,reason:'red_vial_state_unverified'};
    return confidence>=.84 ? {ok:true,reason:'trusted_red_vial'} : {ok:false,reason:'low_confidence_red_vial'};
  }
  if (precision==='intersection') {
    if (!explicitIntersection) return {ok:false,reason:'intersection_without_two_streets'};
    if (confidence<.74) return {ok:false,reason:'low_confidence_intersection'};
    return {ok:true,reason:'trusted_intersection'};
  }

  if (['kilometer','reference','road'].includes(precision)) {
    if (!road) return {ok:false,reason:'road_precision_without_road'};
    if (['APPROXIMATE','GEOMETRIC_CENTER'].includes(locationType)) return {ok:false,reason:'generic_geocoder_location_type'};
    if (!roadSnapped) return {ok:false,reason:'road_not_snapped'};
    const minConfidence=precision==='road' ? .68 : .72;
    if (confidence<minConfidence) return {ok:false,reason:'low_confidence_road'};
    return {ok:true,reason:'trusted_snapped_road'};
  }

  // Una ubicación puramente municipal/estatal es demasiado ambigua para un pin operativo.
  if (['municipality','state'].includes(precision)) {
    return {ok:false,reason:'administrative_center_only'};
  }

  if (precision==='zone' || !precision) {
    // Permitimos zona urbana solo si existe evidencia más específica que municipio/estado.
    const normalizedLocation=norm(location);
    const hasStreetSignal=/\b(av\.?|avenida|calle|blvd\.?|boulevard|eje|circuito|periferico|perif[eé]rico|calzada|carretera|autopista|entronque|puente|distribuidor)\b/i.test(location);
    const isOnlyAdministrative =
      !location ||
      norm(location)===norm(municipality) ||
      norm(location)===norm(state) ||
      normalizedLocation===norm([municipality,state].filter(Boolean).join(' '));
    if (isOnlyAdministrative) return {ok:false,reason:'ambiguous_zone'};
    if (!hasStreetSignal && confidence<.68) return {ok:false,reason:'weak_zone_without_street_signal'};
    if (confidence<.62) return {ok:false,reason:'low_confidence_zone'};
    return {ok:true,reason:'trusted_zone'};
  }

  // Cualquier tipo desconocido se descarta por defecto.
  return {ok:false,reason:'unknown_location_precision'};
}

async function processItem(item, feed, options={}) {
  const externalId = hash(item.url || item.title + '|' + item.published_at);
  if (await alreadyExists(externalId)) return 'duplicate';
  const ai = await classify((item.title + '. ' + item.body).slice(0, 1400), options);
  if (!ai?.valido || !['road','security'].includes(ai.categoria)) return 'rejected';
  const copy = normalizeAlertCopy(ai.resumen, ai.detail);
  const title = copy.title;
  const detail = copy.detail;
  if (title.length < 8 || detail.length < 15) return 'rejected';
  const kilometer = normalizedKilometer(ai.kilometro, item.title + ' ' + item.body);
  const direction = clean(ai.sentido);
  const sourceText = clean(item.title + ' ' + item.body);
  const explicitTollReference = extractExplicitTollReference(sourceText);
  const reference = explicitTollReference || clean(ai.referencia);
  const trafficStatus = normalizedTrafficStatus(ai, item.title + ' ' + item.body);
  const eventType = ['traffic_update','crash','closure','blockage','protest','road_hazard','security_incident','emergency','other'].includes(String(ai.event_type||'').toLowerCase()) ? String(ai.event_type).toLowerCase() : 'other';
  const municipality = usableMunicipality(ai.municipio, ai.estado);
  const explicitIntersection = urbanIntersection(ai);
  const locationParts = ai.carretera
    ? [ai.carretera, kilometer != null ? 'km ' + kilometer : '', reference, municipality, ai.estado]
    : [ai.ubicacion, municipality, ai.estado];
  const locationQuery = [...new Set(locationParts.map(clean).filter(Boolean))].join(', ');
  if (locationQuery.length < 4) return 'no_location';
  const locationQueries = [
    { query:locationQuery, precision:ai.carretera && kilometer != null ? 'kilometer' : ai.carretera && reference ? 'reference' : ai.carretera ? 'road' : 'zone' },
    { query:[reference, ai.carretera, municipality, ai.estado].map(clean).filter(Boolean).join(', '), precision:reference && ai.carretera ? 'reference' : 'zone' },
    { query:[ai.ubicacion, municipality, ai.estado].map(clean).filter(Boolean).join(', '), precision:'zone' },
    { query:[ai.carretera, municipality, ai.estado].map(clean).filter(Boolean).join(', '), precision:'road' },
    { query:municipality ? [municipality, ai.estado].map(clean).filter(Boolean).join(', ') : '', precision:'municipality' },
    { query:clean(ai.estado), precision:'state' }
  ].filter(x => x.query.length >= 4).filter((x,index,list) => list.findIndex(y => y.query === x.query) === index).slice(0, 4);
  let geo = resolveTollReference(reference);
  if (geo) log('info','Caseta resuelta con CASETAS',{
    reference,
    extracted_from_text:!!explicitTollReference,
    matched:geo.matched_reference,
    score:geo.match_score,
    confidence:geo.confidence
  });

  // Si la fuente da dos vialidades explícitas y no hay km fiable, resolver primero el cruce.
  // Esto evita que una avenida urbana mal clasificada como "carretera" termine en el centro
  // de la ciudad o en un punto genérico de la vialidad.
  if (!geo && explicitIntersection && kilometer == null) {
    geo = await resolveUrbanIntersection({ ...ai, municipio:municipality });
    if (geo) log('info','Intersección urbana resuelta',{
      location:clean(ai.ubicacion),
      streets:explicitIntersection,
      municipality,
      state:clean(ai.estado),
      confidence:geo.confidence
    });
  }

  if (!geo) geo = await resolveRoadLocation(ai, kilometer, reference);

  // Si existe un km, el corredor tiene prioridad. Si RED_VIAL/geocoder vial no resolvió,
  // todavía permitimos usar un cruce explícito como respaldo.
  if (!geo && explicitIntersection) {
    geo = await resolveUrbanIntersection({ ...ai, municipio:municipality });
    if (geo) log('info','Intersección urbana resuelta como respaldo',{
      location:clean(ai.ubicacion),
      streets:explicitIntersection,
      municipality,
      state:clean(ai.estado),
      confidence:geo.confidence
    });
  }

  if (!geo && explicitIntersection) {
    log('warn','Intersección explícita sin resolución; se evita fallback municipal/estatal',{
      streets:explicitIntersection,
      municipality,
      state:clean(ai.estado),
      location:clean(ai.ubicacion)
    });
    return 'no_location';
  }
  const requiresSpecificRoadLocation = !!clean(ai.carretera) || kilometer != null || !!reference;
  if (!geo && requiresSpecificRoadLocation) {
    log('warn','Ubicación vial específica sin resolución fiable; se evita fallback municipal/estatal',{
      road:clean(ai.carretera),
      kilometer,
      reference,
      municipality,
      state:clean(ai.estado)
    });
    return 'no_location';
  }
  if (!geo) {
    for (const candidate of locationQueries.filter(x=>['zone','municipality','state'].includes(x.precision))) {
      geo = await geocode(candidate.query, ai.estado, candidate.precision);
      if (geo) break;
      if (!GEOAPIFY_KEY && !GOOGLE_KEY) await sleep(1100);
    }
  }
  if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return 'no_location';

  // Validación final universal: ningún pin operativo puede contradecir el estado
  // extraído de la alerta. Reutilizamos el estado del geocoder cuando existe;
  // para CASETAS/RED_VIAL/otros puntos estáticos hacemos reverse geocode.
  const expectedGeoState=clean(ai.estado);
  if(expectedGeoState) {
    let resolvedGeoState=clean(geo.resolved_state);
    let stateVerifier=resolvedGeoState ? (geo.provider || 'provider') : '';

    if(!resolvedGeoState) {
      const verified=await resolvedStateAtPoint(geo.latitude, geo.longitude);
      resolvedGeoState=clean(verified.state);
      stateVerifier=verified.provider || '';
    }

    if(!resolvedGeoState) {
      noteStrictLocationReject('coordinate_state_unverified');
      log('warn','Ubicación descartada: no fue posible verificar el estado del punto',{
        expected_state:expectedGeoState,
        road:clean(ai.carretera),
        kilometer,
        reference,
        precision:geo.precision || null,
        provider:geo.provider || null,
        latitude:Number(geo.latitude),
        longitude:Number(geo.longitude)
      });
      return 'no_location';
    }

    if(!stateMatches(expectedGeoState,resolvedGeoState)) {
      noteStrictLocationReject('coordinate_state_mismatch');
      log('warn','Ubicación descartada: coordenadas fuera del estado esperado',{
        expected_state:expectedGeoState,
        resolved_state:resolvedGeoState,
        verifier:stateVerifier || null,
        road:clean(ai.carretera),
        kilometer,
        reference,
        precision:geo.precision || null,
        provider:geo.provider || null,
        latitude:Number(geo.latitude),
        longitude:Number(geo.longitude)
      });
      return 'no_location';
    }

    geo.state_verified=true;
    geo.resolved_state=resolvedGeoState;
    geo.state_verifier=stateVerifier || geo.state_verifier || null;
  }

  const strictDecision=strictLocationDecision(ai,geo,{
    kilometer,
    reference,
    municipality,
    explicitIntersection
  });
  if (!strictDecision.ok) {
    noteStrictLocationReject(strictDecision.reason);
    log('warn','Ubicación descartada por política estricta',{
      reason:strictDecision.reason,
      road:clean(ai.carretera),
      kilometer,
      reference,
      municipality,
      state:clean(ai.estado),
      precision:geo.precision || null,
      confidence:Number(geo.confidence)||0,
      status:geo.status || null,
      provider:geo.provider || null,
      location_type:geo.location_type || null,
      road_snapped:!!geo.road_snapped
    });
    return 'no_location';
  }

  const eventAt = item.published_at && Date.now() - new Date(item.published_at).getTime() <= MAX_AGE_MS ? item.published_at : new Date().toISOString();
  const row = {
    external_id: externalId,
    title,
    detail,
    category: ai.categoria,
    severity: ['critical','high','medium','low'].includes(ai.severidad) ? ai.severidad : 'medium',
    event_type: eventType,
    traffic_status: ai.categoria === 'road' ? trafficStatus : 'unknown',
    state: clean(ai.estado) || null,
    municipality: municipality || null,
    road: clean(ai.carretera) || null,
    kilometer,
    location_label: [geo.label || locationQuery, reference ? 'ref. ' + reference : '', direction ? 'sentido ' + direction : ''].filter(Boolean).join(' · '),
    latitude: geo.latitude,
    longitude: geo.longitude,
    location_confidence: geo.confidence,
    location_precision: geo.precision || null,
    location_status: geo.status,
    source_name: sourceName(item, feed),
    source_url: item.url || null,
    event_at: eventAt
  };
  const spatialDuplicate=await findSpatialDuplicate(row);
  if (spatialDuplicate) {
    log('info','Alerta duplicada por proximidad y similitud',{
      external_id:externalId,
      existing_id:spatialDuplicate.id,
      distance_m:spatialDuplicate.distance_m,
      similarity:spatialDuplicate.similarity,
      same_road:spatialDuplicate.same_road,
      same_km:spatialDuplicate.same_km,
      existing_source:spatialDuplicate.source,
      new_source:row.source_name
    });
    return 'duplicate';
  }
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
  strictLocationRejects = Object.create(null);
  roadSnapMetrics = { attempted:0, success:0, rejected_distance:0, rejected_road_mismatch:0, reverse_failed:0 };
  const stats = { received:0, relevant:0, queued_new:0, queue_pending:0, queue_failed:0, queue_oldest_min:0, analyzed:0, inserted:0, duplicates:0, rejected:0, no_location:0, errors:0, rate_limited:0, groq_used:0, gemini_used:0, ai_cooldown_seconds:0, ai_budget_wait_seconds:0, ai_max_per_hour:AI_MAX_PER_HOUR, avg_source_delay_min:0, max_source_delay_min:0, location_success_rate_pct:0, tomtom_enabled:false, tomtom_received:0, tomtom_boxes:0, tomtom_errors:0, tomtom_high_value:0, tomtom_medium_value:0, tomtom_low_value:0, tomtom_operational_candidates:0, tomtom_collapsed_duplicates:0, tomtom_categories:{}, queue_expired_removed:0, strict_location_mode:STRICT_LOCATION_MODE, strict_location_rejections:{}, road_snap_metrics:{}, fast_lane_used:0, fast_lane_skipped_budget:0, fast_lane_max_per_hour:FAST_LANE_MAX_PER_HOUR };
  await health({ status:'running', last_started_at:started, last_error:null });
  try {
    const tomtom = await TOMTOM_TRAFFIC.fetchShadowIncidents(env);
    stats.tomtom_enabled = !!tomtom.enabled;
    stats.tomtom_received = tomtom.incidents.length;
    stats.tomtom_boxes = tomtom.boxes;
    stats.tomtom_errors = tomtom.errors.length;
    stats.tomtom_categories = tomtom.summary?.counts || {};
    stats.tomtom_high_value = tomtom.summary?.operational_value?.high || 0;
    stats.tomtom_medium_value = tomtom.summary?.operational_value?.medium || 0;
    stats.tomtom_low_value = tomtom.summary?.operational_value?.low || 0;
    stats.tomtom_operational_candidates = tomtom.summary?.operational_candidates || 0;
    stats.tomtom_collapsed_duplicates = tomtom.summary?.collapsed_duplicates || 0;
    if (tomtom.enabled) {
      log(tomtom.errors.length ? 'warn' : 'info','TomTom Traffic modo sombra',{
        incidents:tomtom.incidents.length,
        boxes:tomtom.boxes,
        errors:tomtom.errors,
        used_default_box:!!tomtom.used_default_box,
        categories:tomtom.summary?.counts || {},
        operational_value:tomtom.summary?.operational_value || {},
        operational_candidates:tomtom.summary?.operational_candidates || 0,
        collapsed_duplicates:tomtom.summary?.collapsed_duplicates || 0,
        high_value_sample:(tomtom.summary?.high_value || []).slice(0,5).map(x=>({
          id:x.id,
          category:x.category,
          operational_value:x.operational_value,
          icon_category:x.icon_category,
          description:x.description,
          from:x.from,
          to:x.to,
          delay_seconds:x.delay_seconds,
          lat:x.latitude,
          lon:x.longitude
        })),
        sample:tomtom.incidents.slice(0,3).map(x=>({
          id:x.id,
          category:x.icon_category,
          description:x.description,
          from:x.from,
          to:x.to,
          lat:x.latitude,
          lon:x.longitude
        }))
      });
    }

    stats.queue_expired_removed = await purgeExpiredQueue();

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
    const delays=candidates.map(x=>x.item.published_at?Math.max(0,(Date.now()-new Date(x.item.published_at).getTime())/60000):null).filter(Number.isFinite);
    if(delays.length) {
      stats.avg_source_delay_min=Math.round(delays.reduce((sum,value)=>sum+value,0)/delays.length);
      stats.max_source_delay_min=Math.round(Math.max(...delays));
    }
    const unique = new Map(candidates.map(x => [x.item.url || x.item.title, x]));
    const prioritized = [...unique.values()].sort((a,b) => incidentPriority(b.item) - incidentPriority(a.item));
    for (const { item, feed } of prioritized) {
      const externalId = hash(item.url || item.title + '|' + item.published_at);
      if (seenRecently(externalId)) { stats.duplicates++; continue; }
      if (await alreadyExists(externalId)) { stats.duplicates++; continue; }
      await enqueueCandidate(item, feed, incidentPriority(item));
      markProcessed(externalId);
      stats.queued_new++;
    }
    await recoverStaleQueue();
    const pending = await queuedItems(MAX_AI_PER_CYCLE);
    for (const queued of pending) {
      const item = queued.item || {};
      const feed = queued.feed_url || '';
      const externalId = queued.external_id;
      const wantsFastLane=isFastLaneCandidate(item);
      const useFastLane=wantsFastLane && fastLaneAvailable();
      if(wantsFastLane && !useFastLane) stats.fast_lane_skipped_budget++;
      if (Date.now() < groqCooldownUntil && !GEMINI_KEY) {
        stats.ai_cooldown_seconds = Math.ceil((groqCooldownUntil - Date.now()) / 1000);
        break;
      }
      if (!useFastLane && Date.now() < aiNextAllowedAt) {
        stats.ai_budget_wait_seconds = Math.ceil((aiNextAllowedAt - Date.now()) / 1000);
        break;
      }
      stats.analyzed++;
      if(useFastLane) {
        markFastLaneUsed();
        stats.fast_lane_used++;
        log('info','Fast lane: alerta vial prioritaria enviada a Gemini',{
          source:item.source || null,
          title:String(item.title||'').slice(0,120),
          priority:queued.priority
        });
      } else {
        aiNextAllowedAt = Date.now() + AI_MIN_INTERVAL_MS;
      }
      await updateQueue(externalId, { status:'processing', processing_started_at:new Date().toISOString() });
      try {
        const result = await processItem(item, feed, { preferGemini:useFastLane });
        if(lastAiProvider==='gemini') stats.gemini_used++; else if(lastAiProvider==='groq') stats.groq_used++;
        if (result === 'inserted') stats.inserted++;
        else if (result === 'no_location') stats.no_location++;
        else if (result === 'duplicate') stats.duplicates++;
        else stats.rejected++;
        await updateQueue(externalId, { status:'completed', completed_at:new Date().toISOString(), processing_started_at:null, last_error:null });
      } catch (error) {
        if (error instanceof GroqRateLimitError) {
          const waitMs = Math.max(60_000, error.retryAfterMs) + 15_000;
          groqCooldownUntil = Date.now() + waitMs;
          stats.rate_limited++;
          stats.ai_cooldown_seconds = Math.ceil(waitMs / 1000);
          await updateQueue(externalId, { status:'retry', next_attempt_at:new Date(groqCooldownUntil).toISOString(), processing_started_at:null, last_error:error.message.slice(0,1000) });
          log('warn','Groq limitado; se pausa el análisis sin descartar noticias',{ retry_in_seconds:stats.ai_cooldown_seconds });
          break;
        }
        stats.errors++;
        const attempts = Number(queued.attempts || 0) + 1;
        const failed = attempts >= QUEUE_MAX_ATTEMPTS;
        const retryDelay = Math.min(6 * 3600_000, 15 * 60_000 * (2 ** Math.max(0, attempts - 1)));
        await updateQueue(externalId, {
          status:failed ? 'failed' : 'retry',
          attempts,
          next_attempt_at:new Date(Date.now() + retryDelay).toISOString(),
          processing_started_at:null,
          last_error:error.message.slice(0,1000)
        });
        log('error','Error procesando noticia',{ title:item.title.slice(0,80), error:error.message });
      }
      await sleep(AI_DELAY_MS);
    }
    Object.assign(stats, await queueMetrics());
    stats.strict_location_rejections={...strictLocationRejects};
    stats.road_snap_metrics={...roadSnapMetrics};
    const located=stats.inserted+stats.no_location;
    stats.location_success_rate_pct=located?Math.round((stats.inserted/located)*100):0;
    await health({
      status:'healthy',
      last_success_at:new Date().toISOString(),
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
  log('info','Worker Zero Vial iniciado',{ feeds:FEEDS.length, interval_ms:POLL_MS, model:GROQ_MODEL, gemini_model:GEMINI_KEY?GEMINI_MODEL:null, ai_max_per_hour:AI_MAX_PER_HOUR, ai_min_interval_ms:AI_MIN_INTERVAL_MS });
  await cycle();
  if (env.WORKER_ONCE === '1') return;
  while (true) {
    await sleep(POLL_MS);
    await cycle();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
