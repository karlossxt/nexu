// Servidor local sin dependencias: sirve index.html y /api/groq (proxy).
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
  } catch (e) { /* sin .env, usa variables de entorno del sistema */ }
  return env;
}

const GROQ_KEY = process.env.GROQ_API_KEY || loadEnv().GROQ_API_KEY;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/groq') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!GROQ_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'GROQ_API_KEY no configurada en .env' }));
    }
    try {
      if (url.searchParams.get('action') === 'models') {
        const r = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': 'Bearer ' + GROQ_KEY },
        });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(await r.text());
      }
      const body = await readBody(req);
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        body: body || '{}',
      });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
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
  console.log(`CENTRAL-STEELE disponible en http://localhost:${PORT}`);
});