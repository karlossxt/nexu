'use strict';
// Reglas para detectar que una alerta nueva es repetición de una ya publicada
// (mismo evento que sigue vigente), más allá de la ventana corta de 2 h.
// Conservador: exige misma vía, cercanía y texto parecido.

const INCIDENT_FAMILY = new Set(['crash', 'closure', 'road_hazard', 'other']);
const ONGOING_RE = /mantenimiento|obras?\b|desmantel|trabajos|reducci[oó]n de carriles/i;

function eventCompatible(a, b) {
  if (!a || !b) return false;
  return a === b || (INCIDENT_FAMILY.has(a) && INCIDENT_FAMILY.has(b));
}

// Horas máximas entre dos reportes para considerarlos el mismo evento.
function repeatWindowHours(row, existing) {
  if (row.event_type === 'traffic_update' && existing.event_type === 'traffic_update') return 6;
  const a = `${row.title || ''} ${row.detail || ''}`, b = `${existing.title || ''} ${existing.detail || ''}`;
  if (ONGOING_RE.test(a) && ONGOING_RE.test(b)) return 48;
  return 12;
}

// m: { hoursApart, distanceKm, similarity, sameRoad, sameKm }
function isOngoingRepeat(row, existing, m) {
  if (!m || !m.sameRoad || !Number.isFinite(m.distanceKm) || !Number.isFinite(m.hoursApart)) return false;
  if (m.hoursApart > repeatWindowHours(row, existing)) return false;
  if (row.event_type === 'traffic_update' && existing.event_type === 'traffic_update') {
    return m.distanceKm <= 0.5 && m.similarity >= 0.5;
  }
  if (!eventCompatible(row.event_type, existing.event_type)) return false;
  if (m.distanceKm > 1.5) return false;
  const sameType = row.event_type === existing.event_type;
  if (!(m.sameKm || m.distanceKm <= 0.25)) return false;
  return m.similarity >= (sameType ? 0.15 : 0.25);
}

module.exports = { isOngoingRepeat, repeatWindowHours, eventCompatible };
