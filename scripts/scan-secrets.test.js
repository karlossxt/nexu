'use strict';
// Pruebas de scripts/scan-secrets.js. Aquí lo que importa no es que "encuentre
// algo", sino dos cosas opuestas: que NO deje pasar un secreto real (falsos
// negativos) y que NO grite frente a un placeholder o una llave pública (ruido).
// La primera vez que se ejecutó, la regla rss_app llevaba `[A-Za-z0-9]{8,}`
// justo donde los ids reales de RSS.app empiezan por `_`, así que no disparaba
// nunca y el feed seguía pasando desapercibido: ese caso está fijado abajo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const scanner = require('./scan-secrets');
const { scanLine, mask, decodeJwt, isBinary, bySeverity, findings, reset, RULES } = scanner;

// Cada prueba arranca sin hallazgos: el mapa es estado a nivel de módulo.
function scan(...lines) { reset(); lines.forEach((l, i) => scanLine(l, `f${i}:1`)); return [...findings.values()]; }
const ids = (list) => list.map(f => f.id);
const byId = (list, id) => list.find(f => f.id === id);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function jwt(payload) {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${'S'.repeat(43)}`;
}

test('mask nunca devuelve el secreto completo', () => {
  assert.equal(mask('corto'), '***', 'un valor de 5 caracteres no revela nada');
  assert.equal(mask('1234567890'), '***');
  const m = mask('gsk_abcdefghijklmnopqrstuvwxyz');
  assert.ok(m.startsWith('gsk_ab'), 'solo deja ver un prefijo: ' + m);
  assert.ok(!m.includes('uvwxyz'), 'la cola no aparece: ' + m);
  assert.ok(m.includes('30 car.'), 'informa de la longitud real: ' + m);
});

test('un feed de RSS.app se detecta aunque el id empiece por guion bajo', () => {
  // Este es el falso negativo que se corrigió: los ids reales son /_xxxxxxxx.xml.
  const list = scan('RSS_PRI=https://rss.app/feeds/_xcLux4OS9bFKsrNa.xml');
  assert.deepEqual(ids(list), ['rss_app']);
  assert.ok(byId(list, 'rss_app').masked.includes('31 car.'), 'mide la URL completa');
});
test('un feed de RSS.app se detecta con guiones en el id', () => {
  const list = scan("url: 'https://rss.app/feeds/feed-abc123XYZdef.xml'");
  assert.ok(ids(list).includes('rss_app'), 'los guiones no pueden volver ciego a la regla');
});
test('un placeholder de RSS.app no se reporta', () => {
  assert.deepEqual(scan('RSS_PRI=https://rss.app/feeds/TU_FEED_AQUI'), []);
  assert.deepEqual(scan('<!-- https://rss.app/feeds/cambia-esto -->'), []);
});

test('las llaves con prefijo conocido se detectan', () => {
  const list = scan(
    'GROQ=gsk_a1b2c3d4e5f6g7h8i9j0k1',
    'GMAPS=AIzaSyD-1234567890abcdefghijklmnopqrstu',
    'SUPA=sb_secret_abcdefghijklmnop1234'
  );
  assert.deepEqual(ids(list).sort(), ['google', 'groq', 'sb_secret']);
  assert.ok(list.every(f => f.sev === 'CRIT'), 'las tres son críticas');
});
test('una llave secreta de Supabase nunca es una publishable', () => {
  // sb_publishable_ está pensada para el navegador: marcarla sería ruido.
  const list = scan("const KEY = 'sb_publishable_iJtw2kIhrCr1dSkKL8Mg3w_IWtbdIep';");
  assert.deepEqual(ids(list), [], 'la anon key no es un secreto: ' + JSON.stringify(list));
});
test('las llaves privadas se detectan', () => {
  // Tres cabeceras distintas = tres valores distintos, así que son tres
  // hallazgos y no uno: cada una tiene su propio material que hay que rotar.
  const list = scan('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----');
  assert.deepEqual(ids(list), ['privkey', 'privkey', 'privkey']);
  assert.ok(list.every(f => f.sev === 'CRIT'), 'una llave privada es lo más grave posible');
  assert.ok(list.every(f => f.masked.startsWith('-----B')), 'solo el inicio de la cabecera: ' + list[0].masked);
  assert.ok(list.every(f => f.masked.length < 20), 'el valor sale truncado: ' + list[0].masked);
});
test('una llave privada nunca arrastra el material que la sigue', () => {
  // El cuerpo del PEM son líneas base64 larguísimas. La regla solo captura la
  // cabecera, así que el escaneo de las líneas siguientes no añade otro hallazgo.
  const list = scan(
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7nurt',
    '-----END PRIVATE KEY-----'
  );
  assert.deepEqual(ids(list), ['privkey'], 'una sola coincidencia: ' + JSON.stringify(list.map(f => f.masked)));
  assert.ok(list[0].count === 1, 'solo cuenta la cabecera de apertura');
});

test('una regla CRIT ignora lo obviamente falso pero no un 1234567890 real', () => {
  // PLACEHOLDER (WARN) sí descarta 1234567890; PLACEHOLDER_STRICT (CRIT) no, porque
  // un secreto real puede contener esa secuencia.
  assert.deepEqual(scan('K=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx'), [], 'x repetido es filler');
  assert.deepEqual(scan('K=gsk_TU_LLAVE_AQUI_1234567890'), [], 'texto de ejemplo');
  assert.deepEqual(scan('K=your-api-key-here-123456789'), [], 'prefijo your_');
  const real = scan('K=gsk_1234567890abcdefghij');
  assert.deepEqual(ids(real), ['groq'], 'diez dígitos no justifican descartar una llave real');
});

test('una asignación de secreto se detecta y un placeholder no', () => {
  assert.ok(ids(scan('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9abcdefghij')).includes('assign'));
  assert.ok(ids(scan('const APP_TOKEN = "aG9sYXFxdWl0cmF0aW9uMTIzNDU2')).includes('assign'));
  assert.deepEqual(scan('API_KEY=changeme'), [], 'changeme');
  assert.deepEqual(scan('API_KEY=xxxxxxxxxxxxxxxxxxxx'), [], 'x repetido');
  assert.deepEqual(scan('API_KEY=<pon-aqui-la-llave>'), [], 'marcadores de ángulo');
  assert.deepEqual(scan('API_KEY=process.env.SOMETHING'), [], 'una referencia a env no es un valor');
});

test('una llave en parámetro de URL se detecta', () => {
  const list = scan("tiles: 'https://a.basemaps.cartocdn.com/voyager/1/2/3.png?key=cb1_31ABCDEFGHIJKLMNOP'");
  assert.ok(ids(list).includes('urlkey'), 'un key= de 20+ caracteres es una credencial');
  assert.deepEqual(scan('a.html?key=corto'), [], 'demasiado corto para ser una llave');
});

test('un JWT con rol service_role es CRIT y uno con rol anon es INFO', () => {
  const crit = scan(`SUPABASE_ANON_KEY=${jwt({ role: 'service_role' })}`);
  const f = byId(crit, 'jwt_service_role');
  assert.ok(f, 'el rol service_role se nombra aparte: ' + JSON.stringify(crit));
  assert.equal(f.sev, 'CRIT', 'da acceso total a la base');

  const info = scan(`KEY=${jwt({ role: 'anon' })}`);
  assert.equal(byId(info, 'jwt_anon').sev, 'INFO', 'anon es público por diseño');

  const warn = scan(`KEY=${jwt({ role: 'authenticated' })}`);
  assert.equal(byId(warn, 'jwt_other').sev, 'WARN', 'cualquier otro rol se reporta pero no se dramatiza');
});

test('el mismo secreto en varios sitios es un hallazgo con todas sus ubicaciones', () => {
  reset();
  scanLine('KEY=gsk_a1b2c3d4e5f6g7h8i9j0k1', 'index.html:10');
  scanLine('otra vez gsk_a1b2c3d4e5f6g7h8i9j0k1', 'worker/index.js:20');
  const list = [...findings.values()];
  assert.equal(list.length, 1, 'se agrupa por id|valor, no por línea');
  assert.equal(byId(list, 'groq').count, 2, 'pero cuenta las apariciones');
  assert.deepEqual(byId(list, 'groq').where, ['index.html:10', 'worker/index.js:20']);
});
test('un hallazgo recuerda como máximo cuatro ubicaciones', () => {
  reset();
  for (let i = 0; i < 9; i++) scanLine('KEY=gsk_a1b2c3d4e5f6g7h8i9j0k1', `f${i}.js:${i}`);
  const f = [...findings.values()][0];
  assert.equal(f.count, 9, 'se sigue contando todo');
  assert.equal(f.where.length, 4, 'pero la salida se mantiene legible');
});

test('los CRIT se listan antes que los WARN y los INFO', () => {
  reset();
  scanLine(`KEY=${jwt({ role: 'anon' })}`, 'a:1');                       // INFO
  scanLine('FEED=https://rss.app/feeds/_xcLux4OS9bFKsrNa.xml', 'b:1');  // WARN
  scanLine('GROQ=gsk_a1b2c3d4e5f6g7h8i9j0k1', 'c:1');                    // CRIT
  assert.deepEqual(bySeverity(findings.values()).map(f => f.sev), ['CRIT', 'WARN', 'INFO']);
  // El orden no depende del orden en que se encontraron ni de que ya vinieran
  // ordenados, y no muta la entrada.
  const input = [...findings.values()];
  const copy = [...input];
  bySeverity(input);
  assert.deepEqual(input, copy, 'bySeverity no reordena el mapa original');
});

test('decodeJwt no revienta con basura y devuelve el payload real', () => {
  assert.equal(decodeJwt('no-es-un-jwt'), null);
  assert.equal(decodeJwt('a.b.c'), null);
  assert.deepEqual(decodeJwt(jwt({ role: 'service_role' })), { role: 'service_role' });
});

test('isBinary detecta un byte nulo y no confunde texto UTF-8', () => {
  assert.equal(isBinary(Buffer.from('hola\0que tal')), true);
  assert.equal(isBinary(Buffer.from('logo con acentos: ícono, ñandú')), false, 'los acentos no son binarios');
  assert.equal(isBinary(Buffer.from('')), false);
});

test('ninguna regla acepta un id duplicado', () => {
  const seen = new Set();
  for (const r of RULES) {
    assert.ok(!seen.has(r.id), 'id repetido en RULES: ' + r.id);
    seen.add(r.id);
    assert.ok(['CRIT', 'WARN', 'INFO'].includes(r.sev), 'sev inválida en ' + r.id);
    assert.ok(r.re.global, r.id + ' necesita /g para recorrer toda la línea');
    assert.ok(typeof r.note === 'string' && r.note.length, r.id + ' sin nota legible');
  }
});
