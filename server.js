// Servidor local sin dependencias: sirve index.html y /api/groq (proxy seguro).
// Uso: node server.js  =>  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

function loadEnv() {
  const env = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    txt.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) { /* sin .env */ }
  return env;
}

const ENV = Object.assign(loadEnv(), process.env);
const GROQ_KEY = ENV.GROQ_API_KEY || '';
const APP_TOKEN = ENV.APP_TOKEN || '';
const MODELS_ALLOWED = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'allam-2-7b', 'meta-llama/llama-prompt-guard-2-86m'];
const MAX_BODY = 64 * 1024;
const MAX_PER_MIN = 40;
const rate = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function remoteIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'anon';
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
  const p = JSON.parse(body);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/groq') {
    if (!GROQ_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'GROQ_API_KEY no configurada en .env' }));
    }
    if (APP_TOKEN && req.headers['x-app-token'] !== APP_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'token de acceso requerido' }));
    }
    if (rateLimited(remoteIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'demasiadas peticiones, espera un minuto' }));
    }
    try {
      if (req.method === 'GET' && url.searchParams.get('action') === 'models') {
        const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + GROQ_KEY } });
        const data = await r.json();
        const ids = (data.data || []).filter((m) => MODELS_ALLOWED.includes(m.id)).map((m) => m.id);
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: ids }));
      }
      if (req.method === 'POST') {
        const payload = sanitizePayload(await readBody(req));
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
          body: JSON.stringify(payload),
        });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(await r.text());
      }
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'método no permitido' }));
    } catch (e) {
      const msg = String((e && e.message) || e);
      const code = (msg === 'body demasiado grande' || msg.startsWith('payload') || msg === 'modelo no permitido') ? 400 : 502;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: msg }));
    }
  }

  if (url.pathname === '/api/config') {
    const rssPri = String(ENV.RSS_PRI || '').trim();
    const rssSec = String(ENV.RSS_SEC || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      rss: [rssPri, rssSec || 'https://news.google.com/rss/search?q=accidente+OR+bloqueo+OR+asalto+carretera+mexico&hl=es-419&gl=MX&ceid=MX:es-419'],
      model: ENV.GROQ_MODEL || 'openai/gpt-oss-20b',
      reportModel: ENV.REPORT_MODEL || 'openai/gpt-oss-120b'
    }));
  }

  if (url.pathname === '/api/feed') {
    try {
      const feedHandler = require('./api/feed.js');
      // Adaptador: api/feed.js espera API estilo Vercel (req.query, res.status().json())
      const q = {};
      for (const [k, v] of url.searchParams) { q[k] = v; }
      const adaptReq = {
        method: req.method,
        headers: req.headers,
        query: q,
        socket: req.socket || { remoteAddress: null }
      };
      const adaptRes = {
        _code: 200,
        _headers: {},
        status(c) { this._code = c; return this; },
        json(obj) {
          res.writeHead(this._code, Object.assign({ 'Content-Type': 'application/json' }, this._headers));
          res.end(JSON.stringify(obj));
        },
        end() { res.end(); }
      };
      feedHandler(adaptReq, adaptRes);
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  }

  const filePath = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`NEXUS VIAL disponible en http://localhost:${PORT}`);
});