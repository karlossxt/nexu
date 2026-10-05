'use strict';
// Servidor sin dependencias: sirve el frontend y expone /api/groq (proxy), /api/config,
// /api/feed y /api/geocode.
// Uso: node server.js  =>  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const { HttpError, sendJson, remoteIp, createRateLimiter, safeEqual } = require('./lib/http-utils');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DEFAULT_FEED = 'https://news.google.com/rss/search?q=accidente+OR+bloqueo+OR+asalto+carretera+mexico&hl=es-419&gl=MX&ceid=MX:es-419';

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
// En producción exige un token: sin esto, /api/groq queda abierto a cualquiera.
const IS_PROD = (ENV.NODE_ENV || '').toLowerCase() === 'production' || !!ENV.VERCEL || !!ENV.RENDER;
if (IS_PROD && !APP_TOKEN) {
  console.warn('[ADVERTENCIA] APP_TOKEN no está configurado en producción. /api/groq quedará deshabilitado hasta configurarlo.');
}

// IP del cliente. Solo se confía en x-forwarded-for detrás de un proxy conocido, y se toma la
// entrada que añade NUESTRO proxy (contando desde la derecha), porque la primera entrada
// puede ser falsificada por el cliente. TRUSTED_PROXY_HOPS = nº de proxies de confianza
// delante de la app (Render/Vercel: 1; Cloudflare + Render: 2).
const TRUST_PROXY = !!ENV.VERCEL || !!ENV.RENDER || ENV.TRUST_PROXY === '1';
const PROXY_HOPS = Math.max(1, parseInt(ENV.TRUSTED_PROXY_HOPS, 10) || 1);

const MODELS_ALLOWED = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'allam-2-7b', 'meta-llama/llama-prompt-guard-2-86m'];
const ROLES_ALLOWED = new Set(['system', 'user', 'assistant']);
const MAX_BODY = 64 * 1024;
const MAX_PER_MIN = 40;
const UPSTREAM_TIMEOUT_MS = 30_000;

const groqLimiter = createRateLimiter({ maxPerMin: MAX_PER_MIN, maxEntries: 2000 });

// Solo estos archivos son públicos. Todo lo demás (server.js, worker/, supabase/, .env, .git/)
// da 404. Si agregas páginas o assets, inclúyelos aquí o en EXTRA_PUBLIC_FILES (separados por coma).
const PUBLIC_FILES = new Set([
  'index.html', 'acerca.html', 'ayuda.html', 'servicios.html', 'privacidad.html', 'terminos.html',
  'red-vial.js', 'favicon.png', 'favicon-256.png', 'apple-touch-icon.png',
  'logo11.png', 'logo11-white.png', 'zero-logo.png', 'zero-mark.png', 'zero-mark-v2.svg',
  'logo-mark.webp', 'casetas-data.js',
  'sitemap.xml', 'robots.txt',
  ...String(ENV.EXTRA_PUBLIC_FILES || '').split(',').map(s => s.trim()).filter(Boolean)
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function rateLimited(ip) {
  return groqLimiter.isLimited(ip);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body demasiado grande');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sanitizePayload(body) {
  let p;
  try { p = JSON.parse(body); } catch { throw new HttpError(400, 'JSON inválido'); }
  if (!p || typeof p !== 'object' || !Array.isArray(p.messages) || p.messages.length === 0) {
    throw new HttpError(400, 'payload inválido');
  }
  const model = String(p.model || '');
  if (!MODELS_ALLOWED.includes(model)) throw new HttpError(400, 'modelo no permitido');
  const messages = p.messages.slice(0, 10).map((m) => {
    if (!m || typeof m !== 'object') throw new HttpError(400, 'payload inválido');
    const role = String(m.role || 'user');
    if (!ROLES_ALLOWED.has(role)) throw new HttpError(400, 'rol no permitido');
    return { role, content: String(m.content || '').slice(0, 4000) };
  });
  if (messages[0].role !== 'system') throw new HttpError(400, 'falta system');
  const out = { model, messages };
  if (typeof p.temperature === 'number' && Number.isFinite(p.temperature)) out.temperature = Math.min(1, Math.max(0, p.temperature));
  if (Number.isInteger(p.max_tokens) && p.max_tokens > 0) out.max_tokens = Math.min(2048, p.max_tokens);
  return out;
}

// Adaptador para handlers estilo Vercel (api/*.js): req.query, res.status().json(), res.setHeader().
async function runVercelStyle(modulePath, req, res, url) {
  const handler = require(modulePath);
  const headers = {};
  let code = 200;
  const adaptRes = {
    setHeader(k, v) { headers[k] = v; return adaptRes; },
    getHeader(k) { return headers[k]; },
    status(c) { code = c; return adaptRes; },
    json(obj) { sendJson(res, code, obj, headers); },
    send(body) { res.writeHead(code, headers); res.end(body); },
    end(body) { res.writeHead(code, headers); res.end(body); },
  };
  const adaptReq = {
    method: req.method,
    headers: req.headers,
    query: Object.fromEntries(url.searchParams),
    socket: req.socket,
  };
  await handler(adaptReq, adaptRes);
}

async function handleGroq(req, res, url) {
  if (!GROQ_KEY) return sendJson(res, 500, { error: 'GROQ_API_KEY no configurada en .env' });
  if (IS_PROD && !APP_TOKEN) return sendJson(res, 500, { error: 'APP_TOKEN no configurado en el servidor' });
  // El rate limit va PRIMERO para que los intentos con token incorrecto también cuenten.
  if (rateLimited(remoteIp(req))) return sendJson(res, 429, { error: 'demasiadas peticiones, espera un minuto' });
  if (APP_TOKEN && !safeEqual(req.headers['x-app-token'], APP_TOKEN)) {
    return sendJson(res, 403, { error: 'token de acceso requerido' });
  }
  try {
    if (req.method === 'GET' && url.searchParams.get('action') === 'models') {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: 'Bearer ' + GROQ_KEY },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
      const data = await r.json();
      const ids = (data.data || []).filter((m) => MODELS_ALLOWED.includes(m.id)).map((m) => m.id);
      return sendJson(res, r.status, { data: ids });
    }
    if (req.method === 'POST') {
      const payload = sanitizePayload(await readBody(req));
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
      const text = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(text);
    }
    return sendJson(res, 405, { error: 'método no permitido' });
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    if (e && e.name === 'TimeoutError') return sendJson(res, 504, { error: 'el proveedor tardó demasiado' });
    console.error('[groq]', e && e.message ? e.message : e);
    return sendJson(res, 502, { error: 'error al contactar al proveedor' });
  }
}

function handleConfig(res) {
  const rssPri = String(ENV.RSS_PRI || '').trim();
  const rssSec = String(ENV.RSS_SEC || '').trim();
  // RSS_PRI puede ser un feed privado: no se envía al navegador salvo que lo pidas
  // explícitamente con EXPOSE_RSS_PRI=1. El worker lo lee directo del entorno.
  const exposePri = ENV.EXPOSE_RSS_PRI === '1';
  return sendJson(res, 200, {
    // Posiciones fijas: el frontend lee cfg.rss[0] (primario) y cfg.rss[1] (secundario).
    // Sin filter(Boolean), si RSS_PRI está oculto el secundario caería en el campo primario.
    rss: [exposePri ? rssPri : '', rssSec || DEFAULT_FEED],
    model: ENV.GROQ_MODEL || 'openai/gpt-oss-20b',
    reportModel: ENV.REPORT_MODEL || 'openai/gpt-oss-120b',
    supabase: {
      url: String(ENV.SUPABASE_URL || '').trim(),
      anonKey: String(ENV.SUPABASE_ANON_KEY || '').trim()
    }
  }, { 'Cache-Control': 'no-store' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  rel = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(rel) && PUBLIC_FILES.has(rel + '.html')) rel += '.html'; // /acerca -> acerca.html
  if (!PUBLIC_FILES.has(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  fs.readFile(path.join(ROOT, rel), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(rel).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.writeHead(400); return res.end(); }

  try {
    if (url.pathname === '/api/groq') return await handleGroq(req, res, url);
    if (url.pathname === '/api/config') return handleConfig(res);
    if (url.pathname === '/api/feed' || url.pathname === '/api/geocode') {
      try {
        return await runVercelStyle('./' + url.pathname.slice(1) + '.js', req, res, url);
      } catch (e) {
        console.error('[' + url.pathname + ']', e && e.stack ? e.stack : e);
        if (!res.headersSent) return sendJson(res, 500, { error: 'error interno' });
        return res.end();
      }
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('[server]', e && e.stack ? e.stack : e);
    if (!res.headersSent) return sendJson(res, 500, { error: 'error interno' });
    res.end();
  }
});

server.requestTimeout = 30_000;

server.listen(PORT, () => {
  console.log(`ZERO VIAL disponible en http://localhost:${PORT}`);
});

// Cierre limpio (Render/Vercel envían SIGTERM en cada deploy).
function shutdown(signal) {
  console.log(`[${signal}] cerrando servidor…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
