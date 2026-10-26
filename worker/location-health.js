'use strict';
// Monitor de salud de ubicaciones. Cada ciclo del worker mira las alertas CON
// kilómetro creadas en las últimas horas y avisa si la mayoría quedó "sin ubicación".
// Motivo: del 28-sep al 8-oct la mayoría de las alertas con carretera y kilómetro
// quedaron sin punto durante 11 días y nadie se enteró.
//
// Umbral por defecto: 35 %. Con datos reales, el funcionamiento normal ronda el
// 15 % y la caída de septiembre/octubre superó el 80 %.
// Aviso opcional por webhook (Discord, Slack u otro): ALERT_WEBHOOK_URL.

const DEFAULTS = { windowHours: 6, minSample: 10, maxUnlockedPct: 35, repeatHours: 6 };

function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let unlocated = 0, approximate = 0;
  for (const row of list) {
    const precision = String(row && row.location_precision || '').toLowerCase();
    if (precision === 'unlocated' || precision === '') unlocated++;
    else if (precision === 'road_approximate') approximate++;
  }
  const withKm = list.length;
  const pct = n => (withKm ? Math.round((n / withKm) * 1000) / 10 : 0);
  return {
    with_km: withKm,
    unlocated_with_km: unlocated,
    unlocated_with_km_pct: pct(unlocated),
    // Solo informativo: bajó esperado tras reconocer rnc_poste / kilometer_rnc_network.
    approx_with_km_pct: pct(approximate)
  };
}

function evaluate(summary, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const enough = summary.with_km >= o.minSample;
  const alarm = enough && summary.unlocated_with_km_pct > o.maxUnlockedPct;
  return {
    enough_sample: enough,
    alarm,
    reason: alarm
      ? `${summary.unlocated_with_km} de ${summary.with_km} alertas con kilómetro (${summary.unlocated_with_km_pct} %) quedaron sin ubicación en las últimas ${o.windowHours} h`
      : null
  };
}

function createMonitor() {
  const state = { active: false, lastSentAt: 0 };

  async function send(webhookUrl, text, fetchImpl, log) {
    if (!webhookUrl) return false;
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, text }), // Discord usa "content", Slack usa "text"
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) log('warn', 'El webhook de avisos respondió con error', { status: response.status });
      return response.ok;
    } catch (error) {
      log('warn', 'No se pudo enviar el aviso al webhook', { error: error.message });
      return false;
    }
  }

  async function check({ sb, now = Date.now(), webhookUrl = '', log = () => {}, fetchImpl = fetch, options = {} }) {
    const o = { ...DEFAULTS, ...options };
    const since = new Date(now - o.windowHours * 3600_000).toISOString();
    const rows = await sb(`alerts?select=location_precision,kilometer&kilometer=not.is.null&created_at=gte.${encodeURIComponent(since)}&limit=2000`);
    const summary = summarize(rows);
    const verdict = evaluate(summary, o);
    const result = { window_hours: o.windowHours, ...summary, ...verdict };

    if (verdict.alarm) {
      log('error', 'ALERTA: ubicaciones degradadas', result);
      if (!state.active || now - state.lastSentAt >= o.repeatHours * 3600_000) {
        const text = `⚠️ Zero Vial: ${verdict.reason}. Revisa claves de geocodificación, datos RNC y la compuerta estricta del worker.`;
        if (await send(webhookUrl, text, fetchImpl, log)) state.lastSentAt = now;
      }
      state.active = true;
    } else if (state.active && verdict.enough_sample) {
      state.active = false;
      log('info', 'Ubicaciones normalizadas', result);
      await send(webhookUrl, `✅ Zero Vial: las ubicaciones volvieron a la normalidad (${summary.unlocated_with_km_pct} % sin ubicación en las últimas ${o.windowHours} h).`, fetchImpl, log);
    }
    return result;
  }

  return { check, _state: state };
}

module.exports = { summarize, evaluate, createMonitor, DEFAULTS };
