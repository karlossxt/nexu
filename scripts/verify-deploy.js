#!/usr/bin/env node
'use strict';
/**
 * Verifica un despliegue en producción (solo lectura + peticiones de prueba inofensivas).
 *
 * Uso:
 *   node scripts/verify-deploy.js https://www.zero-vial.com.mx
 *   node scripts/verify-deploy.js https://www.zero-vial.com.mx --private-rss "https://rss.app/feeds/XXXX.xml"
 *
 * Código de salida 1 si hay algún FAIL.  Requiere Node >= 18.
 */
const base = (process.argv[2] || '').replace(/\/+$/, '');
const privIdx = process.argv.indexOf('--private-rss');
const privateRss = privIdx > -1 ? process.argv[privIdx + 1] : '';
if (!/^https?:\/\//.test(base)) { console.error('Uso: node scripts/verify-deploy.js https://tu-dominio [--private-rss URL]'); process.exit(2); }

const results = [];
const log = (level, name, detail = '') => { results.push(level); console.log(`${{ PASS: '✅', FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ' }[level]} ${name}${detail ? ' — ' + detail : ''}`); };

async function get(path, opts = {}) {
  try {
    const res = await fetch(base + path, { redirect: 'follow', signal: AbortSignal.timeout(15000), ...opts });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, type: res.headers.get('content-type') || '' };
  } catch (e) { return { status: 0, headers: new Headers(), text: '', type: '', error: e.message }; }
}
function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

(async () => {
  console.log(`\nVerificando ${base}\n`);

  // 1. Archivos internos que NO deben ser públicos
  console.log('— Archivos internos —');
  const sensitive = ['/server.js', '/worker/index.js', '/worker/red-vial.js', '/worker/casetas.js', '/supabase/', '/.env', '/.env.example',
    '/render.yaml', '/vercel.json', '/package.json', '/.git/config', '/.git/HEAD', '/scripts/verify-deploy.js', '/api/feed.js', '/api/geocode.js'];
  for (const p of sensitive) {
    const r = await get(p);
    if (r.status === 0) { log('WARN', p, 'sin respuesta: ' + r.error); continue; }
    const looksHtml = /text\/html/.test(r.type) && /<html|<!doctype/i.test(r.text.slice(0, 400));
    if (r.status === 200 && looksHtml && /Index of|Directory listing|<title>Listing/i.test(r.text.slice(0, 600))) { log('FAIL', p, 'listado de directorio público'); continue; }
    if (r.status === 200 && !looksHtml) log('FAIL', p, `se sirve públicamente (${r.type || 'sin tipo'}, ${r.text.length} bytes)`);
    else if (r.status === 200 && looksHtml) log('PASS', p, 'devuelve la página principal (fallback SPA), no el archivo');
    else log('PASS', p, `HTTP ${r.status}`);
  }

  // 2. Páginas y recursos públicos
  console.log('\n— Recursos públicos —');
  for (const [p, type] of [['/', 'text/html'], ['/privacidad.html', 'text/html'], ['/terminos.html', 'text/html'], ['/acerca.html', 'text/html'], ['/ayuda.html', 'text/html'], ['/logo-mark.webp', 'image/webp']]) {
    const r = await get(p);
    if (r.status === 200 && r.type.includes(type)) log('PASS', p);
    else log(p === '/logo-mark.webp' ? 'FAIL' : 'WARN', p, `HTTP ${r.status} ${r.type}${p === '/logo-mark.webp' ? ' (¿subiste logo-mark.webp a la raíz?)' : ''}`);
  }
  const cas = await get('/casetas-data.js');
  log(cas.status === 200 ? 'PASS' : 'WARN', '/casetas-data.js', cas.status === 200 ? '' : `HTTP ${cas.status}: index.html lo carga; confirma que existe`);

  // 3. /api/config
  console.log('\n— /api/config —');
  const cfgRes = await get('/api/config');
  if (cfgRes.status !== 200) log('FAIL', '/api/config', `HTTP ${cfgRes.status}`);
  else {
    let cfg = null; try { cfg = JSON.parse(cfgRes.text); } catch { /* */ }
    if (!cfg) log('FAIL', '/api/config', 'no es JSON');
    else {
      const key = cfg.supabase && cfg.supabase.anonKey;
      if (!key) log('WARN', 'anonKey', 'vacía: el mapa no podrá leer alertas');
      else {
        const payload = decodeJwt(key);
        if (payload && payload.role === 'service_role') log('FAIL', 'anonKey', '¡ES LA SERVICE ROLE KEY! Rótala de inmediato: da acceso total a tu base de datos');
        else if (payload && payload.role === 'anon') log('PASS', 'anonKey', 'rol anon (pública por diseño; protégela con RLS)');
        else log('INFO', 'anonKey', payload ? `rol "${payload.role}"` : 'formato no JWT (llave nueva sb_publishable_…)');
        if (/^sb_secret_/.test(key)) log('FAIL', 'anonKey', 'es una llave SECRETA de Supabase expuesta al navegador');
      }
      const rss = JSON.stringify(cfg.rss || []);
      if (privateRss && rss.includes(privateRss)) log('FAIL', 'rss', 'el feed privado se está enviando al navegador (usa EXPOSE_RSS_PRI vacío)');
      else if (/rss\.app\/feeds\//i.test(rss)) log('WARN', 'rss', 'hay un feed de rss.app visible en /api/config; confirma que no sea privado');
      else log('PASS', 'rss', 'sin feeds privados expuestos');
    }
  }

  // 4. Proxy /api/groq
  console.log('\n— /api/groq (proxy) —');
  const body = JSON.stringify({ model: 'openai/gpt-oss-20b', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'ping' }], max_tokens: 1 });
  const noTok = await get('/api/groq', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (noTok.status === 403 || noTok.status === 401) log('PASS', 'POST sin token', `rechazado (HTTP ${noTok.status})`);
  else if (noTok.status === 200) log('FAIL', 'POST sin token', 'EL PROXY ESTÁ ABIERTO: cualquiera puede gastar tu cuota de Groq. Configura APP_TOKEN');
  else if (noTok.status === 500) log('WARN', 'POST sin token', 'HTTP 500: ' + noTok.text.slice(0, 90) + ' (¿APP_TOKEN o GROQ_API_KEY sin configurar?)');
  else if (noTok.status === 404 || noTok.status === 405) log('INFO', 'POST sin token', `HTTP ${noTok.status}: /api/groq no está en este despliegue`);
  else log('WARN', 'POST sin token', `HTTP ${noTok.status}`);
  const models = await get('/api/groq?action=models');
  if (models.status === 200) log('FAIL', 'GET ?action=models sin token', 'responde sin autenticación');
  else log('PASS', 'GET ?action=models sin token', `HTTP ${models.status}`);

  // 5. Rate limit (45 intentos con token incorrecto)
  const codes = [];
  for (let i = 0; i < 45; i++) { const r = await get('/api/groq', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-token': 'incorrecto-' + i }, body }); codes.push(r.status); if (r.status === 404 || r.status === 405) break; }
  if (codes.includes(429)) log('PASS', 'rate limit', `activo (primer 429 en el intento ${codes.indexOf(429) + 1})`);
  else if (codes.every(c => c === 404 || c === 405)) log('INFO', 'rate limit', 'endpoint ausente');
  else log('WARN', 'rate limit', 'sin 429 tras 45 intentos. En serverless (Vercel) el contador en memoria no se comparte entre instancias: considera un límite en el borde o en Upstash/Redis');

  // 6. Cabeceras
  console.log('\n— Cabeceras de seguridad (/) —');
  const home = await get('/');
  const h = n => home.headers.get(n);
  log(h('x-content-type-options') === 'nosniff' ? 'PASS' : 'WARN', 'X-Content-Type-Options', h('x-content-type-options') || 'ausente');
  log(h('referrer-policy') ? 'PASS' : 'WARN', 'Referrer-Policy', h('referrer-policy') || 'ausente');
  log(h('strict-transport-security') ? 'PASS' : 'WARN', 'Strict-Transport-Security', h('strict-transport-security') || 'ausente (actívalo en Vercel/Render o el CDN)');
  log(h('content-security-policy') ? 'PASS' : 'INFO', 'Content-Security-Policy', h('content-security-policy') ? 'presente' : 'ausente (requiere ajustar scripts inline antes de activarla)');
  if (h('x-powered-by')) log('WARN', 'X-Powered-By', h('x-powered-by') + ' (revela la tecnología)');

  const fails = results.filter(r => r === 'FAIL').length, warns = results.filter(r => r === 'WARN').length;
  console.log(`\nResumen: ${results.filter(r => r === 'PASS').length} OK · ${warns} advertencias · ${fails} FALLAS`);
  process.exit(fails ? 1 : 0);
})();
