'use strict';
// Pruebas de scripts/verify-red-vial.js. La regla que más importa aquí es la
// negativa: el script solo marca chainageVerified:true cuando hay anclas reales
// y el ajuste pasa los umbrales. Con datos inventados jamas debe verificar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hav, cumulative, project, fit, analyze } = require('./verify-red-vial');

const OPT = { 'min-anchors': 3, 'slope-tol': 0.05, 'max-resid': 1.0, 'max-offroad': 1.5 };

// Trazo recto de norte a sur. kmStart/kmEnd se derivan de la longitud REAL del
// trazo: un corredor cuyo rango de km no cuadre con su geometría es justamente
// lo que el script debe rechazar, así que el fixture no puede mentir.
function straightCorridor() {
  const c = { badge: 'test', name: 'Prueba', pts: [[19.00, -99.00], [19.01, -99.00], [19.02, -99.00], [19.03, -99.00], [19.04, -99.00]] };
  c._cum = cumulative(c.pts);
  c.kmStart = 0;
  c.kmEnd = Math.round(c._cum[c._cum.length - 1] * 1000) / 1000;
  return c;
}

// Ancla coherente: el km coincide con la distancia recorrida sobre el trazo,
// que es lo que hace que la pendiente sea exactamente 1.
function anchorAt(c, frac) {
  const target = frac * c._cum[c._cum.length - 1];
  for (let k = 1; k < c.pts.length; k++) {
    const seg = hav(c.pts[k - 1][0], c.pts[k - 1][1], c.pts[k][0], c.pts[k][1]);
    if (seg > 0 && (target - c._cum[k - 1]) / seg < 1) {
      const r = (target - c._cum[k - 1]) / seg;
      return {
        label: 'ancla ' + Math.round(frac * 100) + '%',
        km: Math.round(target * 1000) / 1000,
        lat: c.pts[k - 1][0] + (c.pts[k][0] - c.pts[k - 1][0]) * r,
        lon: c.pts[k - 1][1] + (c.pts[k][1] - c.pts[k - 1][1]) * r
      };
    }
  }
  return { label: 'ancla ' + Math.round(frac * 100) + '%', km: target, lat: c.pts[0][0], lon: c.pts[0][1] };
}
const anchorsAt = (c, fracs) => fracs.map(f => anchorAt(c, f));

test('hav rounds the earth at a sane scale', () => {
  assert.equal(Math.round(hav(19.0, -99.0, 19.0, -99.0)), 0);
  const oneDeg = hav(0, 0, 1, 0);
  assert.ok(oneDeg > 110 && oneDeg < 112, 'un grado de latitud mide ~111 km, salió ' + oneDeg);
});

test('cumulative starts at zero and never goes backwards', () => {
  const cum = cumulative([[19.0, -99.0], [19.01, -99.0], [19.02, -99.0]]);
  assert.equal(cum[0], 0);
  assert.ok(cum[1] > cum[0] && cum[2] > cum[1], 'acumulado monótono: ' + cum.join(','));
});

test('project snaps a point on the polyline to zero offset and the right distance', () => {
  const c = straightCorridor();
  const on = project(c.pts, c._cum, 19.02, -99.0);
  assert.ok(on.offroad < 0.01, 'un punto sobre el trazo queda a distancia ~0, no ' + on.offroad);
  assert.ok(Math.abs(on.d - c._cum[2]) < 0.02, 'cae en el vértice d=' + on.d);
  const beside = project(c.pts, c._cum, 19.02, -98.99);
  assert.ok(beside.offroad > 0.9 && beside.offroad < 1.1, '0.01 grado de longitud mide ~1.05 km, salió ' + beside.offroad);
});

test('fit recovers a known line and reports its slope', () => {
  const { a, b } = fit([{ km: 10, d: 10 }, { km: 50, d: 50 }, { km: 90, d: 90 }]);
  assert.ok(Math.abs(b - 1) < 1e-9, 'pendiente 1, salió ' + b);
  assert.ok(Math.abs(a) < 1e-9, 'ordenada al origen 0, salió ' + a);
  const half = fit([{ km: 0, d: 0 }, { km: 50, d: 100 }]);
  assert.ok(Math.abs(half.b - 0.5) < 1e-9, 'pendiente 0.5, salió ' + half.b);
});

test('a corridor without anchors is never verified', () => {
  const { out } = analyze(straightCorridor(), [], OPT);
  assert.equal(out.verified, false);
  assert.equal(out.status, 'sin_anclas');
});

test('coherent anchors over the trace verify the corridor', () => {
  const c = straightCorridor();
  const { out, pts } = analyze(c, anchorsAt(c, [0.1, 0.4, 0.7, 0.95]), OPT);
  assert.equal(out.verified, true, 'motivos: ' + (out.reasons || []).join(' | '));
  assert.equal(out.status, 'verificado');
  assert.ok(Math.abs(out.slope - 1) < OPT['slope-tol'], 'pendiente cercana a 1: ' + out.slope);
  assert.equal(pts.length, 4);
  assert.ok(out.coverage > 0.8, 'las anclas cubren el trazo: ' + out.coverage);
  assert.ok(out.loo_max_km <= OPT['max-resid'], 'error leave-one-out: ' + out.loo_max_km);
});

test('too few anchors leave the corridor unverified', () => {
  const c = straightCorridor();
  const { out } = analyze(c, anchorsAt(c, [0.2, 0.8]), OPT);
  assert.equal(out.verified, false);
  assert.ok((out.reasons || []).some(r => r.includes('mínimo 3 anclas')), 'motivos: ' + (out.reasons || []).join(' | '));
});

test('anchors whose kilometres do not match the traced distance are rejected by slope', () => {
  const c = straightCorridor();
  // km comprimidos a la mitad: el trazo recorre el doble de lo que dicen los km.
  // fit devuelve km por km de trazo, así que la pendiente cae a 0.5.
  const anchors = anchorsAt(c, [0.1, 0.4, 0.7, 0.95]).map(a => ({ ...a, km: a.km / 2 }));
  const { out } = analyze(c, anchors, OPT);
  assert.equal(out.verified, false);
  assert.equal(out.status, 'rechazado');
  assert.ok(Math.abs(out.slope - 0.5) < 0.01, 'la pendiente vale 0.5: ' + out.slope);
  assert.ok((out.reasons || []).some(r => r.includes('≠ 1')), 'motivos: ' + (out.reasons || []).join(' | '));
});

test('anchors far from the trace are dropped instead of bending the fit', () => {
  const c = straightCorridor();
  const anchors = anchorsAt(c, [0.1, 0.4, 0.7, 0.95]);
  anchors[1] = { ...anchors[1], lat: anchors[1].lat + 0.5 };  // ~55 km lejos del trazo
  const { out } = analyze(c, anchors, OPT);
  assert.equal(out.anchors_used, 3, 'solo sobreviven las tres anclas buenas');
  assert.ok(out.dropped.some(d => d.reason.includes('del trazo')), 'motivo: ' + JSON.stringify(out.dropped));
  assert.equal(out.verified, true, 'un ancla perdida no debe impedir verificar: ' + (out.reasons || []).join(' | '));
});

test('a single misplaced kilometre is discarded as an outlier', () => {
  const c = straightCorridor();
  const anchors = anchorsAt(c, [0.1, 0.4, 0.7, 0.95]);
  anchors[1] = { ...anchors[1], km: anchors[1].km + 3 };  // Poste mal rotulado
  const { out, pts } = analyze(c, anchors, OPT);
  assert.equal(pts.length, 3, 'la ancla atípica se descarta: ' + JSON.stringify(out.dropped));
  assert.ok(out.dropped.some(d => d.reason.includes('atípica')), 'motivo: ' + JSON.stringify(out.dropped));
  assert.equal(out.verified, true, 'con las tres anclas buenas sí verifica: ' + (out.reasons || []).join(' | '));
});

test('a decreasing kilometre order is inverted instead of rejected', () => {
  const c = straightCorridor();
  const length = c._cum[c._cum.length - 1];
  // km creciendo mientras el trazo se recorre al revés: la pendiente sale negativa.
  const anchors = anchorsAt(c, [0.95, 0.7, 0.4, 0.1]).map(a => ({ ...a, km: length - a.km }));
  const { out, reversed, pts } = analyze(c, anchors, OPT);
  assert.equal(reversed, true);
  assert.ok(Math.abs(out.slope - 1) < OPT['slope-tol'], 'tras invertir la pendiente vuelve a ser 1: ' + out.slope);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].d > pts[i - 1].d, 'd queda monótono creciente con el km');
  assert.equal(out.verified, true, (out.reasons || []).join(' | '));
});

test('incomplete anchor data is dropped, not guessed', () => {
  const c = straightCorridor();
  const anchors = anchorsAt(c, [0.1, 0.4, 0.7, 0.95]);
  anchors[0] = { label: 'sin coordenadas', km: 10 };
  const { out } = analyze(c, anchors, OPT);
  assert.ok(out.dropped.some(d => d.reason === 'datos incompletos'), JSON.stringify(out.dropped));
  assert.equal(out.anchors_used, 3);
});

test('a repeated kilometre is averaged into a single anchor', () => {
  const c = straightCorridor();
  const anchors = anchorsAt(c, [0.1, 0.4, 0.7, 0.95]);
  anchors.splice(1, 0, { ...anchors[0], lat: anchors[0].lat + 0.0001 });
  const { pts } = analyze(c, anchors, OPT);
  assert.equal(pts.filter(p => Math.abs(p.km - anchors[0].km) < 0.01).length, 1, 'el km repetido colapsa en uno');
});
