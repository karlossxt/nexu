// Función serverless para Vercel: /api/feed
// Trae un feed RSS (XML o JSON) desde el servidor y devuelve los ítems como JSON.
// Así el navegador evita bloqueos CORS y proxies públicos poco fiables.

const MAX_OUT = 30;
const MAX_PER_MIN = 60;
const rate = new Map();
const ALLOWED_FEED_HOSTS = ['rss.app', 'news.google.com'];

function allowedFeedUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_FEED_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
  } catch (e) { return false; }
}

// === FILTRO: solo incidentes viales/seguridad en México ===
const ARR = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const MX_STATES = ['aguascalientes','baja california','baja california sur','campeche','chiapas','chihuahua','coahuila','colima','durango','guanajuato','guerrero','hidalgo','jalisco','michoaca','morelos','nayarit','nuevo leon','oaxaca','puebla','queretaro','quintana roo','san luis potosi','sinaloa','sonora','tabasco','tamaulipas','tlaxcala','veracruz','yucatan','zacatecas','cdmx','ciudad de mexico','estado de mexico','edomex'];
const MX_CITIES = ['guadalajara','monterrey','tijuana','ciudad juarez','juarez','leon','merida','toluca','mexicali','acapulco','cuernavaca','mazatlan','culiacan','laredo','tampico','xalapa','pachuca','morelia','saltillo','torreon','hermosillo','durango','oaxaca','villahermosa','cancun','chihuahua','puebla','utestaca','quintana roo','veracruz','colima','texcoco','zapopan','pescador','tultitlan','ecatepec','tlalnepantla','naucalpan','tixtla','zihuatanejo','taxco','iguala','chilpancingo'];
const VIAL_WORDS = ['carretera','autopista','vial','tramo','choque','accidente','volcadura','incendio','derrumbe','deslave','bloqueo','cierre','caseta','puente','pavimento','lluvia','niebla','neblina','inundaci','carril','circul','camion','trailer','derrape','mirador','km ','kilometro','obra','derribo','circulacion','reduccion'];
const FOREIGN = ['cuba','venezuela','ecuador','espana','chile','argentina','colombia','peru','bolivia','honduras','guatemala','belice','estados unidos','ee.uu','china','rusia','ucrania','irak','iran','israel','palestina','marro','ceuta','marruecos','arabia','hutie','yemen','africa','tiktok','spotify','youtube','netflix','futbol','fpc','barquisimeto','sismo detector'];
function mexVialScore(text) {
  const t = ARR(text);
  let mex = 0, vial = 0, fori = 0;
  MX_STATES.forEach(s => { if (t.includes(s)) mex += 3; });
  MX_CITIES.forEach(c => { if (t.includes(c)) mex += 2; });
  if (t.includes('alcaldia')) mex += 1;
  VIAL_WORDS.forEach(w => { if (t.includes(w)) vial += 1; });
  if (/\bkm\s*\d/i.test(t)) vial += 2;
  FOREIGN.forEach(f => { if (t.includes(f)) fori += 1; });
  if (fori >= 2) return { keep: false, score: -99 };
  if (fori >= 1 && vial === 0) return { keep: false, score: -50 };
  if (vial >= 1 && mex >= 1) return { keep: true, score: vial + mex - fori };
  if (vial >= 2 && fori === 0) return { keep: true, score: vial + mex };
  return { keep: false, score: vial + mex - fori };
}

function remoteIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'anon';
}

function rateLimited(ip) {
  const now = Date.now();
  const cur = rate.get(ip) || { n: 0, t: now };
  if (now - cur.t > 60000) { cur.n = 0; cur.t = now; }
  cur.n += 1;
  rate.set(ip, cur);
  return cur.n > MAX_PER_MIN;
}

function tag(re, s) { const m = s.match(re); return m ? m[1] : ''; }
function stripHtml(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&#0?8232;/g, ' ').trim();
}

function cleanSourceName(value) {
  const raw = stripHtml(String(value || '')).trim();
  if (!raw || raw === '[object Object]' || /^fuente rss$/i.test(raw) || /^(?:www\.)?rss\.app$/i.test(raw)) return '';
  const handle = raw.replace(/^@/, '');
  const key = handle.toLowerCase().replace(/[_\s-]+/g, '');
  const known = {
    capufe: 'CAPUFE',
    gncarreteras: 'Guardia Nacional Carreteras',
    ovialcdmx: 'OVIAL CDMX',
    ssccdmx: 'SSC CDMX',
    conaguaclima: 'CONAGUA Clima'
  };
  if (known[key]) return known[key];
  if (/^[\w.-]+\.[a-z]{2,}$/i.test(handle)) {
    const brand = handle.replace(/^www\./i, '').split('.')[0];
    return brand.charAt(0).toUpperCase() + brand.slice(1);
  }
  return handle.replace(/_/g, ' ').slice(0, 80);
}

function sourceName(it, feedUrl) {
  const raw = String((it && (it.source_name || it.source || it.author)) || '').trim();
  const cleaned = cleanSourceName(raw);
  if (cleaned) return cleaned;
  const hay = ARR(String((it && it.title) || '') + ' ' + String(feedUrl || ''));
  if (hay.includes('capufe')) return 'CAPUFE';
  if (hay.includes('guardia nacional')) return 'Guardia Nacional';
  try { return new URL(feedUrl).hostname.replace(/^www\./, '').slice(0, 80); } catch (e) { return 'Fuente RSS'; }
}

function parseRssItems(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data;
    try { data = JSON.parse(trimmed); } catch (e) { return []; }
    let list = [];
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.items)) list = data.items;
    else if (data.data && Array.isArray(data.data) && data.data.length && Array.isArray(data.data[0].items)) list = data.data.flatMap(f => f.items || []);
    else if (Array.isArray(data.channel)) list = data.channel;
    return list
      .filter(it => it && (it.title || it.description_text))
      .slice(0, MAX_OUT)
      .map(it => ({
        title: String(it.title || it.description_text || '').trim(),
        content_text: String(it.description_text || it.description_html || it.description || it.content || '').trim(),
        source_name: String(it.source_name || it.source || it.author || '').trim().slice(0, 80)
      }));
  }

  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(trimmed))) {
    const block = m[0];
    const title = stripHtml(tag(/<title[^>]*>([\s\S]*?)<\/title>/i, block));
    if (title) items.push({
      title,
      content_text: stripHtml(tag(/<description[^>]*>([\s\S]*?)<\/description>/i, block)),
      source_name: cleanSourceName(tag(/<(?:dc:creator|source|author)[^>]*>([\s\S]*?)<\/(?:dc:creator|source|author)>/i, block))
    });
  }
  return items.slice(0, MAX_OUT);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'método no permitido' });
  if (rateLimited(remoteIp(req))) return res.status(429).json({ error: 'demasiadas peticiones, espera un minuto' });

  const url = String((req.query && req.query.url) || '').trim();
  if (!allowedFeedUrl(url)) return res.status(400).json({ error: 'fuente RSS no autorizada' });
  if (url.length > 800) return res.status(400).json({ error: 'url demasiado larga' });

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NEXUS VIAL; monitoreo vial)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = parseRssItems(await r.text());
    const kept = items
      .filter(it => it.title.trim().length >= 8 && String(it.content_text || '').trim().length >= 15)
      .filter(it => mexVialScore(it.title + ' ' + (it.content_text || '')).keep)
      .map(it => ({ ...it, source_name: (!it.source_name || it.source_name === 'Fuente RSS') ? sourceName(it, url) : it.source_name }));
    return res.status(200).json({ items: kept, total: items.length, kept: kept.length });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return res.status(502).json({ error: msg });
  }
};
