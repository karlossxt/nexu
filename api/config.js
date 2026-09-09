// Función serverless para Vercel: /api/config
// Devuelve la configuración no sensible (feeds RSS y modelo por defecto)
// desde las Variables de Entorno. Permite cambiar fuentes sin tocar código.

const DEFAULT_RSS_SEC = 'https://news.google.com/rss/search?q=accidente+OR+bloqueo+OR+asalto+carretera+mexico&hl=es-419&gl=MX&ceid=MX:es-419';

function remoteIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'anon';
}

const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const cur = rate.get(ip) || { n: 0, t: now };
  if (now - cur.t > 60000) { cur.n = 0; cur.t = now; }
  cur.n += 1;
  rate.set(ip, cur);
  return cur.n > 120;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'método no permitido' });
  if (rateLimited(remoteIp(req))) return res.status(429).json({ error: 'demasiadas peticiones' });

  const rssPri = (process.env.RSS_PRI || '').trim();
  const rssSec = (process.env.RSS_SEC || '').trim();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=120');
  return res.status(200).json({
    rss: [rssPri, rssSec || DEFAULT_RSS_SEC],
    model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    reportModel: process.env.REPORT_MODEL || 'openai/gpt-oss-120b'
  });
};
