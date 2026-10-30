'use strict';
// Límite de uso compartido entre instancias (Supabase, función rate_hit).
// Devuelve true solo si está confirmado que se superó el límite. Si no hay
// credenciales o la consulta falla, devuelve false (el límite local sigue activo).
const DEFAULT_SUPABASE_URL = 'https://hjymytmsstmhivjdtxso.supabase.co';

async function sharedRateLimited(bucket, ip, max, windowSec = 60) {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) return false;
  const url = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(url + '/rest/v1/rpc/rate_hit', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: bucket + ':' + ip, p_limit: max, p_window_seconds: windowSec }),
      signal: ctl.signal
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch (e) { return false; } finally { clearTimeout(timer); }
}
module.exports = { sharedRateLimited };
