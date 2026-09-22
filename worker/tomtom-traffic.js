'use strict';

/**
 * TomTom Traffic shadow source for Zero Vial.
 *
 * Disabled unless TOMTOM_TRAFFIC_ENABLED=true and TOMTOM_API_KEY is present.
 * Uses TomTom Orbis Traffic Incidents Details API v2. In shadow mode it only
 * reports incident counts/samples; it does not create alerts or consume AI.
 *
 * TOMTOM_BBOXES format:
 *   "minLon,minLat,maxLon,maxLat;minLon,minLat,maxLon,maxLat"
 * Example CDMX test box:
 *   "-99.36,19.18,-98.94,19.60"
 */

const DEFAULT_ATTRIBUTES =
  'incidents(type,geometry(type,coordinates),properties(id,iconCategory,magnitudeOfDelay,events(description,code,iconCategory),startTime,endTime,from,to,lengthInMeters,delayInSeconds,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime))';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function enabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(clean(env.TOMTOM_TRAFFIC_ENABLED))
    && !!clean(env.TOMTOM_API_KEY);
}

function parseBboxes(value) {
  return clean(value).split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const n=part.split(',').map(Number);
    if (n.length !== 4 || n.some(x => !Number.isFinite(x))) return null;
    const [minLon,minLat,maxLon,maxLat]=n;
    if (!(minLon < maxLon && minLat < maxLat)) return null;
    return { minLon,minLat,maxLon,maxLat, raw:n.join(',') };
  }).filter(Boolean);
}

function centroid(geometry) {
  const coords=geometry && geometry.coordinates;
  if (!Array.isArray(coords)) return null;
  const points=[];
  const walk=value => {
    if (Array.isArray(value) && value.length>=2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      points.push([Number(value[0]),Number(value[1])]);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
  };
  walk(coords);
  if (!points.length) return null;
  const sum=points.reduce((a,p)=>[a[0]+p[0],a[1]+p[1]],[0,0]);
  return { lon:sum[0]/points.length, lat:sum[1]/points.length };
}

function classifyIncident(incident) {
  const icon=clean(incident && incident.icon_category).toLowerCase();
  const description=clean(incident && incident.description).toLowerCase();
  const text=`${icon} ${description}`;

  if (/roadclosed|road closed|closed road|cierre|cerrad/.test(text)) return 'road_closed';
  if (/accident|collision|crash|choque|colisi[oó]n|accidente/.test(text)) return 'accident';
  if (/broken|vehicle breakdown|aver[ií]a|veh[ií]culo detenido/.test(text)) return 'broken_vehicle';
  if (/roadworks|road works|construction|obras|trabajos/.test(text)) return 'road_works';
  if (/weather|flood|fog|ice|snow|rain|inund|niebla|hielo|nieve|lluv/.test(text)) return 'weather';
  if (/hazard|danger|obstacle|debris|object on road|peligro|obst[aá]culo/.test(text)) return 'road_hazard';
  if (/jam|slow traffic|heavy traffic|congestion|tr[aá]fico lento|congesti[oó]n/.test(text)) return 'jam';
  return 'other';
}

function operationalValue(incident) {
  const category=incident.category || classifyIncident(incident);
  if (['road_closed','accident','broken_vehicle','road_hazard','weather'].includes(category)) return 'high';
  if (category === 'road_works') {
    const text=clean(incident.description).toLowerCase();
    return /closed|closure|lane|cerrad|cierre|carril/.test(text) ? 'high' : 'medium';
  }
  if (category === 'jam') {
    const delay=Number(incident.delay_seconds);
    return Number.isFinite(delay) && delay >= 600 ? 'medium' : 'low';
  }
  return 'low';
}

function summarizeIncidents(incidents) {
  const counts={ road_closed:0, accident:0, broken_vehicle:0, road_works:0, weather:0, road_hazard:0, jam:0, other:0 };
  const value={ high:0, medium:0, low:0 };
  const highValue=[];
  for (const incident of incidents || []) {
    const category=incident.category || classifyIncident(incident);
    counts[category]=(counts[category] || 0)+1;
    const level=incident.operational_value || operationalValue({ ...incident, category });
    value[level]=(value[level] || 0)+1;
    if (level === 'high') highValue.push(incident);
  }
  return { counts, operational_value:value, high_value:highValue };
}

function normalizeIncident(incident) {
  const p=incident && incident.properties || {};
  const events=Array.isArray(p.events) ? p.events : [];
  const descriptions=events.map(e=>clean(e && e.description)).filter(Boolean);
  const point=centroid(incident && incident.geometry);
  const base = {
    id: clean(p.id),
    type: clean(incident && incident.type),
    icon_category: p.iconCategory ?? null,
    magnitude_of_delay: p.magnitudeOfDelay ?? null,
    description: descriptions.join(' | '),
    from: clean(p.from),
    to: clean(p.to),
    road_numbers: Array.isArray(p.roadNumbers) ? p.roadNumbers.map(clean).filter(Boolean) : [],
    delay_seconds: Number.isFinite(Number(p.delayInSeconds)) ? Number(p.delayInSeconds) : null,
    length_m: Number.isFinite(Number(p.lengthInMeters)) ? Number(p.lengthInMeters) : null,
    start_time: p.startTime || null,
    end_time: p.endTime || null,
    last_report_time: p.lastReportTime || null,
    probability: p.probabilityOfOccurrence ?? null,
    reports: p.numberOfReports ?? null,
    latitude: point && point.lat,
    longitude: point && point.lon
  };
  base.category=classifyIncident(base);
  base.operational_value=operationalValue(base);
  return base;
}

async function fetchBox(box, { apiKey, signal } = {}) {
  const url=new URL('https://api.tomtom.com/maps/orbis/traffic/incidents/details');
  url.searchParams.set('apiVersion','2');
  url.searchParams.set('bbox',box.raw);
  url.searchParams.set('timeValidity','present');

  const response=await fetch(url,{
    signal,
    headers:{
      Accept:'application/json',
      'TomTom-Api-Key':apiKey,
      'TomTom-Api-Version':'2',
      Attributes:DEFAULT_ATTRIBUTES
    }
  });
  const raw=await response.text();
  if (!response.ok) throw new Error('TomTom '+response.status+': '+raw.slice(0,240));
  const body=raw ? JSON.parse(raw) : {};
  return (Array.isArray(body.incidents) ? body.incidents : []).map(normalizeIncident);
}

async function fetchShadowIncidents(env = process.env) {
  if (!enabled(env)) return { enabled:false, incidents:[], boxes:0, errors:[] };
  let boxes=parseBboxes(env.TOMTOM_BBOXES);
  let usedDefaultBox=false;
  if (!boxes.length) {
    boxes=parseBboxes('-99.36,19.18,-98.94,19.60');
    usedDefaultBox=true;
  }

  const apiKey=clean(env.TOMTOM_API_KEY);
  const incidents=[];
  const errors=[];
  for (const box of boxes) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try {
      incidents.push(...await fetchBox(box,{apiKey,signal:controller.signal}));
    } catch (error) {
      errors.push(clean(error && error.message).slice(0,220));
    } finally {
      clearTimeout(timer);
    }
  }

  const unique=new Map();
  for (const incident of incidents) {
    const key=incident.id || [incident.description,incident.latitude,incident.longitude].join('|');
    if (!unique.has(key)) unique.set(key,incident);
  }
  const normalized=[...unique.values()];
  const summary=summarizeIncidents(normalized);
  return { enabled:true, incidents:normalized, boxes:boxes.length, errors, used_default_box:usedDefaultBox, summary };
}

module.exports={
  enabled,
  parseBboxes,
  normalizeIncident,
  classifyIncident,
  operationalValue,
  summarizeIncidents,
  fetchShadowIncidents
};
