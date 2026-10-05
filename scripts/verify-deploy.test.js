'use strict';
// Pruebas de scripts/verify-deploy.js. A diferencia de los otros scripts, este
// no se importa: su trabajo es auditar un despliegue real. Así que aquí se levanta
// un servidor HTTP de mentira en localhost, se ejecuta el script como proceso hijo
// contra él y se comprueba cómo clasifica cada respuesta. Lo que se prueba es
// exactamente el código que correría contra producción: la distinción entre
// "expuesto" y "responde 404", y el hecho de que una service_role en /api/config
// salga como FAIL y no como un simple aviso.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'verify-deploy.js');
const REPO = path.join(__dirname, '..');

const HTML = { type: 'text/html; charset=utf-8', body: '<!doctype html><html><head><title>Zero Vial</title></head><body>ok</body></html>' };
const NOT_FOUND = { status: 404 };

// --- servidor de mentira -----------------------------------------------------
// routes acepta "GET /x", "POST /x", "ANY /x" o "*". El valor es un descriptor
// o una función (req, res, state) para lo que necesite contador.
function boot(routes) {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    // De más específico a menos: método+ruta+query, método+ruta, ANY+ruta, ruta.
    const r = routes[`${req.method} ${p}${url.search}`] ?? routes[`${req.method} ${p}`]
      ?? routes[`ANY ${p}`] ?? routes[p] ?? routes['*'] ?? NOT_FOUND;
    if (typeof r === 'function') return r(req, res, state);
    res.writeHead(r.status || 200, { 'content-type': r.type || 'text/plain', ...(r.headers || {}) });
    res.end(r.body || '');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: REPO });
    let out = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', c => out += c);
    child.stderr.setEncoding('utf8'); child.stderr.on('data', c => out += c);
    child.on('close', code => resolve({ code, out }));
  });
}

// Levanta el servidor, corre el script y lo apaga pase lo que pase.
async function verify(routes, extraArgs = []) {
  const { server, base } = await boot(routes);
  try { return await run([base, ...extraArgs]); }
  finally { server.close(); }
}

// Busca la LÍNEA DE RESULTADO que menciona name, no el encabezado de sección
// ("— /api/config —"), que también contiene ese texto.
const line = (out, name) => out.split('\n').find(l => !l.startsWith('—') && l.includes(name)) || '(no salió la línea)';
const failed = (out, name) => line(out, name).startsWith('❌');
const passed = (out, name) => line(out, name).startsWith('✅');
const warned = (out, name) => line(out, name).startsWith('⚠');
const totalFails = (out) => Number((out.match(/Resumen:.*?(\d+) FALLAS/) || [])[1]);

// --- escenarios compartidos ---------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const anonKey = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon' })}.${'S'.repeat(43)}`;
const serviceKey = `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}.${'S'.repeat(43)}`;

// Un despliegue bien: nada interno público, recursos ahí, proxy cerrado.
const SECURE = {
  '/': { ...HTML, headers: { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'strict-transport-security': 'max-age=63072000', 'content-security-policy': "default-src 'self'" } },
  '/privacidad.html': HTML, '/terminos.html': HTML, '/acerca.html': HTML, '/ayuda.html': HTML,
  '/logo-mark.webp': { type: 'image/webp', body: 'RIFF____WEBP' },
  '/casetas-data.js': { type: 'text/javascript', body: 'window.CASETAS=[]' },
  '/api/config': { type: 'application/json', body: JSON.stringify({ rss: ['', 'https://news.google.com/rss?x=1'], supabase: { anonKey } }) },
  'POST /api/groq': (req, res, st) => {
    st.hits++;
    // Sin token debe rechazar; con token incorrecto, tarde o temprano el límite.
    const tok = req.headers['x-app-token'];
    res.writeHead(!tok ? 403 : st.hits > 3 ? 429 : 403, { 'content-type': 'application/json' });
    res.end('{}');
  },
  'GET /api/groq': NOT_FOUND,
  'GET /api/groq?action=models': NOT_FOUND,
};

test('un despliegue sano termina con código 0 y cero FALLAS', async () => {
  const { code, out } = await verify(SECURE);
  assert.equal(totalFails(out), 0, 'no debería haber FALLAS:\n' + out);
  assert.equal(code, 0, 'el código de salida propaga el fallo:\n' + out);
  assert.ok(passed(out, '/logo-mark.webp'), 'el logo se sirve como image/webp');
  assert.ok(passed(out, 'X-Content-Type-Options'), 'nosniff presente');
  assert.ok(passed(out, 'rss'), 'sin feeds privados: ' + line(out, 'rss'));
  assert.ok(passed(out, 'rate limit'), 'el 429 llegó: ' + line(out, 'rate limit'));
  assert.ok(passed(out, 'GET ?action=models'), 'models exige token');
});

test('sin URL no se ejecuta: código 2 y el modo de uso', async () => {
  const { code, out } = await run([]);
  assert.equal(code, 2);
  assert.match(out, /Uso: node scripts\/verify-deploy\.js/);
});

test('un archivo interno servido en crudo es FAIL y el script sale con 1', async () => {
  const { code, out } = await verify({ ...SECURE, '/.env': { type: 'text/plain', body: 'SUPABASE_KEY=abc' } });
  assert.ok(failed(out, '/.env'), 'el .env público es un FAIL: ' + line(out, '/.env'));
  assert.match(line(out, '/.env'), /se sirve públicamente/, 'dice por qué, no solo que falla');
  assert.equal(code, 1, 'el código de salida es 1 si hay FAIL');
  assert.ok(totalFails(out) >= 1);
});

test('un listado de directorio se distingue de un archivo servido', async () => {
  const { out } = await verify({ ...SECURE, '/supabase/': { type: 'text/html; charset=utf-8', body: '<html><body><title>Index of /supabase</title>schema.sql</body></html>' } });
  assert.ok(failed(out, '/supabase/'), 'es FAIL');
  assert.match(line(out, '/supabase/'), /listado de directorio público/);
});

test('un fallback a la página principal NO cuenta como archivo expuesto', async () => {
  // Es lo que hace Vercel/Render con rutas desconocidas: devuelve index.html con
  // 200. Marcarlo como FAIL sería un falso positivo que haría ignorar el script.
  const { out } = await verify({ ...SECURE, '/render.yaml': HTML });
  assert.ok(passed(out, '/render.yaml'), 'debe pasar: ' + line(out, '/render.yaml'));
  assert.match(line(out, '/render.yaml'), /fallback SPA/);
});

test('sin logo-mark.webp es FAIL, no solo un aviso', async () => {
  // A diferencia del resto de recursos, aquí no hay duda: index.html lo carga y
  // sin él el sitio sale sin logo.
  const { code, out } = await verify({ ...SECURE, '/logo-mark.webp': NOT_FOUND });
  assert.ok(failed(out, '/logo-mark.webp'), line(out, '/logo-mark.webp'));
  assert.match(line(out, '/logo-mark.webp'), /subiste logo-mark\.webp a la raíz/);
  assert.equal(code, 1);
});

test('una service_role en /api/config es FAIL y lo dice sin rodeos', async () => {
  const { code, out } = await verify({ ...SECURE, '/api/config': { type: 'application/json', body: JSON.stringify({ rss: ['', ''], supabase: { anonKey: serviceKey } }) } });
  assert.ok(failed(out, 'anonKey'), line(out, 'anonKey'));
  assert.match(line(out, 'anonKey'), /SERVICE ROLE KEY/);
  assert.match(line(out, 'anonKey'), /Rótala de inmediato/);
  assert.equal(code, 1);
});

test('una llave sb_secret_ se detecta aunque no sea un JWT', async () => {
  const { out } = await verify({ ...SECURE, '/api/config': { type: 'application/json', body: JSON.stringify({ rss: ['', ''], supabase: { anonKey: 'sb_secret_abcdefghijklmnop1234' } }) } });
  assert.ok(failed(out, 'anonKey'), line(out, 'anonKey'));
  assert.match(line(out, 'anonKey'), /SECRETA de Supabase/);
});

test('una anonKey vacía es aviso, no FAIL', async () => {
  const { out } = await verify({ ...SECURE, '/api/config': { type: 'application/json', body: JSON.stringify({ rss: ['', ''], supabase: {} }) } });
  assert.ok(warned(out, 'anonKey'), 'sin llave el mapa no lee alertas pero nada se rompió: ' + line(out, 'anonKey'));
});

test('/api/config que no es JSON es FAIL', async () => {
  const { out } = await verify({ ...SECURE, '/api/config': { type: 'application/json', body: '<!doctype html><title>404</title>' } });
  assert.ok(failed(out, '/api/config'), line(out, '/api/config'));
  assert.match(line(out, '/api/config'), /no es JSON/);
});

test('el feed privado declarado sale como FAIL solo si coincide', async () => {
  const feed = 'https://rss.app/feeds/_xcLux4OS9bFKsrNa.xml';
  const cfg = { type: 'application/json', body: JSON.stringify({ rss: [feed, ''], supabase: { anonKey } }) };

  const expuesto = await verify({ ...SECURE, '/api/config': cfg }, ['--private-rss', feed]);
  assert.ok(failed(expuesto.out, 'rss'), 'coincide con el feed declarado: ' + line(expuesto.out, 'rss'));
  assert.match(line(expuesto.out, 'rss'), /EXPOSE_RSS_PRI/);

  // Sin --private-rss el mismo feed es solo un aviso: no se puede saber si es privado.
  const sinDeclarar = await verify({ ...SECURE, '/api/config': cfg });
  assert.ok(warned(sinDeclarar.out, 'rss'), 'sin el argumento no se puede acusar: ' + line(sinDeclarar.out, 'rss'));
  assert.match(line(sinDeclarar.out, 'rss'), /confirma que no sea privado/);
});

test('un feed de rss.app visible sin --private-rss es aviso, no FAIL', async () => {
  const cfg = { type: 'application/json', body: JSON.stringify({ rss: ['https://rss.app/feeds/_otroFeedId.xml', ''], supabase: { anonKey } }) };
  const { out } = await verify({ ...SECURE, '/api/config': cfg });
  assert.ok(warned(out, 'rss'), line(out, 'rss'));
});

test('un proxy de Groq abierto es FAIL y lo nombra', async () => {
  const { code, out } = await verify({ ...SECURE, 'POST /api/groq': { status: 200, type: 'application/json', body: '{"ok":1}' } });
  assert.ok(failed(out, 'POST sin token'), line(out, 'POST sin token'));
  assert.match(line(out, 'POST sin token'), /PROXY ESTÁ ABIERTO/);
  assert.equal(code, 1);
});

test('un /api/groq con 500 es aviso, no FAIL', async () => {
  // 500 significa que falta APP_TOKEN o GROQ_API_KEY: es un despliegue mal
  // configurado, no un proxy abierto a Internet.
  const { code, out } = await verify({ ...SECURE, 'POST /api/groq': { status: 500, type: 'text/plain', body: 'error' } });
  assert.ok(warned(out, 'POST sin token'), line(out, 'POST sin token'));
  assert.equal(code, 0, 'un 500 no debe romper el código de salida');
});

test('?action=models respondiendo sin token es FAIL', async () => {
  const { out } = await verify({ ...SECURE, 'GET /api/groq?action=models': { status: 200, type: 'application/json', body: '{"data":[]}' } });
  assert.ok(failed(out, 'GET ?action=models'), line(out, 'GET ?action=models'));
  assert.match(line(out, 'GET ?action=models'), /sin autenticación/);
});

test('sin 429 tras muchos intentos el rate limit es aviso, no FAIL', async () => {
  // En serverless el contador vive en memoria y no se comparte entre instancias,
  // así que la ausencia de 429 no demuestra que el límite no exista.
  const { code, out } = await verify({ ...SECURE, 'POST /api/groq': { status: 403, type: 'application/json', body: '{}' } });
  assert.ok(warned(out, 'rate limit'), line(out, 'rate limit'));
  assert.match(line(out, 'rate limit'), /Upstash|Redis/);
  assert.equal(code, 0);
});

test('un 404 en /api/groq se informa como endpoint ausente, no como fallo', async () => {
  // Es el caso de un despliegue estático (sin el serverless): no es un error que
  // el proxy falte, solo que no está ahí.
  const { code, out } = await verify({ ...SECURE, 'POST /api/groq': NOT_FOUND, 'GET /api/groq?action=models': NOT_FOUND });
  assert.ok(warned(out, 'POST sin token') || out.includes('/api/groq no está'), line(out, 'POST sin token'));
  assert.match(out, /\/api\/groq no está en este despliegue/, 'lo dice como información: ' + line(out, 'POST sin token'));
  assert.ok(out.includes('endpoint ausente'), 'y el rate limit también: ausente');
  assert.equal(totalFails(out), 0);
  assert.equal(code, 0);
});

test('una cabecera de seguridad ausente sale como aviso y se nombra', async () => {
  const { code, out } = await verify({ ...SECURE, '/': { ...HTML } });  // sin cabeceras
  assert.ok(warned(out, 'X-Content-Type-Options'), 'sin nosniff es aviso');
  assert.ok(warned(out, 'Strict-Transport-Security'), 'sin HSTS es aviso');
  assert.match(line(out, 'Strict-Transport-Security'), /ausente/);
  assert.equal(code, 0, 'cabeceras ausentes no bloquean el código de salida');
});

test('X-Powered-By delata la tecnología y se reporta', async () => {
  const { out } = await verify({ ...SECURE, '/': { ...HTML, headers: { 'x-powered-by': 'Express' } } });
  assert.ok(warned(out, 'X-Powered-By'), line(out, 'X-Powered-By'));
  assert.match(line(out, 'X-Powered-By'), /revela la tecnología/);
});

test('un host que no responde avisa en vez de fallar en cascada', async () => {
  // Puerto cerrado: cada petición da status 0. Los archivos internos deben salir
  // WARN "sin respuesta", no FAIL, o un deploy caído parecería una fuga de
  // secretos y nadie leería los avisos que sí importan.
  const { out } = await run(['http://127.0.0.1:1']);
  assert.ok(warned(out, '/server.js'), 'un host caído no es una fuga: ' + line(out, '/server.js'));
  assert.match(line(out, '/server.js'), /sin respuesta/);
  assert.match(line(out, '/.env'), /sin respuesta/);
  assert.ok(out.includes('26 advertencias'), 'todo se reporta como advertencia: ' + (out.match(/Resumen:.*/) || [])[0]);
});
