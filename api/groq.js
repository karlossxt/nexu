// Función serverless para Vercel: /api/groq
// La key de Groq se lee de las Variables de Entorno y NUNCA se expone al navegador.
// Seguridad: solo mismo-origen, métodos restringidos, body con límite,
// modelo de allowlist, rate limit por IP y token de acceso opcional (APP_TOKEN).

const MODELS_ALLOWED = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
  'meta-llama/llama-prompt-guard-2-86m',
];
const MAX_BODY = 64 * 1024;
const MAX_PER_MIN = 40;
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

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body demasiado grande');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sanitizePayload(body) {
  const p = typeof body === 'string' ? JSON.parse(body) : body;
  if (!p || !Array.isArray(p.messages) || p.messages.length === 0) throw new Error('payload inválido');
  const model = String(p.model || '');
  if (!MODELS_ALLOWED.includes(model)) throw new Error('modelo no permitido');
  const messages = p.messages.slice(0, 10).map((m) => ({
    role: String(m.role || 'user').slice(0, 20),
    content: String(m.content || '').slice(0, 4000),
  }));
  if (messages[0] && messages[0].role !== 'system') throw new Error('falta system');
  const out = { model, messages };
  if (typeof p.temperature === 'number') out.temperature = Math.min(1, Math.max(0, p.temperature));
  if (Number.isInteger(p.max_tokens) && p.max_tokens > 0) out.max_tokens = Math.min(2048, p.max_tokens);
  return out;
}

module.exports = async (req, res) => {
  const key = process.env.GROQ_API_KEY || '';
  const appToken = process.env.APP_TOKEN || '';
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY no configurada en Vercel' });
  if (appToken && req.headers['x-app-token'] !== appToken) return res.status(403).json({ error: 'token de acceso requerido' });
  if (rateLimited(remoteIp(req))) return res.status(429).json({ error: 'demasiadas peticiones, espera un minuto' });

  try {
    // GET /api/groq?action=models
    if (req.method === 'GET' && (req.query && req.query.action === 'models')) {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key } });
      const data = await r.json();
      const ids = (data.data || []).filter((m) => MODELS_ALLOWED.includes(m.id)).map((m) => m.id);
      return res.status(r.status).json({ data: ids });
    }

    // POST /api/groq
    if (req.method === 'POST') {
      let raw = '';
      if (typeof req.body === 'string') raw = req.body;
      else if (req.body && typeof req.body === 'object') raw = JSON.stringify(req.body);
      else raw = await readBody(req);
      const payload = sanitizePayload(raw);
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(payload),
      });
      return res.status(r.status).json(await r.json());
    }

    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const code = (msg === 'body demasiado grande' || msg.startsWith('payload') || msg === 'modelo no permitido') ? 400 : 502;
    return res.status(code).json({ error: msg });
  }
};