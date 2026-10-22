'use strict';
// Regresión de los dos bugs del parche: assets que server.js debe servir y
// archivos que vercel.json debe desplegar. Arranca el servidor real en un
// puerto libre y comprueba las respuestas HTTP.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('El servidor no arrancó a tiempo.\nstdout: ' + out + '\nstderr: ' + err));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onOut);
      child.stderr.off('data', onErr);
      child.off('exit', onExit);
    };
    const onOut = (chunk) => {
      out += chunk;
      if (out.includes('ZERO VIAL disponible')) { cleanup(); resolve(); }
    };
    const onErr = (chunk) => { err += chunk; };
    const onExit = (code) => {
      cleanup();
      reject(new Error('El servidor terminó con código ' + code + '.\n' + err));
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.once('exit', onExit);
  });
}

test('server.js sirve los assets del parche y vercel.json los despliega', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  await waitForServer(child);
  const base = 'http://127.0.0.1:' + port;

  const assets = [
    { path: '/', type: 'text/html' },
    { path: '/landing-city-v1.png', type: 'image/png' },
    { path: '/landing-city-v1.webp', type: 'image/webp' },
    { path: '/manifest.webmanifest', type: 'application/manifest+json' },
    { path: '/fusion/fusion.css', type: 'text/css' },
    { path: '/fusion/polish.css', type: 'text/css' },
    { path: '/fusion/fusion.js', type: 'text/javascript' },
    { path: '/fusion/tolls-data.js', type: 'text/javascript' },
  ];

  for (const asset of assets) {
    const res = await fetch(base + asset.path);
    assert.equal(res.status, 200, asset.path + ' debe responder 200 (recibido ' + res.status + ')');
    assert.match(res.headers.get('content-type') || '', new RegExp(asset.type.replace('+', '\\+')), asset.path + ' debe tener Content-Type ' + asset.type);
    assert.ok((await res.arrayBuffer()).byteLength > 0, asset.path + ' no debe estar vacío');
  }

  const sw = await fetch(base + '/service-worker.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.match(sw.headers.get('cache-control') || '', /no-cache/);

  const fusionAsset = await fetch(base + '/fusion/fusion.css');
  assert.match(fusionAsset.headers.get('cache-control') || '', /immutable/);
  const landing = await fetch(base + '/landing-city-v1.webp');
  assert.match(landing.headers.get('cache-control') || '', /max-age=604800/);

  const home = await fetch(base + '/');
  assert.equal(home.headers.get('strict-transport-security'), 'max-age=15552000');
  assert.match(home.headers.get('content-security-policy-report-only') || '', /default-src 'self'/);
  assert.match(home.headers.get('content-security-policy-report-only') || '', /object-src 'none'/);
  assert.equal(home.headers.get('x-permitted-cross-domain-policies'), 'none');

  const html = await home.text();
  const cdnTags = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https:\/\/(?:unpkg\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)[^"]+)"[^>]*>/g)];
  assert.ok(cdnTags.length >= 9, 'index.html debe conservar los CDN versionados');
  for (const match of cdnTags) {
    assert.match(match[0], /integrity="sha384-[A-Za-z0-9+/=]+"/, match[1] + ' debe llevar SRI');
    assert.match(match[0], /crossorigin="anonymous"/, match[1] + ' debe ser CORS para validar SRI');
  }

  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const builds = new Set((vercel.builds || []).map((b) => b.src));
  for (const src of ['manifest.webmanifest', 'service-worker.js', 'fusion/*', '*.png', '*.webp']) {
    assert.ok(builds.has(src), 'vercel.json debe incluir el build ' + src);
  }

  const globalHeaders = (vercel.headers || []).find((h) => h.source === '/(.*)');
  assert.ok(globalHeaders, 'vercel.json debe tener cabeceras globales para Vercel');
  const headerMap = Object.fromEntries(globalHeaders.headers.map((h) => [h.key, h.value]));
  assert.equal(headerMap['X-Content-Type-Options'], 'nosniff');
  assert.equal(headerMap['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headerMap['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(headerMap['X-Permitted-Cross-Domain-Policies'], 'none');
  assert.equal(headerMap['Strict-Transport-Security'], 'max-age=15552000');
  assert.match(headerMap['Content-Security-Policy-Report-Only'] || '', /default-src 'self'/);
  assert.match(headerMap['Content-Security-Policy-Report-Only'] || '', /object-src 'none'/);
  assert.match(headerMap['Permissions-Policy'] || '', /geolocation=\(self\)/);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.orientation, 'any', 'la PWA no debe quedar bloqueada en vertical');

  // Todo lo que el service worker precarga debe existir también en el servidor.
  const swSource = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
  const shellBlock = swSource.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellBlock, 'service-worker.js debe declarar SHELL');
  const shellUrls = [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(shellUrls.length >= 14, 'el app shell debe incluir los assets principales');
  for (const shellPath of shellUrls) {
    const res = await fetch(base + shellPath);
    assert.equal(res.status, 200, 'El app shell ' + shellPath + ' debe responder 200');
    assert.ok((await res.arrayBuffer()).byteLength > 0, 'El app shell ' + shellPath + ' no debe estar vacío');
  }
});
