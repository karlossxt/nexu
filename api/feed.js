// Función serverless para Vercel: /api/feed
// Trae un feed RSS (XML o JSON) desde el servidor y devuelve los ítems como JSON.
// Así el navegador evita bloqueos CORS y proxies públicos poco fiables.

const MAX_OUT = 30;
const MAX_PER_MIN = 60;
const rate = new Map();

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
        content_text: String(it.description_text || it.description_html || it.description || it.content || '').trim()
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
      content_text: stripHtml(tag(/<description[^>]*>([\s\S]*?)<\/description>/i, block))
    });
  }
  return items.slice(0, MAX_OUT);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'método no permitido' });
  if (rateLimited(remoteIp(req))) return res.status(429).json({ error: 'demasiadas peticiones, espera un minuto' });

  const url = String((req.query && req.query.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url inválida' });
  if (url.length > 800) return res.status(400).json({ error: 'url demasiado larga' });

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NEXUS VIAL; monitoreo vial)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = parseRssItems(await r.text());
    return res.status(200).json({ items });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return res.status(502).json({ error: msg });
  }
};