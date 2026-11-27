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
const ROLES_ALLOWED = new Set(['system', 'user', 'assistant']);
const MAX_BODY = 64 * 1024;
const MAX_PER_MIN = 40;
const UPSTREAM_TIMEOUT_MS = 30_000;
const MODELS_TIMEOUT_MS = 15_000;
const crypto = require('crypto');
const { sharedRateLimited } = require('../lib/shared-rate-limit');
// En producción el token es obligatorio: sin él /api/groq quedaría abierto a cualquiera.
const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production' || !!process.env.VERCEL || !!process.env.RENDER;

// Comparación en tiempo constante (SHA-256 iguala el largo antes de timingSafeEqual).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const rate = new Map();

function remoteIp(req) {
  const fwd = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
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
  const messages = p.messages.slice(0, 10).map((m) => {
    if (!m || typeof m !== 'object') throw new Error('payload inválido');
    const role = String(m.role || 'user');
    if (!ROLES_ALLOWED.has(role)) throw new Error('payload inválido: rol no permitido');
    return { role, content: String(m.content || '').slice(0, 4000) };
  });
  if (messages[0] && messages[0].role !== 'system') throw new Error('falta system');
  const out = { model, messages };
  if (typeof p.temperature === 'number' && Number.isFinite(p.temperature)) out.temperature = Math.min(1, Math.max(0, p.temperature));
  if (Number.isInteger(p.max_tokens) && p.max_tokens > 0) out.max_tokens = Math.min(2048, p.max_tokens);
  return out;
}

module.exports = async (req, res) => {
  const key = process.env.GROQ_API_KEY || '';
  const appToken = process.env.APP_TOKEN || '';
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY no configurada en Vercel' });
  if (IS_PROD && !appToken) return res.status(500).json({ error: 'APP_TOKEN no configurado en el servidor' });
  // El límite de uso va PRIMERO para que los intentos con token incorrecto también cuenten.
  const clientIp = remoteIp(req);
  if (rateLimited(clientIp) || await sharedRateLimited('groq', clientIp, MAX_PER_MIN)) return res.status(429).json({ error: 'demasiadas peticiones, espera un minuto' });
  if (appToken && !safeEqual(req.headers['x-app-token'], appToken)) return res.status(403).json({ error: 'token de acceso requerido' });

  try {
    // GET /api/groq?action=models
    if (req.method === 'GET' && (req.query && req.query.action === 'models')) {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
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
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      return res.status(r.status).json(await r.json());
    }

    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    if (e && e.name === 'TimeoutError') return res.status(504).json({ error: 'el proveedor tardó demasiado' });
    const msg = String((e && e.message) || e);
    const code = (msg === 'body demasiado grande' || msg.startsWith('payload') || msg === 'modelo no permitido') ? 400 : 502;
    return res.status(code).json({ error: msg });
  }
};