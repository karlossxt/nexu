'use strict';

const { createHash } = require('crypto');
const RED_VIAL = require('./red-vial');
const CASETAS = require('./casetas');

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
const POLL_MS = Math.max(60_000, Number(env.WORKER_INTERVAL_MS) || 60_000);
const MAX_AGE_MS = Math.max(1, Number(env.ALERT_MAX_AGE_HOURS) || 24) * 3600_000;
const MAX_AI_PER_CYCLE = Math.max(1, Number(env.MAX_AI_PER_CYCLE) || 6);
const AI_DELAY_MS = Math.max(5_000, Number(env.AI_DELAY_MS) || 10_000);
const AI_MAX_PER_HOUR = Math.max(1, Math.min(60, Number(env.AI_MAX_PER_HOUR) || 8));
const AI_MIN_INTERVAL_MS = Math.ceil(3600_000 / AI_MAX_PER_HOUR);
const QUEUE_MAX_ATTEMPTS = Math.max(1, Number(env.QUEUE_MAX_ATTEMPTS) || 5);
const FEEDS = [env.RSS_PRI, env.RSS_SEC].map(x => String(x || '').trim()).filter(Boolean);
const DEFAULT_FEED = 'https://news.google.com/rss/search?q=accidente+OR+bloqueo+OR+asalto+carretera+mexico&hl=es-419&gl=MX&ceid=MX:es-419';
if (!FEEDS.length) FEEDS.push(DEFAULT_FEED);
const processedIds = new Map();
let groqCooldownUntil = 0;
let aiNextAllowedAt = 0;
let lastAiProvider = 'none';

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

function incidentPriority(item) {
  const text = norm(`${item.title} ${item.body}`);
  const source = norm(item.source);
  let score = 0;
  if (/capufe|guardia nacional|proteccion civil|secretaria de seguridad|c5\b/.test(`${source} ${text}`)) score += 8;
  if (/cierre total|cierre de circulacion|bloqueo|balacera|asalto|ataque armado|enfrentamiento/.test(text)) score += 7;
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
  return `Clasifica esta noticia. Rechaza si no es un incidente vial o de seguridad relacionado con calles, carreteras o movilidad en México, o si no incluye una ubicación útil. Una balacera, delito o emergencia dentro de una escuela, vivienda o inmueble sin afectación vial debe marcarse como irrelevante. Distingue el TIPO DE EVENTO de su ESTADO VIAL ACTUAL. event_type describe qué ocurrió; traffic_status describe cómo está la circulación AHORA. Si el texto actual dice "tránsito fluido", "circulación normal", "vía libre", "se restablece", "reabierta" o equivalente, usa flowing/restored aunque se mencione un bloqueo o cierre previo. Usa blocked/closed únicamente cuando el texto indique que la afectación sigue activa; partial para cierre/reducción parcial; slow para tránsito lento. Extrae el sentido de circulación cuando aparezca (por ejemplo: hacia Querétaro o dirección CDMX). Extrae también una referencia física explícita si aparece: caseta, plaza de cobro, entronque, puente, distribuidor vial, localidad, colonia o punto conocido cercano. Si la ubicación expresa un cruce o tramo entre dos vialidades (por ejemplo "Av. 608 hasta Av. 412", "entre X y Y", "esquina con" o "cruce con"), conserva ambas vialidades en ubicacion. Convierte kilómetros con formato 66+500 a 66.5. No inventes datos ni coordenadas. Si rechazas usa valido=false, categoria=irrelevant y cadenas vacías cuando no exista el dato. Resume el hecho sin agregar información. TEXTO: ${text.slice(0, 800)}`;
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
              ubicacion: { type: ['string', 'null'] },
              carretera: { type: ['string', 'null'] },
              kilometro: { type: ['number', 'null'] },
              referencia: { type: ['string', 'null'] },
              municipio: { type: ['string', 'null'] },
              estado: { type: ['string', 'null'] },
              categoria: { type: 'string', enum: ['road', 'security', 'irrelevant'] },
              severidad: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              event_type: { type:'string', enum:['traffic_update','crash','closure','blockage','protest','road_hazard','security_incident','emergency','other'] },
              traffic_status: { type:'string', enum:['flowing','slow','partial','blocked','closed','restored','unknown'] },
              resumen: { type: ['string', 'null'] },
              detail: { type: ['string', 'null'] },
              sentido: { type: ['string', 'null'] }
            },
            required: ['valido', 'ubicacion', 'carretera', 'kilometro', 'referencia', 'municipio', 'estado', 'categoria', 'severidad', 'event_type', 'traffic_status', 'resumen', 'detail', 'sentido']
          }
        }
      },
      messages: [
      { role: 'system', content: 'Eres analista de seguridad vial y logística en México.' },
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
    method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(20_000),
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

async function classify(text) {
  const prompt=classificationPrompt(text);
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

async function geocode(query, expectedState, precision = 'zone') {
  const confidenceCaps = { exact:.97, intersection:.94, reference:.92, kilometer:.9, road:.82, zone:.7, municipality:.58, state:.38 };
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
          const rankConfidence=Number(result.rank?.confidence);
          const confidence=Math.min(cap, Number.isFinite(rankConfidence) ? rankConfidence : .62);
          const label=result.formatted || query;
          const score=geocodeCandidateScore(query,label,stateMatches(expectedState,resolvedState),confidence,precision);
          return score>-900 ? { latitude:lat, longitude:lon, label, confidence, status:confidence >= .82 ? 'automatic' : 'approximate', precision, score } : null;
        }).filter(Boolean).sort((a,b)=>b.score-a.score);
        if(ranked.length) {
          const best=ranked[0]; delete best.score; return best;
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
            const confidence=Math.min(cap,({ROOFTOP:.97,RANGE_INTERPOLATED:.9,GEOMETRIC_CENTER:.82,APPROXIMATE:.55})[type]||.5);
            const label=result.formatted_address || query;
            const score=geocodeCandidateScore(query,label,stateMatches(expectedState,resolvedState),confidence,precision);
            return score>-900 ? {latitude:lat,longitude:lon,label,confidence,status:confidence>=.82?'automatic':'approximate',precision,score} : null;
          }).filter(Boolean).sort((a,b)=>b.score-a.score);
          if(ranked.length){const best=ranked[0]; delete best.score; return best;}
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
  const base = ['motorway','trunk','primary','secondary','road'].includes(result.type) ? .72 : result.type === 'administrative' ? .5 : .62;
  return { latitude:lat, longitude:lon, label:result.display_name, confidence:Math.min(cap,base), status:'approximate', precision };
}

function geoDistanceKm(aLat, aLon, bLat, bLon) {
  const r = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const x = Math.sin(dLat/2) ** 2 + Math.cos(aLat*Math.PI/180) * Math.cos(bLat*Math.PI/180) * Math.sin(dLon/2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
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

function tollKey(value) {
  return norm(value)
    .replace(/\b(caseta|casetas|plaza|plazas|cobro|peaje|de|del|la|el|nro|no|numero|km)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  return Math.round((common/Math.max(aa.size,bb.size))*90);
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
    log('info','Kilómetro resuelto con RED_VIAL',{ road:ai.carretera, kilometer, corridor:staticKm.corridor, confidence:staticKm.confidence });
    return staticKm;
  }
  const candidates = [];
  const queries = [
    { query:[reference, ai.carretera, ai.municipio, ai.estado].map(clean).filter(Boolean).join(', '), precision:'reference' },
    { query:[ai.carretera, kilometer != null ? 'km ' + kilometer : '', reference, ai.municipio, ai.estado].map(clean).filter(Boolean).join(', '), precision:'kilometer' },
    { query:[ai.carretera, ai.municipio, ai.estado].map(clean).filter(Boolean).join(', '), precision:'road' }
  ].filter(x => x.query.length >= 4).filter((x,i,a) => a.findIndex(y => y.query === x.query) === i);
  for (const candidate of queries) {
    const result = await geocode(candidate.query, ai.estado, candidate.precision);
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
  const candidates = [ai.ubicacion, ai.referencia].map(clean).filter(Boolean);
  for (const candidate of candidates) {
    const parts = intersectionParts(candidate);
    if (parts) return parts;
  }
  return null;
}

async function resolveUrbanIntersection(ai) {
  if (ai.carretera) return null;
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

async function processItem(item, feed) {
  const externalId = hash(item.url || item.title + '|' + item.published_at);
  if (await alreadyExists(externalId)) return 'duplicate';
  const ai = await classify((item.title + '. ' + item.body).slice(0, 1400));
  if (!ai?.valido || !['road','security'].includes(ai.categoria)) return 'rejected';
  const title = clean(ai.resumen);
  const detail = clean(ai.detail);
  if (title.length < 8 || detail.length < 15) return 'rejected';
  const kilometer = normalizedKilometer(ai.kilometro, item.title + ' ' + item.body);
  const direction = clean(ai.sentido);
  const reference = clean(ai.referencia);
  const trafficStatus = normalizedTrafficStatus(ai, item.title + ' ' + item.body);
  const eventType = ['traffic_update','crash','closure','blockage','protest','road_hazard','security_incident','emergency','other'].includes(String(ai.event_type||'').toLowerCase()) ? String(ai.event_type).toLowerCase() : 'other';
  const municipality = usableMunicipality(ai.municipio, ai.estado);
  const explicitIntersection = !ai.carretera ? urbanIntersection(ai) : null;
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
  if (geo) log('info','Caseta resuelta con CASETAS',{ reference, matched:geo.matched_reference, score:geo.match_score, confidence:geo.confidence });
  if (!geo) geo = await resolveRoadLocation(ai, kilometer, reference);
  if (!geo) {
    geo = await resolveUrbanIntersection({ ...ai, municipio:municipality });
    if (geo) log('info','Intersección urbana resuelta',{ location:clean(ai.ubicacion), municipality, state:clean(ai.estado), confidence:geo.confidence });
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
  if (!geo) {
    for (const candidate of locationQueries) {
      geo = await geocode(candidate.query, ai.estado, candidate.precision);
      if (geo) break;
      if (!GEOAPIFY_KEY && !GOOGLE_KEY) await sleep(1100);
    }
  }
  if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return 'no_location';
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
  const stats = { received:0, relevant:0, queued_new:0, queue_pending:0, queue_failed:0, queue_oldest_min:0, analyzed:0, inserted:0, duplicates:0, rejected:0, no_location:0, errors:0, rate_limited:0, groq_used:0, gemini_used:0, ai_cooldown_seconds:0, ai_budget_wait_seconds:0, ai_max_per_hour:AI_MAX_PER_HOUR, avg_source_delay_min:0, max_source_delay_min:0, location_success_rate_pct:0 };
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
      if (Date.now() < groqCooldownUntil && !GEMINI_KEY) {
        stats.ai_cooldown_seconds = Math.ceil((groqCooldownUntil - Date.now()) / 1000);
        break;
      }
      if (Date.now() < aiNextAllowedAt) {
        stats.ai_budget_wait_seconds = Math.ceil((aiNextAllowedAt - Date.now()) / 1000);
        break;
      }
      stats.analyzed++;
      aiNextAllowedAt = Date.now() + AI_MIN_INTERVAL_MS;
      await updateQueue(externalId, { status:'processing', processing_started_at:new Date().toISOString() });
      try {
        const result = await processItem(item, feed);
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
