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
  'incidents(type,geometry(type,coordinates),properties(id,iconCategory,magnitudeOfDelay,events(description,code,iconCategory),startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime))';

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

function normalizeIncident(incident) {
  const p=incident && incident.properties || {};
  const events=Array.isArray(p.events) ? p.events : [];
  const descriptions=events.map(e=>clean(e && e.description)).filter(Boolean);
  const point=centroid(incident && incident.geometry);
  return {
    id: clean(p.id),
    type: clean(incident && incident.type),
    icon_category: p.iconCategory ?? null,
    magnitude_of_delay: p.magnitudeOfDelay ?? null,
    description: descriptions.join(' | '),
    from: clean(p.from),
    to: clean(p.to),
    road_numbers: Array.isArray(p.roadNumbers) ? p.roadNumbers.map(clean).filter(Boolean) : [],
    delay_seconds: Number.isFinite(Number(p.delay)) ? Number(p.delay) : null,
    length_m: Number.isFinite(Number(p.length)) ? Number(p.length) : null,
    start_time: p.startTime || null,
    end_time: p.endTime || null,
    last_report_time: p.lastReportTime || null,
    probability: p.probabilityOfOccurrence ?? null,
    reports: p.numberOfReports ?? null,
    latitude: point && point.lat,
    longitude: point && point.lon
  };
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
  return { enabled:true, incidents:[...unique.values()], boxes:boxes.length, errors, used_default_box:usedDefaultBox };
}

module.exports={
  enabled,
  parseBboxes,
  normalizeIncident,
  fetchShadowIncidents
};
