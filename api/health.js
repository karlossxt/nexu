// /api/health — para monitores externos (UptimeRobot, Better Stack).
// 200 si el worker reportó actividad recientemente; 503 si no.
const DEFAULT_SUPABASE_URL = 'https://hjymytmsstmhivjdtxso.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_iJtw2kIhrCr1dSkKL8Mg3w_IWtbdIep';
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const url = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim().replace(/\/$/, '');
  const key = String(process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY).trim();
  const maxMin = Math.max(5, Number(process.env.HEALTH_MAX_MIN) || 30);
  try {
    const r = await fetch(url + '/rest/v1/worker_status?select=id,status,updated_at,last_success_at&order=updated_at.desc&limit=1', {
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    });
    if (!r.ok) return res.status(503).json({ ok: false, error: 'supabase_' + r.status });
    const row = (await r.json())[0];
    if (!row) return res.status(503).json({ ok: false, error: 'sin_estado_del_worker' });
    const ageMin = Math.round((Date.now() - new Date(row.updated_at).getTime()) / 60000);
    const ok = ageMin <= maxMin && row.status !== 'error';
    return res.status(ok ? 200 : 503).json({ ok, status: row.status, age_min: ageMin, max_min: maxMin });
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'sin_conexion' });
  }
};
