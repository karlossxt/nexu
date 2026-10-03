// Función serverless para Vercel: /api/config
// Devuelve la configuración no sensible (feeds RSS y modelo por defecto)
// desde las Variables de Entorno. Permite cambiar fuentes sin tocar código.

const DEFAULT_RSS_SEC = 'https://news.google.com/rss/search?q=accidente+OR+bloqueo+OR+asalto+carretera+mexico&hl=es-419&gl=MX&ceid=MX:es-419';
// La publishable key de Supabase está diseñada para ser visible en el cliente.
// Las variables de Vercel tienen prioridad para permitir rotarla sin desplegar código.
const DEFAULT_SUPABASE_URL = 'https://hjymytmsstmhivjdtxso.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_iJtw2kIhrCr1dSkKL8Mg3w_IWtbdIep';

function validIp(value) {
  const ip=String(value||'').trim().replace(/^::ffff:/,'');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split('.').every(part=>Number(part)>=0 && Number(part)<=255) ? ip : '';
  }
  return /^[0-9a-f:]{2,45}$/i.test(ip) && ip.includes(':') ? ip.toLowerCase() : '';
}
function remoteIp(req) {
  const candidates=[
    req.headers['x-vercel-forwarded-for'],
    req.headers['x-forwarded-for'],
    req.headers['x-real-ip'],
    req.socket && req.socket.remoteAddress
  ];
  for (const raw of candidates) {
    const first=String(raw||'').split(',')[0].trim();
    const ip=validIp(first);
    if (ip) return ip;
  }
  return 'anon';
}

const rate = new Map();
let globalRate={n:0,t:Date.now()};
function rateLimited(ip) {
  const now=Date.now();
  if (now-globalRate.t>60000) globalRate={n:0,t:now};
  globalRate.n+=1;
  if (globalRate.n>600) return true;
  const cur=rate.get(ip)||{n:0,t:now};
  if (now-cur.t>60000) {cur.n=0;cur.t=now;}
  cur.n+=1;
  rate.set(ip,cur);
  if (rate.size>2000) {
    for (const [key,value] of rate) if (now-value.t>120000) rate.delete(key);
    if (rate.size>2000) rate.delete(rate.keys().next().value);
  }
  return cur.n>120;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'método no permitido' });
  if (rateLimited(remoteIp(req))) {
    res.setHeader('Retry-After','60');
    res.setHeader('Cache-Control','no-store');
    return res.status(429).json({ error:'demasiadas peticiones' });
  }

  const rssPri = (process.env.RSS_PRI || '').trim();
  const rssSec = (process.env.RSS_SEC || '').trim();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=120');
  return res.status(200).json({
    rss: [rssPri, rssSec || DEFAULT_RSS_SEC],
    model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    reportModel: process.env.REPORT_MODEL || 'openai/gpt-oss-120b',
    supabase: {
      url: (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim(),
      anonKey: (process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY).trim()
    }
  });
};
