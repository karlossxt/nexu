'use strict';

function orientativeCorridorPoint(road, geo) {
  if (!geo?.route_verified || !String(geo.resolved_state || '').trim() ||
      !Number.isFinite(Number(geo.latitude)) || !Number.isFinite(Number(geo.longitude)) ||
      Number(geo.confidence)<.58) return null;
  return { ...geo, label:`${String(road).trim()} · punto orientativo del corredor`,
    confidence:Math.min(Number(geo.confidence),.65), status:'approximate', precision:'corridor_reference' };
}

module.exports={ orientativeCorridorPoint };
