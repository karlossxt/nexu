// Lector de la "Agenda de movilizaciones" (SSC-CDMX) para Zero Vial.
// Puro y sin dependencias: recibe texto, devuelve eventos estructurados.
// Lo usan api/agenda.js y sus pruebas. No usa IA: el formato es regular.
//
// Privacidad: NUNCA se copia el texto libre de "Demanda" a la salida pública.
// Solo se deriva una categoría general, y los casos sensibles (víctimas,
// violencia, acoso) se anonimizan por completo.

const MONTHS = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7, agosto:8, septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12 };
const SECTION_RE = /^(marchas?|concentraciones?|rodadas?(?: ciclistas| motociclistas)?|eventos?(?: de esparcimiento)?|citas? agendadas?|plantones?|mitines?)$/i;
const SEPARATOR_RE = /^[»>\-_=*\s]{5,}$/;
const LABELS = {
  alcaldia: 'alcaldia', alcaldias: 'alcaldia', hora: 'hora', horario: 'hora', lugar: 'lugar', destino: 'destino',
  demanda: 'demanda', observaciones: 'observaciones', observacion: 'observaciones', aforo: 'aforo',
  'organizaciones en apoyo': 'apoyo', organizacion: 'apoyo'
};
const SENSITIVE_RE = /v[ií]ctima|abuso sexual|acoso|violaci[oó]n|violencia (?:familiar|de g[eé]nero|sexual)|feminicid|desaparec|menor(?:es)? de edad/i;

function strip(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function norm(s) { return strip(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function parseDate(text) {
  const m = norm(text).match(/(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+)?(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (!month) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseTime(value) {
  const v = norm(value);
  if (!v) return { time: null, allDay: false };
  if (/durante el dia|todo el dia|por determinar|sin hora/.test(v)) return { time: null, allDay: true };
  const m = v.match(/(\d{1,2})\s*[:.h]\s*(\d{2})?/);
  if (!m) return { time: null, allDay: false };
  const h = Number(m[1]), min = Number(m[2] || 0);
  if (h > 23 || min > 59) return { time: null, allDay: false };
  return { time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, allDay: false };
}

function parseAlcaldias(value) {
  return clean(value).split(/\s*,\s*|\s+y\s+/i).map(clean).filter(Boolean);
}

function demandCategory(text) {
  const t = norm(text);
  if (/salud|medic|hospital|enfermer|imss|issste/.test(t)) return 'Salud';
  if (/salario|sindicato|laboral|prestaci|jubilaci|trabajador|contrato colectivo|finiquito|pago/.test(t)) return 'Laboral';
  if (/estudiant|escuela|universidad|plantel|preparatoria|pliego petitorio|educativ|docente|maestr/.test(t)) return 'Educativa';
  if (/justicia|tribunal|juzgad|fiscal|juicio|proceso penal/.test(t)) return 'Justicia';
  if (/vecin|clausura|agua|basura|olor|obra|vivienda|desalojo/.test(t)) return 'Vecinal';
  if (/derechos|firmas|cannab/.test(t)) return 'Derechos y participación';
  return 'Social';
}

function severityFor({ kind, aforo, roadImpact }) {
  const a = Number.isFinite(aforo) ? aforo : 0;
  let level = roadImpact ? 'medium' : 'low';
  if (kind === 'marcha' && level === 'low') level = 'medium';
  if (a >= 200) level = roadImpact || kind === 'marcha' ? 'high' : 'medium';
  if (a >= 1000) level = 'critical';
  return level;
}

function kindOfSection(section) {
  const s = norm(section);
  if (/^marcha/.test(s)) return 'marcha';
  if (/^concentraci/.test(s)) return 'concentracion';
  if (/^rodada/.test(s)) return 'rodada';
  if (/^evento/.test(s)) return 'evento';
  if (/^cita/.test(s)) return 'cita';
  if (/^plant/.test(s)) return 'plantón';
  if (/^mitin/.test(s)) return 'concentracion';
  return 'otro';
}

// Convierte "Av. X No. 12, Col. Y, Alc. Z" en una consulta más amigable para geocodificar.
function geocodeQuery(place) {
  return clean(place)
    .replace(/\bAlc\.\s*/gi, 'alcaldía ')
    .replace(/\bCol\.\s*/gi, 'colonia ')
    .replace(/\bCalz\.\s*/gi, 'Calzada ')
    .replace(/\bProl\.\s*/gi, 'Prolongación ')
    .replace(/\bNo\.\s*(?=\d)/gi, '')
    .replace(/\bs\/n\b/gi, '')
    + ', Ciudad de México, México';
}

function splitBlocks(text) {
  const blocks = [];
  let current = [];
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (SEPARATOR_RE.test(line)) { if (current.length) blocks.push(current); current = []; continue; }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function parseBlock(lines, defaultSection) {
  let section = defaultSection;
  const fields = {};
  const places = [];
  let name = '';
  let last = null;
  for (const line of lines) {
    if (!line) { last = null; continue; }
    if (SECTION_RE.test(norm(line))) { section = line; last = null; continue; }
    if (/^agenda\b/i.test(norm(line)) && /\d{4}/.test(line)) { last = null; continue; }
    const m = line.match(/^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]{3,30}?)\s*(\d+)?\s*:\s*(.*)$/);
    if (m) {
      const key = LABELS[norm(m[1])];
      if (key) {
        const value = clean(m[3]);
        if (key === 'lugar') { places.push(value); last = { places: true }; }
        else { fields[key] = value; last = { key }; }
        continue;
      }
    }
    if (!name && !last) { name = clean(line); continue; }
    if (last && last.key) fields[last.key] = clean(`${fields[last.key]} ${line}`);
    else if (last && last.places) places[places.length - 1] = clean(`${places[places.length - 1]} ${line}`);
    else if (!name) name = clean(line);
  }
  return { section, name, fields, places };
}

// Devuelve { date, events, warnings }.
// Un evento = una concentración/marcha en UN lugar (si hay varios lugares se expanden).
function parseAgenda(text, options = {}) {
  const warnings = [];
  const source = String(text || '');
  const header = source.split('\n').find(l => /agenda/i.test(l) && /\d{4}/.test(l)) || '';
  const date = parseDate(header) || options.date || null;
  if (!date) warnings.push('No se encontró la fecha de la agenda; indícala manualmente.');

  const events = [];
  let section = '';
  const blocks = splitBlocks(source);
  for (const lines of blocks) {
    // Un bloque solo con encabezado de sección actualiza la sección por defecto.
    const meaningful = lines.filter(Boolean);
    if (meaningful.length && meaningful.every(l => SECTION_RE.test(norm(l)) || /^agenda\b/i.test(l) || (/agenda/i.test(l) && /\d{4}/.test(l)))) {
      const sec = meaningful.find(l => SECTION_RE.test(norm(l)));
      if (sec) section = sec;
      continue;
    }
    const b = parseBlock(lines, section);
    if (b.section) section = b.section;
    if (!b.name) continue;
    if (!b.places.length && !b.fields.destino) { warnings.push(`"${b.name.slice(0, 60)}" no trae lugar y se omitió.`); continue; }

    const { time, allDay } = parseTime(b.fields.hora);
    const aforoRaw = (b.fields.aforo || '').replace(/[^\d]/g, '');
    const aforo = aforoRaw ? Number(aforoRaw) : null;
    const hasDestination = !!b.fields.destino;
    const kind = kindOfSection(b.section) === 'otro' && hasDestination ? 'marcha' : kindOfSection(b.section);
    const observations = b.fields.observaciones || '';
    const roadImpact = kind === 'marcha' || hasDestination || /afectaci[oó]n de vialidades|cierre|bloqueo/i.test(observations);
    const sensitive = SENSITIVE_RE.test(`${b.name} ${b.fields.demanda || ''}`);
    const category = demandCategory(`${b.name} ${b.fields.demanda || ''}`);
    const places = b.places.length ? b.places : [b.fields.destino];

    places.forEach((place, i) => {
      events.push({
        date, kind, section: clean(b.section), name: b.name, publicName: sensitive ? null : b.name,
        sensitive, category: sensitive ? 'Justicia y derechos' : category,
        alcaldias: parseAlcaldias(b.fields.alcaldia),
        time, allDay, aforo, roadImpact, severity: severityFor({ kind, aforo, roadImpact }),
        place, destination: hasDestination ? b.fields.destino : null,
        placeIndex: i, placeCount: places.length,
        geocodeQuery: geocodeQuery(place)
      });
    });
  }
  if (!events.length) warnings.push('No se reconoció ninguna movilización en el texto.');
  return { date, events, warnings };
}

module.exports = { parseAgenda, parseDate, parseTime, severityFor, geocodeQuery, demandCategory, SENSITIVE_RE };
