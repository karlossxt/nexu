#!/usr/bin/env node
'use strict';
/**
 * Escanea archivos versionados y TODO el historial de git en busca de llaves y secretos.
 * Nunca imprime un secreto completo (solo un prefijo enmascarado).
 *
 * Uso (desde la raíz del repo):
 *   node scripts/scan-secrets.js              # archivos versionados + historial
 *   node scripts/scan-secrets.js --no-history # solo archivos actuales
 *
 * Código de salida 1 si hay hallazgos CRÍTICOS. Requiere git y Node >= 18.
 * Complemento recomendado: gitleaks (https://github.com/gitleaks/gitleaks) o trufflehog.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const noHistory = process.argv.includes('--no-history');
const sh = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// Para reglas WEAK (asignaciones genéricas): se descartan valores que parecen de ejemplo.
const PLACEHOLDER = /(tu[_-]|your|xxx|changeme|cambia|reemplaza|pon[_-]|aqui|aquí|example|ejemplo|placeholder|<[^>]+>|\.\.\.|\*{3}|dummy|fake|test[_-]?key|1234567890|process\.env|env\.)/i;
// Para reglas CRIT con prefijo propio (gsk_, AIza…): solo se omite lo OBVIAMENTE falso. Un secreto real puede contener "1234567890".
const PLACEHOLDER_STRICT = /(x{6,}|your[_-]|tu[_-]|\.\.\.|\*{3}|<[^>]+>)/i;

// Cada regla: tipo, gravedad, regex (con grupo 1 = secreto si aplica)
const RULES = [
  { id: 'groq',      sev: 'CRIT', re: /\b(gsk_[A-Za-z0-9]{20,})\b/g,               note: 'Llave de Groq' },
  { id: 'google',    sev: 'CRIT', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g,               note: 'Llave de Google (Maps/Gemini)' },
  { id: 'sb_secret', sev: 'CRIT', re: /\b(sb_secret_[A-Za-z0-9_-]{16,})\b/g,        note: 'Llave secreta de Supabase' },
  { id: 'privkey',   sev: 'CRIT', re: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g, note: 'Llave privada' },
  { id: 'rss_app',   sev: 'WARN', re: /(rss\.app\/feeds\/[A-Za-z0-9_-]{8,})/g, note: 'Feed de RSS.app (la URL funciona como credencial)' },
  { id: 'urlkey',    sev: 'WARN', re: /[?&](?:api[_-]?key|apikey|key|token)=([A-Za-z0-9_-]{20,})/gi, note: 'Llave en parámetro de URL' },
  { id: 'assign',    sev: 'WARN', re: /\b(?:[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|SERVICE_ROLE)[A-Z0-9_]*)\s*[=:]\s*['"]?([A-Za-z0-9_\-./+]{16,})/g, note: 'Asignación de secreto' },
];
const JWT_RE = /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

const mask = (s) => s.length <= 10 ? '***' : s.slice(0, 6) + '…' + `(${s.length} car.)`;
function decodeJwt(t) { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')); } catch { return null; } }

const findings = new Map(); // clave: id|valor -> {sev,id,note,where:[…]}
function record(sev, id, note, value, where) {
  const key = id + '|' + value;
  if (!findings.has(key)) findings.set(key, { sev, id, note, masked: mask(value), where: [] });
  const f = findings.get(key);
  if (f.where.length < 4 && !f.where.includes(where)) f.where.push(where);
  f.count = (f.count || 0) + 1;
}

function scanLine(line, where) {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(line))) {
      const value = m[1] || m[0];
      const skip = rule.sev === 'CRIT' ? PLACEHOLDER_STRICT.test(value) : (PLACEHOLDER.test(value) || PLACEHOLDER.test(line.slice(Math.max(0, m.index - 6), m.index + m[0].length)));
      if (skip) continue;
      record(rule.sev, rule.id, rule.note, value, where);
    }
  }
  JWT_RE.lastIndex = 0;
  let j;
  while ((j = JWT_RE.exec(line))) {
    const payload = decodeJwt(j[1]);
    const role = payload && payload.role;
    if (role === 'service_role') record('CRIT', 'jwt_service_role', 'JWT de Supabase con rol service_role (acceso TOTAL a la base)', j[1], where);
    else if (role === 'anon') record('INFO', 'jwt_anon', 'JWT de Supabase con rol anon (público por diseño; protégelo con RLS)', j[1], where);
    else record('WARN', 'jwt_other', `JWT con rol "${role || 'desconocido'}"`, j[1], where);
  }
}

function isBinary(buf) { return buf.subarray(0, 4000).includes(0); }

// Vacía los hallazgos acumulados. Lo usan las pruebas para no arrastrar estado
// de un caso al siguiente.
function reset() { findings.clear(); }

// Lo grave arriba: si hay que leer cinco hallazgos, el primero tiene que ser el
// que obliga a rotar una llave.
const SEVERITY_ORDER = { CRIT: 0, WARN: 1, INFO: 2 };
function bySeverity(list) { return [...list].sort((a, b) => SEVERITY_ORDER[a.sev] - SEVERITY_ORDER[b.sev]); }

function main() {
  try { sh(['rev-parse', '--git-dir']); } catch { console.error('Ejecuta este script dentro de un repositorio git.'); process.exit(2); }

  // 0. ¿.env versionado o sin ignorar?
  const tracked = sh(['ls-files']).split('\n').filter(Boolean);
  const envTracked = tracked.filter(f => /(^|\/)\.env($|\.(?!example|sample))/.test(f));
  envTracked.forEach(f => record('CRIT', 'env_tracked', 'Archivo .env versionado en git', f, f));
  const gi = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
  const ignoresEnv = /^\s*\.env\b/m.test(gi);
  if (!ignoresEnv) record('WARN', 'gitignore', '.gitignore no excluye .env', '.gitignore', '.gitignore');

  // 0b. ¿Algún .env estuvo alguna vez en el historial (aunque ya esté borrado)?
  if (!noHistory) {
    const everTracked = new Set(sh(['log', '--all', '--pretty=format:', '--name-only']).split('\n').filter(f => /(^|\/)\.env($|\.(?!example|sample))/.test(f)));
    everTracked.forEach(f => { if (!envTracked.includes(f)) record('CRIT', 'env_history', 'Un .env estuvo en el historial de git (aunque ya esté borrado)', f, f + ' (historial)'); });
  }

  // 1. Archivos actuales
  console.log(`Escaneando ${tracked.length} archivos versionados…`);
  for (const f of tracked) {
    let buf; try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.length > 3_000_000 || isBinary(buf)) continue;
    buf.toString('utf8').split('\n').forEach((line, i) => { if (line.length < 4000) scanLine(line, `${f}:${i + 1}`); });
  }

  const finish = () => {
    const list = bySeverity(findings.values());
    console.log('');
    if (!list.length) console.log('✅ Sin hallazgos.');
    for (const f of list) {
      const icon = { CRIT: '❌ CRÍTICO', WARN: '⚠️  AVISO  ', INFO: 'ℹ️  INFO    ' }[f.sev];
      console.log(`${icon} ${f.note}\n           valor: ${f.masked} · apariciones: ${f.count}\n           dónde: ${f.where.join(' | ')}`);
    }
    const crit = list.filter(f => f.sev === 'CRIT').length;
    console.log(`\nResumen: ${crit} críticos · ${list.filter(f => f.sev === 'WARN').length} avisos · ${list.filter(f => f.sev === 'INFO').length} informativos`);
    if (crit) console.log('\nQué hacer con un CRÍTICO:\n  1) ROTA la llave en el proveedor (borrar el commit NO basta: ya pudo copiarse).\n  2) Actualiza la nueva llave en Vercel/Render.\n  3) Opcional: limpia el historial con git filter-repo y fuerza el push.');
    process.exit(crit ? 1 : 0);
  };

  if (noHistory) return finish();

  // 2. Historial: solo líneas AGREGADAS de todos los commits
  console.log('Escaneando historial (todas las ramas)…');
  const child = spawn('git', ['log', '--all', '-p', '-U0', '--no-color', '--format=@@COMMIT %h'], { maxBuffer: Infinity });
  let commit = '', file = '', buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('@@COMMIT ')) { commit = line.slice(9); continue; }
      if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
      if (line.startsWith('+') && !line.startsWith('+++') && line.length < 4000) scanLine(line.slice(1), `${commit}:${file}`);
    }
  });
  child.on('close', finish);
}

// Importado como módulo no escanea nada: solo exporta lo testeable.
if (require.main === module) main();

module.exports = { RULES, JWT_RE, PLACEHOLDER, PLACEHOLDER_STRICT, SEVERITY_ORDER, scanLine, mask, decodeJwt, isBinary, bySeverity, findings, reset };
