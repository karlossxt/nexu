// Función serverless: /api/agenda
// Importa la "Agenda de movilizaciones" (SSC-CDMX) como alertas programadas.
//   POST { action:'parse',   text, date? }                 -> eventos detectados (sin guardar nada)
//   POST { action:'publish', events:[...], sourceUrl? }     -> guarda/actualiza en la tabla `alerts`
// Solo para cuentas con rol operator/admin: el navegador envía su sesión de Supabase
// (Authorization: Bearer <access_token>) y el servidor la valida aquí.
// Requiere SUPABASE_SERVICE_ROLE_KEY (solo servidor, nunca en el navegador).

const { parseAgenda, SENSITIVE_RE } = require('../lib/agenda-parser');
const { buildRow } = require('../lib/agenda-alert');

const DEFAULT_SUPABASE_URL = 'https://hjymytmsstmhivjdtxso.supabase.co';
const MAX_TEXT = 64 * 1024;
const MAX_EVENTS = 60;
const MAX_PER_MIN = 20;
const rate = new Map();

function remoteIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'anon';
}
function rateLimited(ip) {
  const now = Date.now();
  const cur = rate.get(ip) || { n: 0, t: now };
  if (now - cur.t > 60000) { cur.n = 0; cur.t = now; }
  cur.n += 1;
  rate.set(ip, cur);
  if (rate.size > 1000) for (const [k, v] of rate) if (now - v.t > 120000) rate.delete(k);
  return cur.n > MAX_PER_MIN;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return new URL(origin).host === host;
  } catch { return false; }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_TEXT * 2) throw new Error('body demasiado grande');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function supabaseConfig() {
  return {
    url: String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, ''),
    key: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  };
}

// Devuelve el rol ('operator' | 'admin') o null si la sesión no es válida o no tiene permiso.
async function operatorRole(req, cfg) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return { status: 401, error: 'Inicia sesión para importar la agenda.' };
  const headers = { apikey: cfg.key, Authorization: 'Bearer ' + token };
  const userRes = await fetch(cfg.url + '/auth/v1/user', { headers, signal: AbortSignal.timeout(8000) });
  if (!userRes.ok) return { status: 401, error: 'Sesión inválida o vencida.' };
  const user = await userRes.json();
  if (!user || !user.id) return { status: 401, error: 'Sesión inválida.' };
  const profRes = await fetch(cfg.url + '/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(user.id) + '&limit=1', {
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key }, signal: AbortSignal.timeout(8000)
  });
  const rows = profRes.ok ? await profRes.json() : [];
  const role = rows && rows[0] && rows[0].role;
  if (!['operator', 'admin'].includes(role)) return { status: 403, error: 'Tu cuenta no tiene permiso para importar la agenda.' };
  return { role, userId: user.id };
}

const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// El navegador manda los eventos ya revisados; aquí se valida todo de nuevo.
function sanitizeEvent(raw, todayMs) {
  if (!raw || typeof raw !== 'object') return null;
  const date = str(raw.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dayMs = Date.parse(date + 'T12:00:00-06:00');
  if (!Number.isFinite(dayMs) || Math.abs(dayMs - todayMs) > 3 * 86400000) return null;
  const time = /^\d{2}:\d{2}$/.test(str(raw.time, 5)) ? str(raw.time, 5) : null;
  const name = str(raw.name, 200);
  const place = str(raw.place, 300);
  if (!name || !place) return null;
  const forcedSensitive = SENSITIVE_RE.test(name);
  const aforo = Number.isFinite(Number(raw.aforo)) && Number(raw.aforo) > 0 ? Math.min(Math.round(Number(raw.aforo)), 1000000) : null;
  const ev = {
    date, time, allDay: !time && !!raw.allDay,
    kind: ['marcha', 'concentracion', 'rodada', 'evento', 'cita', 'plantón'].includes(raw.kind) ? raw.kind : 'concentracion',
    name, publicName: forcedSensitive || raw.sensitive ? null : name,
    sensitive: forcedSensitive || !!raw.sensitive,
    category: str(raw.category, 40) || 'Social',
    alcaldias: Array.isArray(raw.alcaldias) ? raw.alcaldias.slice(0, 3).map(a => str(a, 60)).filter(Boolean) : [],
    aforo, roadImpact: !!raw.roadImpact,
    severity: ['critical', 'high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'low',
    place, destination: raw.destination ? str(raw.destination, 300) : null,
    placeIndex: Math.max(0, Math.min(20, Number(raw.placeIndex) || 0)),
    placeCount: Math.max(1, Math.min(20, Number(raw.placeCount) || 1))
  };
  let geo = null;
  const g = raw.geo;
  if (g && Number.isFinite(Number(g.latitude)) && Number.isFinite(Number(g.longitude))) {
    const lat = Number(g.latitude), lon = Number(g.longitude);
    if (lat >= 14 && lat <= 33 && lon >= -119 && lon <= -86) {
      geo = { latitude: lat, longitude: lon, precision: g.precision === 'zone' ? 'zone' : 'exact', confidence: Number(g.confidence) || 0.5 };
    }
  }
  return { ev, geo };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'origen no permitido' });
  if (rateLimited(remoteIp(req))) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'demasiadas peticiones, espera un minuto' }); }

  const cfg = supabaseConfig();
  if (!cfg.key) return res.status(503).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el servidor. Agrégala en las variables de entorno.' });

  let body;
  try { body = await readBody(req); } catch { return res.status(400).json({ error: 'solicitud inválida' }); }

  try {
    const who = await operatorRole(req, cfg);
    if (who.error) return res.status(who.status).json({ error: who.error });

    if (body.action === 'parse') {
      const text = String(body.text || '');
      if (!text.trim()) return res.status(400).json({ error: 'Pega el texto de la agenda.' });
      if (text.length > MAX_TEXT) return res.status(413).json({ error: 'El texto es demasiado largo.' });
      const out = parseAgenda(text, { date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : null });
      if (out.events.length > MAX_EVENTS) return res.status(413).json({ error: 'Demasiadas movilizaciones en un solo envío.' });
      return res.status(200).json(out);
    }

    if (body.action === 'publish') {
      const list = Array.isArray(body.events) ? body.events : [];
      if (!list.length) return res.status(400).json({ error: 'No hay movilizaciones seleccionadas.' });
      if (list.length > MAX_EVENTS) return res.status(413).json({ error: 'Demasiadas movilizaciones en un solo envío.' });
      const now = Date.now();
      const rows = [];
      let skipped = 0;
      for (const item of list) {
        const clean = sanitizeEvent(item, now);
        if (!clean) { skipped += 1; continue; }
        rows.push(buildRow(clean.ev, clean.geo, { sourceUrl: body.sourceUrl }));
      }
      if (!rows.length) return res.status(400).json({ error: 'Ninguna movilización pasó la validación (revisa la fecha: solo se aceptan días cercanos a hoy).' });
      const r = await fetch(cfg.url + '/rest/v1/alerts?on_conflict=external_id', {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows), signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) {
        console.error('[api/agenda] supabase', r.status, (await r.text()).slice(0, 300));
        return res.status(502).json({ error: 'No se pudieron guardar las alertas en la base de datos.' });
      }
      return res.status(200).json({ saved: rows.length, skipped });
    }

    return res.status(400).json({ error: 'acción no válida' });
  } catch (e) {
    console.error('[api/agenda]', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'error interno' });
  }
};
