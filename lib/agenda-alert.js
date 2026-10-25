// Convierte un evento de la agenda (lib/agenda-parser.js) en una fila de la tabla `alerts`.
// No cambia el esquema: usa event_type = 'scheduled_mobilization' y traffic_status
// = 'scheduled' | 'allday' para que el frontend distinga las movilizaciones programadas.

const crypto = require('node:crypto');

const SOURCE_NAME = 'SSC CDMX · Agenda de movilizaciones';
const EVENT_TYPE = 'scheduled_mobilization';
const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'a', 'al', 'por', 'para', 'con']);
const ACRONYMS = new Set(['UAM', 'UNAM', 'IPN', 'IMSS', 'ISSSTE', 'CNTE', 'SSC', 'CDMX', 'SNTSS', 'UPN', 'ENP', 'UGT', 'STPS', 'SCJN', 'TSJCDMX', 'CCH', 'FGJ', 'CNT']);
const KIND_LABEL = { marcha: 'Marcha', concentracion: 'Concentración', rodada: 'Rodada', evento: 'Evento', cita: 'Cita agendada', 'plantón': 'Plantón' };

function titleCase(text) {
  const words = String(text || '').trim().split(/\s+/);
  return words.map((w, i) => {
    const bare = w.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g, '');
    if (!bare) return w;
    if (ACRONYMS.has(bare.toUpperCase())) return w.toUpperCase();
    if (/^[IVXLCDM]+$/.test(bare)) return w.toUpperCase();          // números romanos (XXXII)
    if (/\d/.test(bare)) return w;                                    // "4:20", "No. 8"
    const lower = w.toLowerCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

function short(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Primer tramo del lugar, sin colonia ni alcaldía: "Tribunal Superior de Justicia..., Av. X No. 1" -> "Tribunal Superior de Justicia..."
function placeHeadline(place) {
  const head = String(place || '').split(',')[0].trim();
  return head || String(place || '').trim();
}

function when(ev) {
  if (ev.allDay) return 'Durante el día';
  if (ev.time) return `${ev.time} h`;
  return 'Horario por confirmar';
}

function buildTitle(ev) {
  const kind = KIND_LABEL[ev.kind] || 'Movilización';
  const multi = ev.placeCount > 1 ? ` (punto ${ev.placeIndex + 1} de ${ev.placeCount})` : '';
  if (ev.sensitive || !ev.publicName) return short(`${kind} en ${placeHeadline(ev.place)}${multi}`, 140);
  return short(`${kind}: ${titleCase(ev.publicName)}${multi}`, 140);
}

function buildDetail(ev) {
  const parts = ['Movilización programada según la agenda de la SSC CDMX.', `${ev.category}.`, `${when(ev)}.`, `Lugar: ${short(ev.place, 160)}.`];
  if (ev.destination) parts.push(`Destino: ${short(ev.destination, 140)}.`);
  if (ev.aforo) parts.push(`Aforo estimado: ${ev.aforo} personas.`);
  parts.push(ev.roadImpact ? 'Posible afectación de vialidades.' : 'Sin afectación vial anunciada.');
  return short(parts.join(' '), 500);
}

function eventAt(ev) {
  // CDMX no usa horario de verano desde 2022: UTC-6 fijo.
  const hhmm = ev.allDay || !ev.time ? '00:00' : ev.time;
  return `${ev.date}T${hhmm}:00-06:00`;
}

function externalId(ev) {
  const base = `${ev.date}|${String(ev.name || '').toLowerCase()}|${String(ev.place || '').toLowerCase()}|${ev.time || (ev.allDay ? 'dia' : '')}`;
  return `ssc-agenda:${ev.date}:${crypto.createHash('sha1').update(base).digest('hex').slice(0, 14)}`;
}

function safeUrl(raw) {
  try { const u = new URL(String(raw || '')); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

// geo: { latitude, longitude, precision: 'exact'|'zone', confidence } o null si no se localizó.
function buildRow(ev, geo, options = {}) {
  const hasPoint = geo && Number.isFinite(Number(geo.latitude)) && Number.isFinite(Number(geo.longitude));
  const zone = hasPoint && geo.precision === 'zone';
  return {
    external_id: externalId(ev),
    title: buildTitle(ev),
    detail: buildDetail(ev),
    category: 'road',
    severity: ['critical', 'high', 'medium', 'low'].includes(ev.severity) ? ev.severity : 'low',
    event_type: EVENT_TYPE,
    traffic_status: ev.allDay ? 'allday' : 'scheduled',
    state: 'Ciudad de México',
    municipality: (ev.alcaldias && ev.alcaldias[0]) || null,
    road: null,
    kilometer: null,
    location_label: short(ev.sensitive ? placeHeadline(ev.place) : ev.place, 200),
    latitude: hasPoint ? Number(geo.latitude) : null,
    longitude: hasPoint ? Number(geo.longitude) : null,
    location_confidence: hasPoint ? Math.min(1, Math.max(0, Number(geo.confidence) || 0.5)) : null,
    location_precision: hasPoint ? (zone ? 'zone' : 'exact') : 'unlocated',
    location_status: hasPoint ? (zone ? 'approximate' : 'automatic') : 'unlocated',
    source_name: SOURCE_NAME,
    source_url: safeUrl(options.sourceUrl),
    event_at: new Date(eventAt(ev)).toISOString()
  };
}

module.exports = { buildRow, buildTitle, buildDetail, externalId, titleCase, eventAt, SOURCE_NAME, EVENT_TYPE };
