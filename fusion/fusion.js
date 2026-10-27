/* ============================================================================
   ZERO VIAL · FUSIÓN  ·  Núcleo vanilla JS
   Porta a tu código (sin React) lo mejor del proyecto VíaSegura (Gemini):
     1. Modo Viaje / HUD de conducción con puntaje de seguridad radial
     2. Modo Nocturno automático (sensor de luz + horario)
     3. PWA instalable + Service Worker + modo sin conexión
     4. Reporte mensual en PDF (jsPDF)
     5. Calculadora de peajes / casetas
     6. Analítica de zonas de seguridad (estados, corredores, matriz de riesgo)
     7. Push por zona de influencia / ruta planificada
   Se apoya en los globales que ya expone Zero Vial (alerts, map, myPosition,
   alertSeverity, incidentVisual, haversineKm, openModal, gpsTrack, etc.).
   ============================================================================ */
(function () {
  'use strict';

  var FZ = {};
  window.Fusion = FZ;

  /* =========================================================================
     0. UTILIDADES
     ========================================================================= */
  var CFG = {
    nightKey: 'zv_fusion_night_v1',
    pushKey: 'zv_fusion_push_v1',
    pushLogKey: 'zv_fusion_push_log_v1',
    pushSeenKey: 'zv_fusion_push_seen_v1',
    verifyKey: 'zv_fusion_verify_v1'
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    if (window.escapeHtml) { try { return window.escapeHtml(value); } catch (e) {} }
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, type) {
    if (window.log) { try { window.log(msg, type || 'info'); return; } catch (e) {} }
    if (window.trafficMessage) { try { window.trafficMessage(msg); return; } catch (e) {} }
    (type === 'error' ? console.error : console.log)('[Fusion]', msg);
  }

  function allAlerts() { try { return Array.isArray(alerts) ? alerts : []; } catch (e) { return []; } }
  function myPos() { try { return myPosition || null; } catch (e) { return null; } }
  function hasPoint(a) {
    if (window.hasAlertPoint) { try { return !!window.hasAlertPoint(a); } catch (e) {} }
    return !!a && Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lon)) && a.location_precision !== 'corridor_reference';
  }
  function dist(a, pos) {
    pos = pos || myPos();
    if (!pos || !hasPoint(a)) return null;
    if (window.haversineKm) { try { return window.haversineKm(pos.lat, pos.lon, Number(a.lat), Number(a.lon)); } catch (e) {} }
    var R = 6371, dLat = (a.lat - pos.lat) * Math.PI / 180, dLon = (a.lon - pos.lon) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(pos.lat * Math.PI / 180) * Math.cos(a.lat * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function sev(a) {
    if (window.alertSeverity) { try { return window.alertSeverity(a); } catch (e) {} }
    if (a && a.importante) return 'critical';
    return a && a.category === 'security' ? 'high' : 'medium';
  }
  var SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
  function vis(a) {
    if (window.incidentVisual) { try { return window.incidentVisual(a); } catch (e) {} }
    return { color: a && a.category === 'security' ? '#DC2626' : '#F97316', icon: 'fa-triangle-exclamation', label: 'Incidencia' };
  }
  function isBlockage(a) {
    if (window.isBlockageAlert) { try { return !!window.isBlockageAlert(a); } catch (e) {} }
    return /bloqueo|cierre|manifestaci|protesta/i.test((a && (a.title || '') + ' ' + (a.detail || '')) || '');
  }
  function isExpired(a) {
    if (window.isAlertExpired) { try { return !!window.isAlertExpired(a); } catch (e) {} }
    return false;
  }
  function refLabel(a) {
    if (window.alertKnownReference) { try { return window.alertKnownReference(a) || ''; } catch (e) {} }
    return a && (a.reference || a.corridor) ? (a.reference || a.corridor) : '';
  }
  function refOf(a) {
    return refLabel(a) || (a && (a.corridor || a.road || a.location || '')) || 'Sin referencia';
  }
  function fmtDate(v) { var d = new Date(v); return isFinite(d.getTime()) ? d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function money(n) { return '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
  function num(n, d) { return Number(n).toLocaleString('es-MX', { maximumFractionDigits: d == null ? 0 : d }); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function load(key, fallback) { try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  function byId(id) { return document.getElementById(id); }

  var labelSeq = 0;
  var legacyModal = { current: null, lastFocus: null };
  function focusElement(el) {
    if (!el || typeof el.focus !== 'function') return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  }
  function linkLabels(root) {
    $$('.fz-field', root || document).forEach(function (field) {
      var label = field.querySelector('label');
      var controls = $$('input:not([type="hidden"]), select, textarea', field);
      if (!label || !controls.length) return;
      if (controls.length === 1) {
        var control = controls[0];
        if (!control.id) control.id = 'fz-label-' + (++labelSeq);
        if (!label.htmlFor && !label.control) label.htmlFor = control.id;
        return;
      }
      var base = (label.textContent || '').trim();
      controls.forEach(function (control, i) {
        if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return;
        if (base) control.setAttribute('aria-label', base + (i ? ' (' + (i + 1) + ')' : ''));
      });
    });
  }
  function observeLabels(ov) {
    if (ov.__fzLabelObserver || typeof MutationObserver === 'undefined') return;
    ov.__fzLabelObserver = new MutationObserver(function () { linkLabels(ov); });
    ov.__fzLabelObserver.observe(ov, { childList: true, subtree: true });
    linkLabels(ov);
  }
  function focusablesIn(ov) {
    return $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', ov)
      .filter(function (el) {
        if (el.type === 'hidden' || el.tabIndex < 0) return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      });
  }
  function trapFocus(ov, e) {
    if (e.key !== 'Tab') return;
    var list = focusablesIn(ov);
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    var modal = ov.querySelector('.fz-modal, .u-modal-card') || ov;
    var outside = !ov.contains(active) || active === modal;
    if (e.shiftKey && (active === first || outside)) { e.preventDefault(); focusElement(last); }
    else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); focusElement(first); }
  }
  function closeOverlay(ov) {
    if (!ov || !ov.classList.contains('fz-open')) return;
    ov.classList.remove('fz-open');
    var last = ov.__fzLastFocus;
    ov.__fzLastFocus = null;
    if (last && document.contains(last)) focusElement(last);
  }

  function isLegacyModal(el) {
    return !!el && (el.classList.contains('u-modal') || el.id === 'alert-modal');
  }
  function legacyModalIsOpen(el) {
    return !!el && (el.classList.contains('open') || el.style.display === 'flex');
  }
  function legacyOpen(el) {
    if (!el || legacyModal.current === el) return;
    legacyModal.current = el;
    legacyModal.lastFocus = document.activeElement;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
      var head = el.querySelector('h2[id], h3[id]') || el.querySelector('.m-head, .am-head, h2, h3');
      if (head && head.id) {
        el.setAttribute('aria-labelledby', head.id);
      } else if (head) {
        var clone = head.cloneNode(true);
        clone.querySelectorAll('button, i, svg').forEach(function (node) { node.remove(); });
        var title = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        if (title) el.setAttribute('aria-label', title);
      }
    }
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    var target = el.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
    if (!target) target = el.querySelector('button:not([disabled]):not(.m-x):not(.am-x)');
    focusElement(target || el);
  }
  function legacyClose(el) {
    if (!el || legacyModal.current !== el) return;
    legacyModal.current = null;
    var last = legacyModal.lastFocus;
    legacyModal.lastFocus = null;
    if (last && document.contains(last)) focusElement(last);
  }
  function installLegacyModalA11y() {
    var modals = $$('.u-modal, #alert-modal');
    if (!modals.length) return;
    if (typeof MutationObserver !== 'undefined') {
      var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
          var el = mutation.target;
          if (!isLegacyModal(el)) return;
          if (legacyModalIsOpen(el)) legacyOpen(el); else legacyClose(el);
        });
      });
      modals.forEach(function (el) { observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] }); });
    }
    modals.forEach(function (el) { if (legacyModalIsOpen(el)) legacyOpen(el); });
    document.addEventListener('keydown', function (e) {
      var el = legacyModal.current; if (!el) return;
      if (e.key === 'Escape') {
        if (el.id === 'alert-modal' && typeof window.closeAlertModal === 'function') { window.closeAlertModal(); return; }
        if (typeof window.closeModal === 'function') { window.closeModal(el.id); return; }
      }
      if (e.key === 'Tab') trapFocus(el, e);
    });
  }

  function openM(id) {
    var el = byId(id); if (!el) return;
    // Los overlays de Fusión usan `fz-open`; los modales heredados de index.html usan `open`.
    if (el.classList.contains('fz-overlay')) { showOverlay(id); return; }
    if (window.openModal) return window.openModal(id);
    el.classList.add('open');
  }
  function closeM(id) {
    var el = byId(id); if (!el) return;
    if (el.classList.contains('fz-overlay')) { closeOverlay(el); return; }
    if (window.closeModal) return window.closeModal(id);
    el.classList.remove('open');
  }

  // Crea (una sola vez) un overlay con modal y devuelve el nodo del cuerpo interno.
  function ensureOverlay(id, opts) {
    var ov = byId(id);
    if (ov) return ov.querySelector('.fz-modal-body');
    opts = opts || {};
    ov = document.createElement('div');
    ov.id = id;
    ov.className = 'fz-overlay';
    ov.innerHTML =
      '<div class="fz-backdrop" data-close="' + id + '"></div>' +
      '<div class="fz-modal ' + (opts.size || '') + '" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="' + id + '-title">' +
        '<div class="fz-modal-head">' +
          '<h3 id="' + id + '-title">' + (opts.icon ? '<i class="fa-solid ' + opts.icon + '"></i>' : '') + esc(opts.title || '') +
          (opts.sub ? ' <span class="fz-sub">' + esc(opts.sub) + '</span>' : '') + '</h3>' +
          '<button class="fz-x" type="button" data-close="' + id + '" aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div class="fz-modal-body fz-scroll"></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      var t = e.target.closest('[data-close]');
      if (t) closeOverlay(ov);
    });
    document.addEventListener('keydown', function (e) {
      if (!ov.classList.contains('fz-open')) return;
      if (e.key === 'Escape') { closeOverlay(ov); return; }
      trapFocus(ov, e);
    });
    observeLabels(ov);
    return ov.querySelector('.fz-modal-body');
  }
  function showOverlay(id) {
    var ov = byId(id); if (!ov) return;
    if (!ov.classList.contains('fz-open')) {
      ov.__fzLastFocus = document.activeElement;
      ov.classList.add('fz-open');
    }
    linkLabels(ov);
    var target = ov.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])') || ov.querySelector('.fz-modal');
    focusElement(target);
  }

  function chart(id, config) {
    if (typeof Chart === 'undefined') return null;
    var cv = byId(id); if (!cv) return null;
    if (FZ._charts[id]) { try { FZ._charts[id].destroy(); } catch (e) {} }
    FZ._charts[id] = new Chart(cv, config);
    return FZ._charts[id];
  }
  FZ._charts = {};

  function themeAxis() {
    var dark = document.body.classList.contains('dark-mode') || document.body.classList.contains('road-high-contrast');
    return { text: dark ? '#CBD5E1' : '#667085', grid: dark ? 'rgba(148,163,184,.12)' : 'rgba(71,84,103,.10)' };
  }

  /* =========================================================================
     1. PUNTAJE DE SEGURIDAD RADIAL  (adaptado de VíaSegura / RadialSafetyScore)
     ========================================================================= */
  FZ.safetyScore = function (list, onToll) {
    list = list || [];
    var security = list.filter(function (a) { return a.category === 'security'; }).length;
    var roadwork = list.filter(function (a) { return /obra|constru|mantenim|infraestructura|bache/i.test(((a.title || '') + ' ' + (a.detail || ''))); }).length;
    var critical = list.filter(function (a) { return sev(a) === 'critical'; }).length;
    var high = list.filter(function (a) { return sev(a) === 'high'; }).length;

    var secDed = Math.min(38, security * 11);
    var roadDed = Math.min(22, roadwork * 8);
    var critDed = Math.min(34, critical * 15);
    var highDed = Math.min(16, high * 5);
    var tollBonus = onToll ? 7 : 0;
    var score = Math.round(clamp(100 - secDed - roadDed - critDed - highDed + tollBonus, 0, 100));

    var status, label, color, reco;
    if (score >= 85) { status = 'optimo'; label = 'Óptimo'; color = '#10B981'; reco = 'Condiciones favorables. Mantén velocidad de crucero y precaución estándar.'; }
    else if (score >= 70) { status = 'favorable'; label = 'Favorable'; color = '#22C55E'; reco = 'Tramo mayormente libre. Atención moderada en puntos señalados.'; }
    else if (score >= 50) { status = 'precaucion'; label = 'Precaución'; color = '#F59E0B'; reco = 'Hay incidentes relevantes en la zona. Reduce velocidad y mantén distancia.'; }
    else { status = 'critico'; label = 'Crítico'; color = '#EF4444'; reco = 'Zona de riesgo elevado. Considera ruta alterna o extrema precaución.'; }

    return {
      score: score, status: status, label: label, color: color, recommendation: reco,
      securityCount: security, roadworkCount: roadwork, criticalCount: critical, highCount: high,
      tollBonus: tollBonus,
      breakdown: [
        ['Incidentes de seguridad', '−' + secDed],
        ['Obras / infraestructura', '−' + roadDed],
        ['Alertas críticas', '−' + critDed],
        ['Alertas de riesgo alto', '−' + highDed],
        ['Autopista de cuota', '+' + tollBonus]
      ]
    };
  };

  function ringHTML(res, size) {
    size = size || 190;
    var r = size / 2 - 14, c = 2 * Math.PI * r, off = c * (1 - res.score / 100);
    return '<div class="fz-ring" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg width="' + size + '" height="' + size + '">' +
        '<circle class="fz-ring-track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="12"/>' +
        '<circle class="fz-ring-val" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + res.color + '" stroke-width="12" stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '"/>' +
      '</svg>' +
      '<div class="fz-ring-center"><b style="color:' + res.color + '">' + res.score + '</b><span>Seguridad</span><small style="color:' + res.color + '">' + res.label + '</small></div>' +
    '</div>';
  }

  /* =========================================================================
     2. MODO NOCTURNO AUTOMÁTICO
     ========================================================================= */
  var night = Object.assign({
    mode: 'schedule', luxThreshold: 20, highContrast: true, boostFont: false,
    schedule: { startHour: 19, startMinute: 30, endHour: 6, endMinute: 30 }
  }, load(CFG.nightKey, {}));
  var sensorLux = null, luxSensor = null, nightTick = null;

  function inNightWindow(d) {
    var now = d.getHours() * 60 + d.getMinutes();
    var s = night.schedule.startHour * 60 + night.schedule.startMinute;
    var e = night.schedule.endHour * 60 + night.schedule.endMinute;
    return s <= e ? (now >= s && now < e) : (now >= s || now < e);
  }
  function nightShouldBeOn() {
    if (night.mode === 'on') return true;
    if (night.mode === 'off') return false;
    if (night.mode === 'schedule') return inNightWindow(new Date());
    if (sensorLux != null) return sensorLux < Number(night.luxThreshold);
    return inNightWindow(new Date());
  }
  function applyNight() {
    var on = nightShouldBeOn();
    var cls = night.highContrast && on;
    document.body.classList.toggle('road-high-contrast', !!cls);
    document.documentElement.classList.toggle('road-high-contrast', !!cls);
    document.body.classList.toggle('fz-boost-font', !!night.boostFont);
    if (on) document.body.classList.add('dark-mode');
    FZ._nightOn = on;
    var btn = byId('fz-night-btn');
    if (btn) {
      btn.innerHTML = '<i class="fa-solid ' + (on ? 'fa-moon' : 'fa-sun') + '"></i>';
      btn.classList.toggle('active', on);
      btn.title = on ? 'Modo nocturno activo (tocar para desactivar)' : 'Modo nocturno (tocar para activar)';
      btn.setAttribute('aria-pressed', String(on));
    }
    var st = byId('fz-night-status');
    if (st) st.textContent = (on ? 'Activo' : 'Inactivo') + ' · ' + modeLabel(night.mode) + (sensorLux != null ? ' · ' + Math.round(sensorLux) + ' lux' : '');
  }
  function modeLabel(m) { return ({ auto: 'Automático (luz/horario)', on: 'Siempre encendido', off: 'Apagado', schedule: 'Por horario' }[m] || m); }

  function startLuxSensor() {
    if (!('AmbientLightSensor' in window)) return;
    try {
      luxSensor = new window.AmbientLightSensor({ frequency: 1 });
      luxSensor.addEventListener('reading', function () { sensorLux = luxSensor.illuminance; applyNight(); });
      var p = luxSensor.start();
      if (p && p.catch) p.catch(function () { luxSensor = null; });
    } catch (e) { luxSensor = null; }
  }
  function stopLuxSensor() { if (luxSensor) { try { luxSensor.stop(); } catch (e) {} luxSensor = null; } sensorLux = null; }

  FZ.night = {
    toggle: function () { night.mode = nightShouldBeOn() ? 'off' : 'on'; save(CFG.nightKey, night); applyNight(); },
    open: function () { openNightPanel(); },
    get: function () { return night; }
  };

  function openNightPanel() {
    var body = ensureOverlay('fz-night-ov', { title: 'Modo Nocturno de Carretera', icon: 'fa-moon', size: 'fz-w-sm', sub: 'Alto contraste OLED' });
    body.innerHTML =
      '<p class="fz-muted" style="margin:0 0 12px;font-size:12.5px;line-height:1.5">Diseñado para cabina: fondo negro puro para eliminar reflejos en el parabrisas, texto de alto contraste y controles más grandes. <b id="fz-night-status"></b></p>' +
      '<div class="fz-field"><label>Modo de activación</label><div class="fz-chips" id="fz-night-mode">' +
        ['auto', 'schedule', 'on', 'off'].map(function (m) {
          return '<button class="fz-chip" data-mode="' + m + '">' + esc(modeLabel(m)) + '</button>';
        }).join('') +
      '</div></div>' +
      '<div class="fz-grid2">' +
        '<div class="fz-field"><label>Umbral de luz (lux)</label><input id="fz-night-lux" type="number" min="1" max="500" value="' + night.luxThreshold + '"><small class="fz-muted" style="font-size:11px">Debajo de este valor se activa (si el sensor está disponible).</small></div>' +
        '<div class="fz-field"><label>Horario nocturno</label><div class="fz-flex"><input id="fz-night-start" type="time" aria-label="Hora de inicio del horario nocturno" value="' + pad(night.schedule.startHour) + ':' + pad(night.schedule.startMinute) + '"><span class="fz-muted">a</span><input id="fz-night-end" type="time" aria-label="Hora de fin del horario nocturno" value="' + pad(night.schedule.endHour) + ':' + pad(night.schedule.endMinute) + '"></div></div>' +
      '</div>' +
      '<label class="fz-switch"><span><i class="fa-solid fa-circle-half-stroke"></i> Alto contraste OLED estricto</span><input id="fz-night-contrast" type="checkbox" ' + (night.highContrast ? 'checked' : '') + '></label>' +
      '<label class="fz-switch" style="margin-top:9px"><span><i class="fa-solid fa-text-height"></i> Texto más grande para conducción</span><input id="fz-night-font" type="checkbox" ' + (night.boostFont ? 'checked' : '') + '></label>' +
      '<div class="fz-sep"></div>' +
      '<div class="fz-flex"><button class="fz-btn fz-primary" id="fz-night-save"><i class="fa-solid fa-floppy-disk"></i> Guardar</button>' +
      '<button class="fz-btn" id="fz-night-preview"><i class="fa-solid fa-eye"></i> Vista previa</button>' +
      '<span class="fz-muted" style="font-size:11px">' + (('AmbientLightSensor' in window) ? 'Sensor de luz disponible en este dispositivo.' : 'Sin sensor de luz: se usa el horario.') + '</span></div>';

    $$('#fz-night-ov .fz-chip[data-mode]').forEach(function (b) {
      b.classList.toggle('fz-on', b.dataset.mode === night.mode);
      b.onclick = function () {
        $$('#fz-night-ov .fz-chip[data-mode]').forEach(function (x) { x.classList.remove('fz-on'); });
        b.classList.add('fz-on');
      };
    });
    byId('fz-night-save').onclick = function () {
      var sel = $('#fz-night-ov .fz-chip[data-mode].fz-on');
      night.mode = sel ? sel.dataset.mode : night.mode;
      night.luxThreshold = Number(byId('fz-night-lux').value) || 20;
      night.highContrast = byId('fz-night-contrast').checked;
      night.boostFont = byId('fz-night-font').checked;
      var s = (byId('fz-night-start').value || '19:30').split(':'), e = (byId('fz-night-end').value || '06:30').split(':');
      night.schedule = { startHour: +s[0], startMinute: +s[1], endHour: +e[0], endMinute: +e[1] };
      save(CFG.nightKey, night);
      if (night.mode === 'auto') startLuxSensor(); else stopLuxSensor();
      applyNight();
      toast('Modo nocturno guardado', 'info');
      closeM('fz-night-ov');
    };
    byId('fz-night-preview').onclick = function () { applyNight(); FZ.night.toggle(); setTimeout(applyNight, 1200); };

    showOverlay('fz-night-ov');
    applyNight();
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  /* =========================================================================
     3. PWA / SERVICE WORKER / OFFLINE
     ========================================================================= */
  var deferredPrompt = null;
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return; // requiere http(s)
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).then(function () {
      FZ._swReady = true;
    }).catch(function () { FZ._swReady = false; });
  }

  function installApp() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') toast('Instalando Zero Vial…', 'info');
        deferredPrompt = null;
        refreshInstallButtons();
      });
      return;
    }
    // Guía manual (iOS / navegadores sin prompt)
    var body = ensureOverlay('fz-install-ov', { title: 'Instalar Zero Vial', icon: 'fa-download', size: 'fz-w-sm' });
    body.innerHTML =
      '<p class="fz-install-guide">Instala Zero Vial como aplicación para usarla a pantalla completa y <b>sin conexión</b> en carretera.' +
      (isIOS()
        ? '<ol><li>Toca el botón <b>Compartir</b> <i class="fa-solid fa-arrow-up-from-bracket"></i> del navegador.</li><li>Elige <b>Añadir a pantalla de inicio</b>.</li><li>Confirma con <b>Añadir</b>.</li></ol>'
        : '<ol><li>Abre el menú del navegador (⋮).</li><li>Elige <b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.</li><li>Confirma.</li></ol>') +
      '</p><div class="fz-sep"></div><button type="button" class="fz-btn fz-primary" data-close="fz-install-ov"><i class="fa-solid fa-check"></i> Entendido</button>';
    showOverlay('fz-install-ov');
  }
  function refreshInstallButtons() {
    var show = !isStandalone() && !!deferredPrompt;
    $$('.fz-install-btn').forEach(function (b) { b.classList.toggle('fz-hidden', !show); });
  }

  function initOffline() {
    var bar = byId('fz-offline-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fz-offline-bar';
      bar.className = 'fz-offline';
      bar.innerHTML = '<i class="fa-solid fa-wifi"></i><span id="fz-offline-msg">Sin conexión</span>' +
        '<button type="button" onclick="Fusion.refreshOffline()"><i class="fa-solid fa-rotate"></i> Reintentar</button>';
      document.body.appendChild(bar);
    }
    FZ.refreshOffline = function () { updateOffline(true); };
    window.addEventListener('online', function () { updateOffline(); });
    window.addEventListener('offline', function () { updateOffline(); });
    updateOffline();
  }
  function cachedCount() { try { var raw = localStorage.getItem('nv_alerts'); return raw ? (JSON.parse(raw) || []).length : 0; } catch (e) { return 0; } }
  function updateOffline(manual) {
    var bar = byId('fz-offline-bar'); if (!bar) return;
    var off = !navigator.onLine;
    if (off) {
      byId('fz-offline-msg').innerHTML = '<b>Modo sin conexión carretero:</b> sin internet. La app sigue funcionando con datos guardados. <b>' + cachedCount() + '</b> alertas en memoria.';
      bar.classList.add('fz-open');
    } else {
      bar.classList.remove('fz-open');
      if (manual) toast('Conexión restablecida', 'ok');
    }
  }

  /* =========================================================================
     4. DATOS AUXILIARES (casetas con tarifas + paradas seguras)
     ========================================================================= */
  function tolls() { return window.ZERO_VIAL_TOLLS || []; }
  function corridors() { return window.ZERO_VIAL_TOLL_CORRIDORS || []; }
  function safeStops() { return window.ZERO_VIAL_SAFE_STOPS || []; }
  function vehicleLabels() { return window.FUSION_VEHICLE_LABELS || { auto: { name: 'Automóvil' } }; }
  function nearest(list, pos, keyLat, keyLon) {
    if (!pos) return null;
    var best = null, bestD = Infinity;
    list.forEach(function (it) {
      var a = { lat: it[keyLat], lon: it[keyLon] };
      var d = dist(a, pos);
      if (d != null && d < bestD) { bestD = d; best = { item: it, km: d }; }
    });
    return best;
  }

  /* =========================================================================
     5. MODO VIAJE / HUD
     ========================================================================= */
  var TRIP_CORRIDORS = [
    { id: 'todas', label: 'Todas las carreteras', re: null },
    { id: '57', label: 'Autopista 57 / 57D (MX–Qro)', re: /(^|\D)57/ },
    { id: '95', label: 'Autopista del Sol 95D', re: /95/ },
    { id: '150', label: 'Autopista 150D (Puebla–Veracruz)', re: /150/ },
    { id: '85', label: 'Autopista 85D (Monterrey–Laredo)', re: /85/ },
    { id: '54', label: 'Autopista 54D (GDL–Colima)', re: /54/ },
    { id: 'm40', label: 'Arco Norte (M40D)', re: /40|arco/i }
  ];
  var trip = { corridor: 'todas', radiusKm: 120, sound: true, open: false, timer: null, lastSample: null, speed: 0 };

  FZ.trip = {
    open: function (corridorId) {
      if (corridorId) trip.corridor = corridorId;
      buildTrip();
      trip.open = true;
      byId('fz-trip').classList.add('fz-open');
      if (window.gpsTrack) { try { window.gpsTrack(); } catch (e) {} }
      renderTrip();
      clearInterval(trip.timer);
      trip.timer = setInterval(renderTrip, 15000);
    },
    close: function () {
      trip.open = false;
      var el = byId('fz-trip'); if (el) el.classList.remove('fz-open');
      clearInterval(trip.timer); trip.timer = null;
    },
    setCorridor: function (id) { trip.corridor = id; renderTrip(); },
    toggleSound: function () { trip.sound = !trip.sound; renderTrip(); },
    focus: function (id) { this.close(); var a = allAlerts().find(function (x) { return String(x.id) === String(id); }); if (a && window.showAlertFocus) { try { window.showAlertFocus(a); } catch (e) {} } if (window.map && hasPoint(a)) window.map.setView([a.lat, a.lon], 14); },
    report: function () { this.close(); if (window.openEntryModal) window.openEntryModal(); },
    openAlerts: function () { this.close(); if (window.openAlertCenter) window.openAlertCenter(); },
    openRoute: function () { this.close(); if (window.openRouteModal) window.openRouteModal(); }
  };

  function buildTrip() {
    if (byId('fz-trip')) return;
    var el = document.createElement('div');
    el.id = 'fz-trip';
    el.className = 'fz-trip';
    el.innerHTML =
      '<div class="fz-trip-top">' +
        '<div class="fz-trip-title"><i class="fa-solid fa-car-on"></i> Modo Viaje · HUD</div>' +
        '<select id="fz-trip-corridor" class="fz-btn fz-sm" style="width:auto" title="Corredor monitoreado"></select>' +
        '<span id="fz-trip-gps" class="fz-badge fz-info"></span>' +
        '<div class="fz-trip-actions">' +
          '<button class="fz-btn fz-sm" id="fz-trip-night" onclick="Fusion.night.toggle();Fusion.tripRefresh()"><i class="fa-solid fa-moon"></i> Nocturno</button>' +
          '<button class="fz-btn fz-sm" id="fz-trip-sound" onclick="Fusion.trip.toggleSound()"><i class="fa-solid fa-volume-high"></i> Aviso</button>' +
          '<button class="fz-btn fz-sm" onclick="Fusion.push.open()"><i class="fa-solid fa-bell"></i> Push</button>' +
          '<button class="fz-btn fz-sm fz-danger" onclick="Fusion.trip.close()"><i class="fa-solid fa-xmark"></i> Salir</button>' +
        '</div>' +
      '</div>' +
      '<div class="fz-trip-body">' +
        '<div class="fz-trip-col">' +
          '<div class="fz-trip-card"><header><i class="fa-solid fa-gauge-high"></i> Tablero</header><div class="fz-trip-card-body">' +
            '<div id="fz-trip-hud" class="fz-trip-hud"></div>' +
          '</div></div>' +
          '<div class="fz-trip-card"><header><i class="fa-solid fa-shield-halved"></i> Seguridad del tramo</header><div class="fz-trip-card-body" id="fz-trip-score"></div></div>' +
        '</div>' +
        '<div class="fz-trip-col">' +
          '<div class="fz-trip-card"><header><i class="fa-solid fa-triangle-exclamation"></i> Próximas alertas</header><div class="fz-trip-card-body"><div id="fz-trip-alerts" class="fz-trip-list"></div></div></div>' +
          '<div class="fz-trip-card"><header><i class="fa-solid fa-bolt"></i> Acciones rápidas</header><div class="fz-trip-card-body">' +
            '<div class="fz-trip-quick">' +
              '<button onclick="Fusion.trip.report()"><i class="fa-solid fa-plus"></i> Reportar</button>' +
              '<button onclick="Fusion.trip.openAlerts()"><i class="fa-solid fa-list-check"></i> Alertas</button>' +
              '<button onclick="Fusion.trip.openRoute()"><i class="fa-solid fa-route"></i> Ruta</button>' +
              '<button onclick="Fusion.trip.openPush()"><i class="fa-solid fa-bell"></i> Push</button>' +
            '</div>' +
            '<p class="fz-trip-note fz-mt">HUD informativo. No sustituye tu atención al volante; no manipules el dispositivo mientras conduces.</p>' +
          '</div></div>' +
        '</div>' +
        '<div class="fz-trip-col">' +
          '<div class="fz-trip-card"><header><i class="fa-solid fa-money-bill-wave"></i> Próxima caseta</header><div class="fz-trip-card-body" id="fz-trip-toll"></div></div>' +
          '<div class="fz-trip-card"><header><i class="fa-solid fa-mug-hot"></i> Paradas seguras cercanas</header><div class="fz-trip-card-body" id="fz-trip-stops"></div></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    FZ.tripRefresh = renderTrip;
    var sel = byId('fz-trip-corridor');
    sel.innerHTML = TRIP_CORRIDORS.map(function (c) { return '<option value="' + c.id + '">' + esc(c.label) + '</option>'; }).join('');
    sel.value = trip.corridor;
    sel.onchange = function () { trip.corridor = sel.value; renderTrip(); };
  }

  function computeSpeed() {
    var p = myPos(); if (!p) { trip.speed = 0; return; }
    var now = Date.now();
    if (trip.lastSample && trip.lastSample.pos) {
      var d = dist({ lat: p.lat, lon: p.lon }, trip.lastSample.pos);
      var dt = (now - trip.lastSample.t) / 3600000;
      if (d != null && dt > 0.0002) trip.speed = clamp(d / dt, 0, 220);
    }
    trip.lastSample = { pos: { lat: p.lat, lon: p.lon }, t: now };
  }

  function corridorMatch(a) {
    var c = TRIP_CORRIDORS.find(function (x) { return x.id === trip.corridor; });
    if (!c || !c.re) return true;
    return c.re.test((a.title || '') + ' ' + (a.location || '') + ' ' + refLabel(a) + ' ' + (a.corridor || ''));
  }

  function renderTrip() {
    if (!trip.open) return;
    computeSpeed();
    var pos = myPos();
    var effective = pos || { lat: 19.4326, lon: -99.1332 };
    var usingFallback = !pos;

    var nearby = allAlerts().filter(function (a) {
      if (!hasPoint(a)) return false;
      if (!corridorMatch(a)) return false;
      if (isExpired(a)) return false;
      var d = dist(a, effective);
      return d != null && d <= trip.radiusKm;
    }).map(function (a) { return { a: a, km: dist(a, effective) }; }).sort(function (x, y) { return x.km - y.km; });

    var gps = byId('fz-trip-gps');
    gps.className = 'fz-badge ' + (usingFallback ? 'fz-medium' : 'fz-ok');
    gps.innerHTML = usingFallback ? '<i class="fa-solid fa-location-crosshairs"></i> Sin GPS · centro MX' : '<i class="fa-solid fa-location-crosshairs"></i> GPS activo';

    var next = nearby[0];
    byId('fz-trip-hud').innerHTML =
      '<div><b style="color:#22d3ee">' + Math.round(trip.speed) + '</b><span>km/h</span></div>' +
      '<div><b>' + nearby.length + '</b><span>alertas</span></div>' +
      '<div><b>' + (next ? (next.km < 10 ? next.km.toFixed(1) : Math.round(next.km)) : '—') + '</b><span>km próxima</span></div>';

    var res = FZ.safetyScore(nearby.map(function (x) { return x.a; }), /d|cuota|autopista/i.test(trip.corridor) || trip.corridor === 'todas');
    byId('fz-trip-score').innerHTML = ringHTML(res, 168) +
      '<p class="fz-trip-note" style="text-align:center;margin-top:8px">' + esc(res.recommendation) + '</p>';

    var list = byId('fz-trip-alerts');
    list.innerHTML = nearby.length ? nearby.slice(0, 12).map(function (x) {
      var v = vis(x.a);
      return '<div class="fz-trip-alert" onclick="Fusion.trip.focus(\'' + esc(String(x.a.id)) + '\')">' +
        '<span class="fz-ta-icon" style="background:' + v.color + '"><i class="fa-solid ' + v.icon + '"></i></span>' +
        '<span class="fz-ta-copy"><b>' + esc(x.a.title || 'Incidencia') + '</b><span>' + esc(x.a.location || '') + ' · ' + fmtDate(x.a.time) + '</span></span>' +
        '<span class="fz-ta-dist">' + (x.km < 10 ? x.km.toFixed(1) : Math.round(x.km)) + ' km</span></div>';
    }).join('') : '<div class="fz-empty">Sin alertas en ' + trip.radiusKm + ' km con este corredor.</div>';

    var nt = nearest(tolls(), effective, 'lat', 'lon');
    byId('fz-trip-toll').innerHTML = nt ? (
      '<b>' + esc(nt.item.name) + '</b><p class="fz-muted" style="margin:4px 0 0;font-size:12px">' + esc(nt.item.highway || '') + '</p>' +
      '<div class="fz-flex fz-mt"><span class="fz-badge fz-info"><i class="fa-solid fa-road"></i> ' + (nt.km < 10 ? nt.km.toFixed(1) : Math.round(nt.km)) + ' km</span>' +
      '<button class="fz-btn fz-sm" onclick="Fusion.tolls.open()"><i class="fa-solid fa-calculator"></i> Calcular peaje</button></div>'
    ) : '<div class="fz-empty">Sin casetas con tarifa registradas cerca.</div>';

    var stops = safeStops().map(function (s) { return { s: s, km: dist({ lat: s.lat, lon: s.lon }, effective) }; })
      .filter(function (x) { return x.km != null; }).sort(function (a, b) { return a.km - b.km; }).slice(0, 4);
    byId('fz-trip-stops').innerHTML = stops.length ? stops.map(function (x) {
      return '<div class="fz-trip-alert" style="cursor:default"><span class="fz-ta-icon" style="background:#0E7490"><i class="fa-solid fa-mug-hot"></i></span>' +
        '<span class="fz-ta-copy"><b>' + esc(x.s.name) + '</b><span>' + esc(x.s.highway || '') + ' · ★ ' + (x.s.rating || '—') + '</span></span>' +
        '<span class="fz-ta-dist">' + (x.km < 10 ? x.km.toFixed(1) : Math.round(x.km)) + ' km</span></div>';
    }).join('') : '<div class="fz-empty">Sin paradas seguras cercanas.</div>';

    var snd = byId('fz-trip-sound');
    if (snd) snd.innerHTML = '<i class="fa-solid ' + (trip.sound ? 'fa-volume-high' : 'fa-volume-xmark') + '"></i> Aviso';
    var nbtn = byId('fz-trip-night');
    if (nbtn) nbtn.innerHTML = '<i class="fa-solid ' + (FZ._nightOn ? 'fa-moon' : 'fa-sun') + '"></i> Nocturno';

    // Aviso sonoro si entra una alerta crítica nueva
    var critIds = nearby.filter(function (x) { return sev(x.a) === 'critical' && x.km < 60; }).map(function (x) { return x.a.id; });
    if (trip.sound && critIds.length) {
      var seen = FZ._tripSeen || (FZ._tripSeen = {});
      var isNew = critIds.some(function (id) { return !seen[id]; });
      if (isNew) beep();
      critIds.forEach(function (id) { seen[id] = 1; });
    }
  }

  FZ.trip.openPush = function () { FZ.push.open(); };
  FZ.tripRefresh = renderTrip;

  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      FZ._ac = FZ._ac || new AC();
      var o = FZ._ac.createOscillator(), g = FZ._ac.createGain();
      o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(FZ._ac.destination);
      g.gain.setValueAtTime(0.0001, FZ._ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, FZ._ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, FZ._ac.currentTime + 0.5);
      o.start(); o.stop(FZ._ac.currentTime + 0.52);
    } catch (e) {}
  }

  /* =========================================================================
     6. CALCULADORA DE PEAJES
     ========================================================================= */
  var tollState = { vehicle: 'auto', fuel: 'regular', kmL: 12, mode: 'corridor', corridor: null, casetas: {} };

  FZ.tolls = {
    open: function () { openTollsPanel(); }
  };

  function openTollsPanel() {
    var body = ensureOverlay('fz-toll-ov', { title: 'Calculadora de Peajes', icon: 'fa-money-bill-wave', size: 'fz-w-lg' });
    var vl = vehicleLabels();
    body.innerHTML =
      '<div class="fz-grid3">' +
        '<div class="fz-field"><label>Vehículo</label><select id="fz-tv">' + Object.keys(vl).map(function (k) { return '<option value="' + k + '">' + esc(vl[k].name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="fz-field"><label>Combustible</label><select id="fz-tf">' + Object.keys(window.FUSION_FUEL_PRICES || {}).map(function (k) { return '<option value="' + k + '">' + esc(window.FUSION_FUEL_PRICES[k].name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="fz-field"><label>Rendimiento (km/L)</label><input id="fz-tk" type="number" min="1" max="40" value="12"></div>' +
      '</div>' +
      '<div class="fz-chips" id="fz-tmode" style="margin-bottom:12px">' +
        '<button class="fz-chip fz-on" data-mode="corridor">Corredor preestablecido</button>' +
        '<button class="fz-chip" data-mode="custom">Selección manual de casetas</button>' +
      '</div>' +
      '<div id="fz-tcorridor"><div class="fz-field"><label>Trayecto</label><select id="fz-tc"></select></div></div>' +
      '<div id="fz-tcustom" class="fz-hidden"><div class="fz-field"><label>Casetas en tu ruta</label><div id="fz-tclist" style="max-height:210px;overflow:auto;border:1px solid var(--border);border-radius:10px"></div></div></div>' +
      '<div id="fz-tresult" class="fz-mt"></div>';

    byId('fz-tv').value = tollState.vehicle;
    byId('fz-tf').value = tollState.fuel;
    byId('fz-tk').value = tollState.kmL;

    var csel = byId('fz-tc');
    csel.innerHTML = '<option value="">— Elige un trayecto —</option>' + corridors().map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    csel.onchange = function () { tollState.corridor = csel.value; renderTolls(); };

    var clist = byId('fz-tclist');
    clist.innerHTML = tolls().map(function (t) {
      return '<label class="fz-switch" style="border:0;border-bottom:1px solid var(--border);border-radius:0"><input type="checkbox" data-toll="' + t.id + '" style="width:auto;margin-left:0"><span style="min-width:0">' + esc(t.name) + '<br><small class="fz-muted">' + esc(t.highway || '') + ' · ' + esc(t.operator || '') + '</small></span></label>';
    }).join('');
    clist.addEventListener('change', function (e) {
      if (e.target.dataset.toll) { tollState.casetas[e.target.dataset.toll] = e.target.checked; renderTolls(); }
    });

    $$('#fz-tmode .fz-chip').forEach(function (b) {
      b.onclick = function () {
        tollState.mode = b.dataset.mode;
        $$('#fz-tmode .fz-chip').forEach(function (x) { x.classList.toggle('fz-on', x === b); });
        byId('fz-tcorridor').classList.toggle('fz-hidden', tollState.mode !== 'corridor');
        byId('fz-tcustom').classList.toggle('fz-hidden', tollState.mode !== 'custom');
        renderTolls();
      };
    });
    ['fz-tv', 'fz-tf', 'fz-tk'].forEach(function (id) {
      byId(id).addEventListener('input', function () {
        tollState.vehicle = byId('fz-tv').value; tollState.fuel = byId('fz-tf').value;
        tollState.kmL = Number(byId('fz-tk').value) || 12; renderTolls();
      });
    });

    showOverlay('fz-toll-ov');
    renderTolls();
  }

  function currentTollSelection() {
    if (tollState.mode === 'corridor') {
      var c = corridors().find(function (x) { return x.id === tollState.corridor; });
      if (!c) return { casetas: [], distanceKm: 0, freeKm: 0, extraMin: 0, name: '—', valid: false };
      return {
        casetas: c.tollIds.map(function (id) { return tolls().find(function (t) { return t.id === id; }); }).filter(Boolean),
        distanceKm: c.distanceKm, freeKm: c.freeRouteKm, extraMin: c.freeRouteMinutesExtra, name: c.name, valid: true
      };
    }
    return {
      casetas: tolls().filter(function (t) { return tollState.casetas[t.id]; }),
      distanceKm: 0, freeKm: 0, extraMin: 0, name: 'Selección manual', valid: true
    };
  }

  function renderTolls() {
    var box = byId('fz-tresult'); if (!box) return;
    var sel = currentTollSelection();
    var vl = vehicleLabels()[tollState.vehicle] || { name: tollState.vehicle };
    var price = function (t) { return (t.prices && t.prices[tollState.vehicle]) || 0; };
    var total = sel.casetas.reduce(function (s, t) { return s + price(t); }, 0);
    var fuelPrice = (window.FUSION_FUEL_PRICES[tollState.fuel] || { price: 24 }).price;
    var fuelCost = sel.distanceKm ? (sel.distanceKm / (tollState.kmL || 12)) * fuelPrice : 0;
    var grand = total + fuelCost;

    box.innerHTML =
      '<div class="fz-stats">' +
        '<div class="fz-stat"><b>' + money(total) + '</b><span>Peajes</span></div>' +
        '<div class="fz-stat"><b>' + (sel.distanceKm ? money(fuelCost) : '—') + '</b><span>Combustible</span></div>' +
        '<div class="fz-stat"><b>' + money(grand) + '</b><span>Costo total</span></div>' +
        '<div class="fz-stat"><b>' + sel.casetas.length + '</b><span>Casetas</span></div>' +
      '</div>' +
      (sel.casetas.length ? '<div class="fz-mt"><table class="fz-table"><thead><tr><th>Caseta</th><th>Operador</th><th style="text-align:right">Tarifa (' + esc(vl.name) + ')</th></tr></thead><tbody>' +
        sel.casetas.map(function (t) { return '<tr><td>' + esc(t.name) + '<br><small class="fz-muted">' + esc(t.highway || '') + '</small></td><td>' + esc(t.operator || '—') + '</td><td style="text-align:right">' + money(price(t)) + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : '<div class="fz-empty">Selecciona un trayecto o casetas para calcular.</div>') +
      (sel.distanceKm ? '<div class="fz-sep"></div><div class="fz-flex">' +
        '<span class="fz-badge fz-info"><i class="fa-solid fa-road"></i> Cuota: ' + sel.distanceKm + ' km</span>' +
        '<span class="fz-badge fz-medium"><i class="fa-solid fa-road"></i> Libre: ' + sel.freeKm + ' km (+' + sel.extraMin + ' min)</span>' +
        '<span class="fz-badge ' + (sel.extraMin > 0 ? 'fz-ok' : 'fz-info') + '"><i class="fa-solid fa-clock"></i> Ahorras ' + sel.extraMin + ' min</span>' +
      '</div><p class="fz-muted" style="font-size:12px;margin-top:8px">En ' + esc(sel.name) + ': por ' + money(total) + ' ahorras ~' + sel.extraMin + ' min y ' + (sel.freeKm - sel.distanceKm) + ' km. Tarifas orientativas (CAPUFE/operadores); pueden variar. El Tag/IAVE suele agilizar el cruce.</p>' : '') +
      '<div class="fz-flex fz-mt"><button class="fz-btn" onclick="Fusion.trip.open()"><i class="fa-solid fa-car-on"></i> Ver en Modo Viaje</button>' +
      '<button class="fz-btn fz-ghost" onclick="Fusion.exportTollsCsv()"><i class="fa-solid fa-file-csv"></i> Exportar CSV</button></div>';
  }

  FZ.exportTollsCsv = function () {
    var sel = currentTollSelection();
    if (!sel.casetas.length) { toast('Nada que exportar', 'warn'); return; }
    var vl = vehicleLabels()[tollState.vehicle] || { name: tollState.vehicle };
    var rows = [['Caseta', 'Carretera', 'Operador', 'Tarifa (' + vl.name + ')']];
    sel.casetas.forEach(function (t) { rows.push([t.name, t.highway || '', t.operator || '', (t.prices && t.prices[tollState.vehicle]) || 0]); });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zero-vial-peajes.csv'; a.click();
  };

  /* =========================================================================
     7. ANALÍTICA DE ZONAS DE SEGURIDAD
     ========================================================================= */
  var SEC_DAYS = { '1m': 30, '3m': 90, '6m': 180, '12m': 365, 'all': 100000 };
  var secState = { win: '3m', tab: 'zonas', state: '', q: '' };

  FZ.security = { open: function () { openSecurityPanel(); }, openHistory: function () { secState.tab = 'historico'; openSecurityPanel(); } };

  function secFiltered() {
    var days = SEC_DAYS[secState.win] || 90, now = Date.now();
    return allAlerts().filter(function (a) {
      var t = new Date(a.time).getTime();
      if (isFinite(t) && now - t > days * 86400000) return false;
      if (secState.state && (a.state || '') !== secState.state) return false;
      if (secState.q) {
        var hay = ((a.title || '') + ' ' + (a.location || '') + ' ' + (a.state || '') + ' ' + refOf(a)).toLowerCase();
        if (hay.indexOf(secState.q.toLowerCase()) < 0) return false;
      }
      return true;
    });
  }

  function openSecurityPanel() {
    var body = ensureOverlay('fz-sec-ov', { title: 'Analítica de Seguridad Vial', icon: 'fa-shield-halved', size: 'fz-w-lg' });
    body.innerHTML =
      '<div class="fz-flex" style="margin-bottom:12px">' +
        '<div class="fz-chips" id="fz-sec-win">' +
          [['1m', '1 mes'], ['3m', '3 meses'], ['6m', '6 meses'], ['12m', '12 meses'], ['all', 'Todo']].map(function (w) { return '<button class="fz-chip" data-win="' + w[0] + '">' + w[1] + '</button>'; }).join('') +
        '</div>' +
        '<select id="fz-sec-state" class="fz-btn fz-sm" aria-label="Filtrar por estado" style="width:auto;margin-left:auto"></select>' +
        '<input id="fz-sec-q" type="search" aria-label="Buscar en seguridad" placeholder="Buscar…" style="width:180px;padding:7px 10px;border-radius:9px;border:1px solid var(--border);background:var(--input-bg);color:var(--text)">' +
      '</div>' +
      '<div class="fz-tabs" id="fz-sec-tabs">' +
        '<button class="fz-tab fz-on" data-tab="zonas"><i class="fa-solid fa-location-dot"></i> Zonas de seguridad</button>' +
        '<button class="fz-tab" data-tab="carreteras"><i class="fa-solid fa-road"></i> Carreteras y accidentes</button>' +
        '<button class="fz-tab" data-tab="matriz"><i class="fa-solid fa-table-cells"></i> Matriz de riesgo</button>' +
        '<button class="fz-tab" data-tab="historico"><i class="fa-solid fa-chart-line"></i> Análisis histórico</button>' +
      '</div>' +
      '<div id="fz-sec-content"></div>';

    var ss = byId('fz-sec-state');
    var states = Array.from(new Set(allAlerts().map(function (a) { return a.state; }).filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, 'es'); });
    ss.innerHTML = '<option value="">Todo México</option>' + states.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');

    $$('#fz-sec-win .fz-chip').forEach(function (b) {
      b.classList.toggle('fz-on', b.dataset.win === secState.win);
      b.onclick = function () { secState.win = b.dataset.win; $$('#fz-sec-win .fz-chip').forEach(function (x) { x.classList.toggle('fz-on', x === b); }); renderSecurity(); };
    });
    $$('#fz-sec-tabs .fz-tab').forEach(function (b) {
      b.classList.toggle('fz-on', b.dataset.tab === secState.tab);
      b.onclick = function () { secState.tab = b.dataset.tab; $$('#fz-sec-tabs .fz-tab').forEach(function (x) { x.classList.toggle('fz-on', x === b); }); renderSecurity(); };
    });
    ss.onchange = function () { secState.state = ss.value; renderSecurity(); };
    byId('fz-sec-q').addEventListener('input', function (e) { secState.q = e.target.value; renderSecurity(); });

    showOverlay('fz-sec-ov');
    renderSecurity();
  }

  function renderSecurity() {
    var box = byId('fz-sec-content'); if (!box) return;
    var list = secFiltered();
    var res = FZ.safetyScore(list, false);

    if (secState.tab === 'zonas') {
      var byState = groupCount(list, function (a) { return a.state || 'Sin estado'; }, function (a) { return SEV_RANK[sev(a)] || 1; });
      var byMuni = groupCount(list, function (a) { return a.municipality || a.municipio || 'Sin municipio'; }, function (a) { return SEV_RANK[sev(a)] || 1; });
      box.innerHTML =
        '<div class="fz-grid2">' +
          '<div><h4 style="margin:0 0 6px;font-size:13px">Índice de seguridad del filtro</h4><div id="fz-sec-ring">' + ringHTML(res, 168) + '</div><p class="fz-muted" style="font-size:12px;text-align:center">' + esc(res.recommendation) + '</p></div>' +
          '<div><h4 style="margin:0 0 6px;font-size:13px">Incidencias por estado</h4><div class="fz-canvas-wrap"><canvas id="fz-sec-canvas"></canvas></div></div>' +
        '</div>' +
        '<div class="fz-sep"></div>' +
        '<div class="fz-grid2"><div><h4 style="margin:0 0 6px;font-size:13px">Ranking por estado</h4>' + rankingHTML(byState.slice(0, 8)) + '</div>' +
        '<div><h4 style="margin:0 0 6px;font-size:13px">Municipios con más incidencias</h4>' + rankingHTML(byMuni.slice(0, 8)) + '</div></div>';

      var ax = themeAxis();
      chart('fz-sec-canvas', {
        type: 'bar',
        data: { labels: byState.slice(0, 10).map(function (r) { return r.key; }), datasets: [{ label: 'Incidencias', data: byState.slice(0, 10).map(function (r) { return r.count; }), backgroundColor: '#2563EB', borderRadius: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: ax.text, font: { size: 9 } }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: ax.text, precision: 0 }, grid: { color: ax.grid } } } }
      });
    } else if (secState.tab === 'carreteras') {
      var byRoad = groupCount(list, function (a) { return refOf(a).replace(/\s*\d{2,3}\+?\d*\s*$/,'').trim() || refOf(a); }, function (a) { return SEV_RANK[sev(a)] || 1; });
      var accidentes = list.filter(function (a) { return /volcadura|choque|accidente|colisi/i.test((a.title || '') + ' ' + (a.detail || '')); }).length;
      var seg = list.filter(function (a) { return a.category === 'security'; }).length;
      var bloq = list.filter(isBlockage).length;
      var otros = Math.max(0, list.length - accidentes - seg - bloq);
      box.innerHTML =
        '<div class="fz-stats" style="margin-bottom:12px">' +
          '<div class="fz-stat"><b>' + list.length + '</b><span>Total</span></div>' +
          '<div class="fz-stat"><b style="color:#EA580C">' + accidentes + '</b><span>Accidentes</span></div>' +
          '<div class="fz-stat"><b style="color:#DC2626">' + seg + '</b><span>Seguridad</span></div>' +
          '<div class="fz-stat"><b style="color:#F59E0B">' + bloq + '</b><span>Bloqueos</span></div>' +
        '</div>' +
        '<div class="fz-grid2">' +
          '<div><h4 style="margin:0 0 6px;font-size:13px">Corredores / carreteras con más incidentes</h4>' + rankingHTML(byRoad.slice(0, 10)) + '</div>' +
          '<div><h4 style="margin:0 0 6px;font-size:13px">Distribución por tipo</h4><div class="fz-canvas-wrap"><canvas id="fz-sec-canvas"></canvas></div></div>' +
        '</div>';
      var ax2 = themeAxis();
      chart('fz-sec-canvas', {
        type: 'doughnut',
        data: { labels: ['Accidentes', 'Seguridad', 'Bloqueos', 'Otros'], datasets: [{ data: [accidentes, seg, bloq, otros], backgroundColor: ['#EA580C', '#DC2626', '#F59E0B', '#64748B'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { color: ax2.text, font: { size: 10 }, boxWidth: 10 } } } }
      });
    } else if (secState.tab === 'historico') {
      renderHistorySec(box, list);
    } else {
      // Matriz de riesgo hora × día
      var days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
      var grid = Array.from({ length: 7 }, function () { return new Array(24).fill(0); });
      list.forEach(function (a) {
        var d = new Date(a.time); if (!isFinite(d.getTime())) return;
        grid[d.getDay()][d.getHours()]++;
      });
      var max = Math.max(1, Math.max.apply(null, grid.map(function (r) { return Math.max.apply(null, r); })));
      var html = '<div class="fz-heat"><table><thead><tr><th></th>' + Array.from({ length: 24 }, function (_, h) { return '<th style="color:var(--text-muted);font-weight:600">' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
      grid.forEach(function (row, i) {
        html += '<tr><td class="fz-h-label">' + days[i] + '</td>';
        row.forEach(function (v) {
          var t = v / max;
          var bg = v === 0 ? 'var(--input-bg)' : 'rgba(' + Math.round(37 + t * 200) + ',' + Math.round(99 - t * 60) + ',' + Math.round(235 - t * 200) + ',' + (0.35 + t * 0.55) + ')';
          html += '<td style="background:' + bg + ';color:' + (t > 0.6 ? '#fff' : 'var(--text-muted)') + '" title="' + v + ' incidencias">' + (v || '') + '</td>';
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      box.innerHTML = '<h4 style="margin:0 0 4px;font-size:13px">Matriz de riesgo por día y hora</h4><p class="fz-muted" style="font-size:12px;margin:0 0 10px">Intensidad de incidencias según el momento del día. Útil para planear horarios de viaje.</p>' + html +
        '<div class="fz-sep"></div><div class="fz-flex"><span class="fz-badge fz-info">Máximo: ' + max + ' en una franja</span><span class="fz-badge fz-ok">' + res.label + ' · índice ' + res.score + '</span>' +
        '<button class="fz-btn fz-sm" onclick="Fusion.security.exportCsv()"><i class="fa-solid fa-file-csv"></i> Exportar datos</button></div>';
    }
  }

  function groupCount(list, keyFn, weightFn) {
    var map = {};
    list.forEach(function (a) {
      var k = keyFn(a) || 'Sin identificar';
      if (!map[k]) map[k] = { key: k, count: 0, weight: 0 };
      map[k].count++;
      map[k].weight += weightFn ? weightFn(a) : 1;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.count - a.count; });
  }
  function rankingHTML(rows) {
    if (!rows.length) return '<div class="fz-empty">Sin datos.</div>';
    var max = Math.max.apply(null, rows.map(function (r) { return r.count; })) || 1;
    return rows.map(function (r) {
      var risk = r.weight / Math.max(1, r.count);
      var color = risk >= 2.4 ? '#EF4444' : risk >= 1.8 ? '#F97316' : '#F59E0B';
      return '<div class="fz-bar-row"><b>' + esc(r.key) + '</b><span style="color:' + color + '">' + r.count + '</span><span class="fz-bar"><i style="width:' + Math.max(6, r.count / max * 100) + '%"></i></span></div>';
    }).join('');
  }

  FZ.security.exportCsv = function () {
    var list = secFiltered();
    var rows = [['Fecha', 'Título', 'Categoría', 'Severidad', 'Estado', 'Ubicación', 'Referencia']];
    list.forEach(function (a) { rows.push([fmtDate(a.time), a.title || '', a.category || '', sev(a), a.state || '', a.location || '', refOf(a)]); });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zero-vial-seguridad.csv'; a.click();
  };

  /* =========================================================================
     8. REPORTE MENSUAL EN PDF (jsPDF + autotable)
     ========================================================================= */
  var MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  FZ.report = { open: function () { openReportPanel(); } };

  function openReportPanel() {
    var now = new Date();
    var body = ensureOverlay('fz-rep-ov', { title: 'Reporte Mensual de Seguridad', icon: 'fa-file-pdf', size: 'fz-w-sm' });
    body.innerHTML =
      '<div class="fz-grid2">' +
        '<div class="fz-field"><label>Mes</label><select id="fz-rep-m">' + MONTHS.map(function (m, i) { return '<option value="' + (i + 1) + '"' + (i === now.getMonth() ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div>' +
        '<div class="fz-field"><label>Año</label><input id="fz-rep-y" type="number" min="2020" max="2100" value="' + now.getFullYear() + '"></div>' +
      '</div>' +
      '<div class="fz-grid2">' +
        '<div class="fz-field"><label>Ventana</label><select id="fz-rep-t"><option value="1">Mes seleccionado</option><option value="3">Trimestre (3 meses)</option></select></div>' +
        '<div class="fz-field"><label>Estado / Zona</label><select id="fz-rep-z"><option value="">Todo México</option></select></div>' +
      '</div>' +
      '<div class="fz-field"><label>Preparado para</label><input id="fz-rep-p" type="text" placeholder="Nombre o empresa (opcional)"></div>' +
      '<label class="fz-switch"><span><i class="fa-solid fa-list"></i> Incluir listado detallado de alertas</span><input id="fz-rep-list" type="checkbox" checked></label>' +
      '<div class="fz-sep"></div>' +
      '<div class="fz-flex"><button class="fz-btn fz-primary" id="fz-rep-go"><i class="fa-solid fa-file-pdf"></i> Generar PDF</button>' +
      '<button class="fz-btn" onclick="Fusion.report.openPrint()"><i class="fa-solid fa-print"></i> Imprimir</button>' +
      '<span id="fz-rep-note" class="fz-muted" style="font-size:11px"></span></div>';

    var zs = Array.from(new Set(allAlerts().map(function (a) { return a.state; }).filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, 'es'); });
    byId('fz-rep-z').innerHTML = '<option value="">Todo México</option>' + zs.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
    byId('fz-rep-go').onclick = generateReport;
    showOverlay('fz-rep-ov');
    updateRepNote();
    byId('fz-rep-t').onchange = updateRepNote;
    byId('fz-rep-m').onchange = updateRepNote;
    byId('fz-rep-y').onchange = updateRepNote;
  }
  function reportRange() {
    var m = +byId('fz-rep-m').value, y = +byId('fz-rep-y').value, t = +byId('fz-rep-t').value;
    var end = new Date(y, m - 1 + 1, 0, 23, 59, 59);
    var start = new Date(y, m - t, 1, 0, 0, 0);
    return { start: start, end: end, months: t };
  }
  function reportAlerts() {
    var r = reportRange(), z = byId('fz-rep-z').value;
    return allAlerts().filter(function (a) {
      var t = new Date(a.time).getTime(); if (!isFinite(t)) return false;
      if (t < r.start.getTime() || t > r.end.getTime()) return false;
      if (z && (a.state || '') !== z) return false;
      return true;
    });
  }
  function updateRepNote() {
    var r = reportRange();
    byId('fz-rep-note').textContent = reportAlerts().length + ' alertas · ' + r.start.toLocaleDateString('es-MX') + ' – ' + r.end.toLocaleDateString('es-MX');
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  function ensurePdfLib() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    return loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
      .then(function () { return loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'); })
      .then(function () { return window.jspdf && window.jspdf.jsPDF; });
  }

  function generateReport() {
    var list = reportAlerts();
    var r = reportRange();
    var note = byId('fz-rep-note'); if (note) note.textContent = 'Preparando PDF…';
    ensurePdfLib().then(function (jsPDF) {
      if (!jsPDF) throw new Error('sin jsPDF');
      buildPdf(jsPDF, list, r);
      if (note) note.textContent = 'PDF generado.';
    }).catch(function () {
      toast('No se pudo cargar el generador de PDF; se abrirá la versión imprimible.', 'warn');
      FZ.report.openPrint();
    });
  }

  function buildPdf(jsPDF, list, r) {
    var doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    var W = doc.internal.pageSize.getWidth();
    var preparedFor = byId('fz-rep-p') ? byId('fz-rep-p').value.trim() : '';
    var zone = byId('fz-rep-z').value || 'Todo México';
    var period = r.start.toLocaleDateString('es-MX') + ' – ' + r.end.toLocaleDateString('es-MX');
    var res = FZ.safetyScore(list, false);
    var count = function (fn) { return list.filter(fn).length; };
    var crit = count(function (a) { return sev(a) === 'critical'; });
    var high = count(function (a) { return sev(a) === 'high'; });
    var acc = count(function (a) { return /volcadura|choque|accidente|colisi/i.test((a.title || '') + ' ' + (a.detail || '')); });
    var seg = count(function (a) { return a.category === 'security'; });
    var bloq = count(isBlockage);

    // Encabezado
    doc.setFillColor(5, 7, 10); doc.rect(0, 0, W, 34, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(18); doc.setFont(undefined, 'bold');
    doc.text('ZERO VIAL', 14, 15);
    doc.setFontSize(10); doc.setFont(undefined, 'normal'); doc.setTextColor(160, 200, 255);
    doc.text('Reporte mensual de seguridad vial', 14, 22);
    doc.setTextColor(200, 200, 200); doc.setFontSize(8.5);
    doc.text('Periodo: ' + period + '   ·   Zona: ' + zone, 14, 29);
    if (preparedFor) doc.text('Preparado para: ' + preparedFor, W - 14, 29, { align: 'right' });

    // Índice + resumen
    var y = 44;
    doc.setTextColor(20, 20, 20); doc.setFontSize(13); doc.setFont(undefined, 'bold');
    doc.text('Índice de seguridad: ' + res.score + '/100 · ' + res.label, 14, y); y += 8;
    doc.setFontSize(10); doc.setFont(undefined, 'normal');
    doc.text(res.recommendation, 14, y, { maxWidth: W - 28 }); y += 12;

    var summary = [
      ['Total de incidentes', String(list.length)],
      ['Alertas críticas', String(crit)],
      ['Riesgo alto', String(high)],
      ['Accidentes', String(acc)],
      ['Incidentes de seguridad', String(seg)],
      ['Bloqueos', String(bloq)]
    ];
    if (doc.autoTable) {
      doc.autoTable({ startY: y, head: [['Indicador', 'Valor']], body: summary, theme: 'grid', styles: { fontSize: 9 }, headStyles: { fillColor: [37, 99, 235] }, margin: { left: 14, right: 14 } });
      y = doc.lastAutoTable.finalY + 8;
    } else { summary.forEach(function (row) { doc.text(row[0] + ': ' + row[1], 14, y); y += 6; }); y += 4; }

    // Ranking estados
    var byState = groupCount(list, function (a) { return a.state || 'Sin estado'; });
    if (doc.autoTable && byState.length) {
      doc.setFontSize(12); doc.setFont(undefined, 'bold'); doc.text('Estados con más incidencias', 14, y); y += 4;
      doc.autoTable({ startY: y, head: [['Estado', 'Incidencias']], body: byState.slice(0, 10).map(function (x) { return [x.key, String(x.count)]; }), theme: 'striped', styles: { fontSize: 9 }, headStyles: { fillColor: [30, 41, 59] }, margin: { left: 14, right: 14 } });
      y = doc.lastAutoTable.finalY + 8;
    }

    // Listado detallado
    if (byId('fz-rep-list').checked && list.length) {
      var rows = list.slice(0, 400).sort(function (a, b) { return new Date(b.time) - new Date(a.time); }).map(function (a) {
        return [fmtDate(a.time), sev(a), a.category === 'security' ? 'Seguridad' : 'Vial', (a.title || '').slice(0, 60), (a.state || ''), (a.location || '').slice(0, 40)];
      });
      if (doc.autoTable) {
        doc.addPage(); doc.setFontSize(13); doc.setFont(undefined, 'bold'); doc.text('Listado detallado de alertas', 14, 18);
        doc.autoTable({ startY: 24, head: [['Fecha', 'Sev.', 'Tipo', 'Título', 'Estado', 'Ubicación']], body: rows, theme: 'grid', styles: { fontSize: 7.5, cellPadding: 1.5 }, headStyles: { fillColor: [37, 99, 235] }, margin: { left: 14, right: 14 } });
      }
    }

    // Pie
    var pages = doc.internal.getNumberOfPages();
    for (var i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(130, 130, 130);
      doc.text('Zero Vial · zero-vial.com.mx · Documento informativo, no oficial. Generado ' + new Date().toLocaleString('es-MX'), 14, doc.internal.pageSize.getHeight() - 8);
      doc.text('Pág. ' + i + '/' + pages, W - 14, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
    }
    doc.save('Zero-Vial-Reporte-' + r.start.getFullYear() + '-' + pad(r.start.getMonth() + 1) + '.pdf');
  }

  FZ.report.openPrint = function () {
    var list = reportAlerts(), r = reportRange(), res = FZ.safetyScore(list, false);
    var zone = byId('fz-rep-z').value || 'Todo México';
    var preparedFor = byId('fz-rep-p') ? byId('fz-rep-p').value.trim() : '';
    var w = window.open('', '_blank'); if (!w) { toast('Permite ventanas emergentes para imprimir', 'warn'); return; }
    var rows = list.slice(0, 300).map(function (a) { return '<tr><td>' + esc(fmtDate(a.time)) + '</td><td>' + esc(sev(a)) + '</td><td>' + esc(a.title || '') + '</td><td>' + esc(a.state || '') + '</td><td>' + esc(a.location || '') + '</td></tr>'; }).join('');
    w.document.write('<html lang="es"><head><meta charset="utf-8"><title>Zero Vial · Reporte</title><style>body{font-family:Arial,Helvetica,sans-serif;margin:28px;color:#111}h1{margin:0}small{color:#666}table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px}th,td{border:1px solid #ccc;padding:5px;text-align:left}th{background:#eef2ff}.kpi{display:flex;gap:16px;margin:14px 0}.kpi div{border:1px solid #ddd;border-radius:8px;padding:8px 12px}.kpi b{font-size:20px;display:block}</style></head><body>' +
      '<h1>ZERO VIAL</h1><small>Reporte de seguridad vial · ' + esc(r.start.toLocaleDateString('es-MX')) + ' – ' + esc(r.end.toLocaleDateString('es-MX')) + ' · ' + esc(zone) + (preparedFor ? ' · Para: ' + esc(preparedFor) : '') + '</small>' +
      '<div class="kpi"><div><b>' + res.score + '/100</b>Índice (' + esc(res.label) + ')</div><div><b>' + list.length + '</b>Incidentes</div><div><b>' + list.filter(function (a) { return sev(a) === 'critical'; }).length + '</b>Críticas</div><div><b>' + list.filter(function (a) { return a.category === 'security'; }).length + '</b>Seguridad</div></div>' +
      '<p>' + esc(res.recommendation) + '</p>' +
      '<table><thead><tr><th>Fecha</th><th>Severidad</th><th>Título</th><th>Estado</th><th>Ubicación</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p><small>Documento informativo, no oficial · Generado ' + esc(new Date().toLocaleString('es-MX')) + '</small></p>' +
      '<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>');
    w.document.close();
  };

  /* =========================================================================
     9. PUSH POR ZONA / RUTA
     ========================================================================= */
  var push = Object.assign({
    enabled: false, minSeverity: 'high', radiusKm: 60, useLocation: true, followRoute: true,
    categories: { road: true, security: true }, maxAgeMin: 360
  }, load(CFG.pushKey, {}));
  push.notified = load(CFG.pushSeenKey, {});
  var pushLog = load(CFG.pushLogKey, []);

  FZ.push = {
    open: function () { openPushPanel(); },
    request: function () { requestPushPermission(); },
    test: function () { dispatchPush({ title: 'Zero Vial', body: 'Las notificaciones funcionan correctamente.', test: true }); },
    clearLog: function () { pushLog = []; save(CFG.pushLogKey, pushLog); push.notified = {}; save(CFG.pushSeenKey, {}); openPushPanel(); },
    scan: function () { scanPush(true); },
    dismissToast: function () { var t = byId('fz-push-toast'); if (t) t.classList.remove('fz-open'); }
  };

  function permissionState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }
  function requestPushPermission() {
    if (!('Notification' in window)) { toast('Este navegador no soporta notificaciones', 'warn'); return; }
    Notification.requestPermission().then(function (p) {
      toast(p === 'granted' ? 'Notificaciones activadas' : 'Permiso: ' + p, p === 'granted' ? 'ok' : 'warn');
      openPushPanel();
    });
  }

  function openPushPanel() {
    var body = ensureOverlay('fz-push-ov', { title: 'Alertas Push por Zona y Ruta', icon: 'fa-bell', size: 'fz-w-sm' });
    var perm = permissionState();
    var permBadge = perm === 'granted' ? '<span class="fz-badge fz-ok"><i class="fa-solid fa-check"></i> Permiso concedido</span>'
      : perm === 'denied' ? '<span class="fz-badge fz-critical"><i class="fa-solid fa-ban"></i> Permiso bloqueado</span>'
      : perm === 'unsupported' ? '<span class="fz-badge fz-medium"><i class="fa-solid fa-triangle-exclamation"></i> No soportado</span>'
      : '<span class="fz-badge fz-info"><i class="fa-solid fa-question"></i> Sin permiso</span>';

    var pos = myPos();
    body.innerHTML =
      '<div class="fz-flex" style="margin-bottom:12px">' + permBadge +
        (perm !== 'granted' && perm !== 'unsupported' ? '<button class="fz-btn fz-sm fz-primary" onclick="Fusion.push.request()"><i class="fa-solid fa-bell"></i> Activar permiso</button>' : '') +
        '<button class="fz-btn fz-sm" onclick="Fusion.push.test()"><i class="fa-solid fa-vial"></i> Notificación de prueba</button>' +
        '<button class="fz-btn fz-sm" onclick="Fusion.push.scan()"><i class="fa-solid fa-magnifying-glass"></i> Escanear ahora</button>' +
      '</div>' +
      '<label class="fz-switch"><span><i class="fa-solid fa-power-off"></i> Motor de alertas activado</span><input id="fz-push-on" type="checkbox" ' + (push.enabled ? 'checked' : '') + '></label>' +
      '<div class="fz-grid2 fz-mt">' +
        '<div class="fz-field"><label>Severidad mínima</label><select id="fz-push-sev">' +
          [['critical', 'Solo críticas'], ['high', 'Alta o superior'], ['medium', 'Media o superior (todo)']].map(function (o) { return '<option value="' + o[0] + '"' + (push.minSeverity === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="fz-field"><label>Radio de influencia (km)</label><input id="fz-push-rad" type="number" min="5" max="300" value="' + push.radiusKm + '"></div>' +
      '</div>' +
      '<div class="fz-field"><label>Categorías</label><div class="fz-chips" id="fz-push-cats">' +
        '<button class="fz-chip" data-cat="security">Seguridad</button><button class="fz-chip" data-cat="road">Viales</button>' +
      '</div></div>' +
      '<label class="fz-switch"><span><i class="fa-solid fa-location-crosshairs"></i> Filtrar por mi ubicación actual</span><input id="fz-push-loc" type="checkbox" ' + (push.useLocation ? 'checked' : '') + ' ' + (pos ? '' : '') + '></label>' +
      '<div class="fz-muted" style="font-size:11px;margin:5px 0 9px">' + (pos ? 'Ubicación detectada. ' : 'Sin GPS: se usará el centro de México hasta activar ubicación. ') + '</div>' +
      '<label class="fz-switch"><span><i class="fa-solid fa-route"></i> Filtrar por ruta planificada</span><input id="fz-push-route" type="checkbox" ' + (push.followRoute ? 'checked' : '') + '></label>' +
      '<div class="fz-sep"></div>' +
      '<div class="fz-flex"><button class="fz-btn fz-primary" id="fz-push-save"><i class="fa-solid fa-floppy-disk"></i> Guardar preferencias</button>' +
      '<button class="fz-btn fz-danger" onclick="Fusion.push.clearLog()"><i class="fa-solid fa-trash"></i> Borrar historial</button>' +
      '<button class="fz-btn" onclick="Fusion.trip.open()"><i class="fa-solid fa-car-on"></i> Modo Viaje</button></div>' +
      '<div class="fz-sep"></div><h4 style="margin:0 0 6px;font-size:13px">Historial de avisos (' + pushLog.length + ')</h4>' +
      '<div class="fz-log" id="fz-push-log">' + pushLog.slice(0, 40).map(function (l) {
        return '<div class="fz-log-item"><span class="fz-li-dot" style="background:' + (l.color || '#2563EB') + '"></span><span><b>' + esc(l.title || '') + '</b><br><small class="fz-muted">' + esc(l.body || '') + ' · ' + fmtDate(l.at) + '</small></span></div>';
      }).join('') + (pushLog.length ? '' : '<div class="fz-empty">Sin avisos registrados.</div>') + '</div>';

    $$('#fz-push-cats .fz-chip').forEach(function (b) {
      b.classList.toggle('fz-on', !!push.categories[b.dataset.cat]);
      b.onclick = function () { push.categories[b.dataset.cat] = !push.categories[b.dataset.cat]; b.classList.toggle('fz-on', push.categories[b.dataset.cat]); };
    });
    byId('fz-push-save').onclick = function () {
      push.enabled = byId('fz-push-on').checked;
      push.minSeverity = byId('fz-push-sev').value;
      push.radiusKm = Number(byId('fz-push-rad').value) || 60;
      push.useLocation = byId('fz-push-loc').checked;
      push.followRoute = byId('fz-push-route').checked;
      save(CFG.pushKey, { enabled: push.enabled, minSeverity: push.minSeverity, radiusKm: push.radiusKm, useLocation: push.useLocation, followRoute: push.followRoute, categories: push.categories, maxAgeMin: push.maxAgeMin });
      if (push.enabled && permissionState() === 'default') requestPushPermission();
      toast('Preferencias de push guardadas', 'ok');
      closeM('fz-push-ov');
    };
    showOverlay('fz-push-ov');
  }

  function routeAlerts() {
    try { return Array.isArray(routeNearAlerts) ? routeNearAlerts : []; } catch (e) { return []; }
  }
  function scanPush(manual) {
    if (!push.enabled && !manual) return;
    var now = Date.now();
    var pos = myPos() || { lat: 19.4326, lon: -99.1332 };
    var minRank = SEV_RANK[push.minSeverity] != null ? SEV_RANK[push.minSeverity] : 2;
    var routeIds = {};
    routeAlerts().forEach(function (a) { routeIds[a.id] = 1; });

    var candidates = allAlerts().filter(function (a) {
      if (!hasPoint(a) || isExpired(a)) return false;
      if (push.notified[a.id]) return false;
      var cat = a.category === 'security' ? 'security' : 'road';
      if (!push.categories[cat]) return false;
      if ((SEV_RANK[sev(a)] || 0) < minRank) return false;
      var t = new Date(a.time).getTime();
      if (isFinite(t) && now - t > push.maxAgeMin * 60000) return false;
      if (push.useLocation) {
        var d = dist(a, pos);
        if (d == null || d > push.radiusKm) return false;
      }
      if (push.followRoute && Object.keys(routeIds).length && !routeIds[a.id]) return false;
      return true;
    });

    candidates.slice(0, 5).forEach(function (a) {
      var v = vis(a);
      dispatchPush({ title: (v.label || 'Alerta') + ' · ' + (a.state || ''), body: (a.title || '') + ' — ' + (a.location || ''), color: v.color, alert: a });
      push.notified[a.id] = now;
    });
    if (candidates.length) { save(CFG.pushSeenKey, push.notified); }
    if (manual && !candidates.length) toast('No hay alertas nuevas que cumplan tus criterios', 'info');
  }

  function dispatchPush(payload) {
    payload.at = payload.at || Date.now();
    pushLog.unshift(payload);
    pushLog = pushLog.slice(0, 100);
    save(CFG.pushLogKey, pushLog);

    var canNotify = ('Notification' in window) && Notification.permission === 'granted';
    if (canNotify && (document.hidden || payload.test)) {
      try {
        new Notification(payload.title, { body: payload.body, icon: '/favicon-256.png', badge: '/favicon-256.png', tag: payload.alert ? 'zv-' + payload.alert.id : undefined });
      } catch (e) { showPushToast(payload); }
    } else {
      showPushToast(payload);
    }
  }
  function showPushToast(p) {
    var t = byId('fz-push-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'fz-push-toast';
      document.body.appendChild(t);
    }
    t.className = 'fz-push-toast';
    t.innerHTML =
      '<div class="fz-pt-head"><i class="fa-solid fa-bell" style="color:#22d3ee"></i> Alerta por zona' + (p.test ? ' · prueba' : '') + '</div>' +
      '<div class="fz-pt-body"><b>' + esc(p.title || '') + '</b><p>' + esc(p.body || '') + '</p></div>' +
      '<div class="fz-pt-foot">' +
        (p.alert ? '<button class="fz-btn fz-sm fz-primary" onclick="Fusion.push.openAlert(\'' + esc(String(p.alert.id)) + '\')"><i class="fa-solid fa-eye"></i> Ver en mapa</button>' : '') +
        '<button class="fz-btn fz-sm" onclick="Fusion.push.dismissToast()">Cerrar</button>' +
      '</div>';
    if (push.sound !== false) beep();
    requestAnimationFrame(function () { t.classList.add('fz-open'); });
    clearTimeout(FZ._toastTimer);
    FZ._toastTimer = setTimeout(function () { t.classList.remove('fz-open'); }, 12000);
  }
  FZ.push.openAlert = function (id) {
    byId('fz-push-toast') && byId('fz-push-toast').classList.remove('fz-open');
    var a = allAlerts().find(function (x) { return String(x.id) === String(id); });
    if (a && window.showAlertFocus) { try { window.showAlertFocus(a); } catch (e) {} }
    if (a && window.map && hasPoint(a)) window.map.setView([a.lat, a.lon], 14);
  };

  /* =========================================================================
     10. PLANIFICADOR DE RUTAS ENRIQUECIDO (costo de peaje + combustible)
     Adaptado de RoutePlanner de VíaSegura: cada alternativa muestra peajes,
     combustible y costo total estimados con el catálogo de casetas de fusión.
     ========================================================================= */
  FZ.routes = { open: function () { if (window.openRouteModal) window.openRouteModal(); } };

  function tollsNearRoute(coords, bufferKm) {
    var fn = window.distToPolylineKm;
    if (typeof fn !== 'function' || !coords || coords.length < 2) return [];
    var out = [];
    tolls().forEach(function (t) {
      if (!Number.isFinite(Number(t.lat)) || !Number.isFinite(Number(t.lon))) return;
      var d = null;
      try { d = fn(Number(t.lat), Number(t.lon), coords); } catch (e) { return; }
      if (d != null && d <= bufferKm) out.push({ toll: t, dist: d });
    });
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
  }

  // Casetas del mapa (catálogo nacional, sin tarifa) que la ruta cruza y que NO están en el
  // catálogo con tarifas. Sin esto, una ruta con casetas desconocidas mostraba "$0" como si fuera gratis
  // y podía salir marcada como la más económica. Se cuentan plazas, no cabinas (agrupadas a 3 km).
  function uncoveredPlazas(coords, priced) {
    var fn = window.distToPolylineKm, all = window.ZERO_VIAL_CASETAS || [];
    if (typeof fn !== 'function' || !coords || coords.length < 2 || !all.length) return 0;
    var minLa = 90, maxLa = -90, minLo = 180, maxLo = -180, i;
    for (i = 0; i < coords.length; i++) {
      var p = coords[i];
      if (p.lat < minLa) minLa = p.lat; if (p.lat > maxLa) maxLa = p.lat;
      if (p.lng < minLo) minLo = p.lng; if (p.lng > maxLo) maxLo = p.lng;
    }
    var pad = 0.03, found = [];
    all.forEach(function (c) {
      var la = Number(c.lat), lo = Number(c.lon);
      if (!isFinite(la) || !isFinite(lo)) return;
      if (la < minLa - pad || la > maxLa + pad || lo < minLo - pad || lo > maxLo + pad) return;   // prefiltro barato
      var d = null; try { d = fn(la, lo, coords); } catch (e) { return; }
      if (d == null || d > 1.5) return;
      for (var k = 0; k < priced.length; k++) {                                                     // ya cubierta por una con tarifa
        if (haversine(la, lo, Number(priced[k].toll.lat), Number(priced[k].toll.lon)) <= 3) return;
      }
      for (var j = 0; j < found.length; j++) { if (haversine(la, lo, found[j][0], found[j][1]) <= 3) return; }  // misma plaza
      found.push([la, lo]);
    });
    return found.length;
  }
  function haversine(a1, o1, a2, o2) {
    var R = 6371, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
    var x = Math.sin(dA / 2) * Math.sin(dA / 2) + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) * Math.sin(dO / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function routeCostEstimate(r) {
    var km = (r.distance || 0) / 1000;
    var near = tollsNearRoute(r.coord, 4);
    var tollSum = near.reduce(function (s, x) {
      var p = x.toll.prices || {};
      return s + (p[tollState.vehicle] != null ? p[tollState.vehicle] : (p.auto || 0));
    }, 0);
    var fp = (window.FUSION_FUEL_PRICES && window.FUSION_FUEL_PRICES[tollState.fuel]) ? window.FUSION_FUEL_PRICES[tollState.fuel].price : 24;
    var fuel = km / (tollState.kmL || 12) * fp;
    var unknown = 0; try { unknown = uncoveredPlazas(r.coord, near); } catch (e) { unknown = 0; }
    return { km: km, near: near, toll: tollSum, fuel: fuel, total: tollSum + fuel, unknown: unknown };
  }

  function installRouteEnricher() {
    if (typeof window.renderRouteCards !== 'function' || window.renderRouteCards.__fz) return;
    var orig = window.renderRouteCards;
    var wrapped = function () {
      var out = orig.apply(this, arguments);
      try { enrichRouteCards(); } catch (e) {}
      return out;
    };
    wrapped.__fz = true;
    window.renderRouteCards = wrapped;
  }

  function enrichRouteCards() {
    var cards = byId('route-cards'); if (!cards) return;
    var opts = [];
    try { opts = routeOptions || []; } catch (e) { opts = []; }
    if (!opts.length) return;
    var costs = opts.map(routeCostEstimate);

    $$('.rm-card', cards).forEach(function (card, i) {
      var rr = opts[i]; if (!rr) return;
      card.querySelectorAll('.fz-route-cost').forEach(function (n) { n.remove(); });
      var c = costs[i];
      var row = document.createElement('div');
      row.className = 'rm-cols fz-route-cost';
      row.innerHTML =
        '<div class="rm-col"><b>' + (c.unknown ? '≥ ' : '') + money(c.toll) + '</b><span>Peajes (' + c.near.length + ')</span></div>' +
        '<div class="rm-col"><b>' + money(c.fuel) + '</b><span>Combustible</span></div>' +
        '<div class="rm-col"><b style="color:#22d3ee">' + (c.unknown ? '≥ ' : '') + money(c.total) + '</b><span>Costo total' + (c.unknown ? ' mínimo' : '') + '</span></div>' +
        (c.unknown ? '<div class="fz-route-warn" role="note"><i class="fa-solid fa-triangle-exclamation"></i> Cruza ' + c.unknown + (c.unknown === 1 ? ' caseta' : ' casetas') + ' sin tarifa en nuestro catálogo: el costo real puede ser mayor.</div>' : '');
      var src = card.querySelector('.alert-source');
      if (src) card.insertBefore(row, src); else card.appendChild(row);
    });

    var best = 0;
    // Gana el menor costo; en empate (al peso) gana la ruta SIN casetas de tarifa desconocida.
    costs.forEach(function (c, i) {
      var t = Math.round(c.total), bt = Math.round(costs[best].total);
      if (t < bt || (t === bt && c.unknown < costs[best].unknown)) best = i;
    });
    var summary = document.createElement('div');
    summary.className = 'fz-route-summary';
    // Solo es incierta si la ganadora cruza casetas sin tarifa (si no, ninguna otra puede salir más barata).
    var anyUnknown = costs[best].unknown > 0;
    summary.innerHTML = '<i class="fa-solid fa-sack-dollar" style="color:#22d3ee"></i> ' + (anyUnknown ? 'Más económica según el catálogo' : 'Opción más económica') + ': <b>' + esc(opts[best].label) + '</b> · ' +
      money(costs[best].total) + ' <span class="fz-muted">(peajes ' + money(costs[best].toll) + ' + combustible ' + money(costs[best].fuel) + ')</span>' +
      (anyUnknown ? '<div class="fz-muted" style="font-size:12px;margin-top:4px">Esta ruta cruza casetas sin tarifa conocida; verifica el costo antes de salir.</div>' : '');
    var first = cards.querySelector('.rm-card');
    if (first) cards.insertBefore(summary, first); else cards.appendChild(summary);
  }

  /* =========================================================================
     11. VERIFICACIÓN COMUNITARIA DE ALERTAS (confirmaciones + estado)
     Adaptado de AlertsFeed de VíaSegura: cada alerta admite confirmación de la
     comunidad y un estado (activa / en atención / resuelta). Se guarda en el
     dispositivo y se refleja en el feed y en el detalle.
     ========================================================================= */
  var verifyStore = load(CFG.verifyKey, {});
  var STATUS_META = {
    activa: { label: 'Activa', color: '#10B981', bg: 'rgba(16,185,129,.14)' },
    atencion: { label: 'En atención', color: '#F59E0B', bg: 'rgba(245,158,11,.16)' },
    resuelta: { label: 'Resuelta', color: '#94A3B8', bg: 'rgba(148,163,184,.18)' }
  };

  function alertKey(a) { return String(a && (a.central_id || a.external_id || a.id) || ''); }
  function findAlert(id) { return allAlerts().filter(function (x) { return String(x.id) === String(id); })[0]; }
  function verifyEntry(a) { var e = verifyStore[alertKey(a)]; return e || { mine: false, count: 0 }; }
  function confirmationCount(a) { return Number(a && a.confirmations || 0) + (verifyEntry(a).mine ? 1 : 0); }
  function alertStatus(a) {
    var e = verifyStore[alertKey(a)];
    if (e && e.status) return e.status;
    return isExpired(a) ? 'resuelta' : 'activa';
  }
  function nextStatus(s) { return s === 'activa' ? 'atencion' : s === 'atencion' ? 'resuelta' : 'activa'; }
  function statusMeta(s) { return STATUS_META[s] || STATUS_META.activa; }

  function verifyInner(a) {
    var e = verifyEntry(a), st = alertStatus(a), sm = statusMeta(st), n = confirmationCount(a);
    return '<button type="button" class="fz-vbtn' + (e.mine ? ' on' : '') + '" data-vact="confirm" data-alert="' + esc(String(a.id)) + '" title="Confirmar que la alerta sigue vigente (se guarda solo en este dispositivo)" aria-label="Confirmar que la alerta sigue vigente">' +
        '<i class="fa-solid fa-circle-check"></i> ' + (e.mine ? 'Confirmada por ti' : 'Confirmar') + ' <b>' + n + '</b></button>' +
      (a.verification_status === 'verified' ? '<span class="fz-vstatus" style="color:#2563EB;background:rgba(37,99,235,.14)"><i class="fa-solid fa-certificate"></i> Verificada</span>' : '') +
      '<button type="button" class="fz-vstatus fz-vcycle" data-vact="cycle" data-alert="' + esc(String(a.id)) + '" style="color:' + sm.color + ';background:' + sm.bg + '" title="Cambiar estado: activa / en atención / resuelta (solo en este dispositivo)" aria-label="Cambiar estado de la alerta">' +
        esc(sm.label) + ' <i class="fa-solid fa-rotate"></i></button>';
  }
  function verifyHTML(a) {
    return '<div class="fz-verify" data-verify-for="' + esc(alertKey(a)) + '">' + verifyInner(a) + '</div>';
  }
  function refreshVerify(a) {
    var k = alertKey(a);
    $$('[data-verify-for]').forEach(function (node) {
      if (node.getAttribute('data-verify-for') === k) node.innerHTML = verifyInner(a);
    });
  }

  FZ.verifyAlert = function (id) {
    var a = findAlert(id); if (!a) return;
    var k = alertKey(a);
    var e = verifyStore[k] ? verifyStore[k] : (verifyStore[k] = { mine: false, count: 0 });
    e.mine = !e.mine;
    save(CFG.verifyKey, verifyStore);
    refreshVerify(a);
    toast(e.mine ? 'Gracias, confirmaste esta alerta.' : 'Confirmación retirada.', e.mine ? 'success' : 'info');
  };
  FZ.setAlertStatus = function (id, status) {
    var a = findAlert(id); if (!a) return;
    var k = alertKey(a);
    var e = verifyStore[k] ? verifyStore[k] : (verifyStore[k] = { mine: false, count: 0 });
    e.status = status;
    save(CFG.verifyKey, verifyStore);
    refreshVerify(a);
  };
  FZ.statusOf = function (a) { return alertStatus(a); };

  function installVerification() {
    // Delegación global: detiene la propagación para no abrir el detalle al confirmar.
    if (!document.__fzVerifyBound) {
      document.__fzVerifyBound = true;
      document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-vact]') : null;
        if (!t) return;
        e.preventDefault(); e.stopPropagation();
        var id = t.getAttribute('data-alert');
        if (t.getAttribute('data-vact') === 'confirm') FZ.verifyAlert(id);
        else { var a = findAlert(id); FZ.setAlertStatus(id, nextStatus(alertStatus(a || {}))); }
      }, true);
    }
    // Chips de verificación en cada tarjeta del feed.
    if (typeof window.alertCardHTML === 'function' && !window.alertCardHTML.__fz) {
      var origCard = window.alertCardHTML;
      var wrappedCard = function (a) { return origCard.apply(this, arguments) + verifyHTML(a); };
      wrappedCard.__fz = true;
      window.alertCardHTML = wrappedCard;
    }
    // Verificación dentro del modal de detalle.
    if (typeof window.openAlertDetail === 'function' && !window.openAlertDetail.__fz) {
      var origDetail = window.openAlertDetail;
      var wrappedDetail = function (id) {
        var out = origDetail.apply(this, arguments);
        try {
          var a = findAlert(id);
          var card = byId('alert-modal-card');
          if (a && card) {
            var host = byId('fz-am-verify');
            if (!host) { host = document.createElement('div'); host.id = 'fz-am-verify'; host.className = 'fz-verify fz-verify-detail'; var desc = byId('am-desc'); if (desc && desc.parentNode) desc.parentNode.insertBefore(host, desc.nextSibling); else card.appendChild(host); }
            host.setAttribute('data-verify-for', alertKey(a));
            host.innerHTML = verifyInner(a);
          }
        } catch (e) {}
        return out;
      };
      wrappedDetail.__fz = true;
      window.openAlertDetail = wrappedDetail;
    }
  }

  /* =========================================================================
     12. ENTRADA GUIADA DE REPORTES (NewAlertModal de VíaSegura)
     Añade tipo de incidente, carril afectado, gravedad y acción recomendada al
     formulario existente y enriquece el detalle sin romper el flujo original.
     ========================================================================= */
  FZ.guided = { open: function () { if (window.openEntryModal) window.openEntryModal(); } };

  var GUIDED_SUB = {
    road: ['Accidente', 'Choque múltiple', 'Vehículo averiado', 'Bloqueo / cierre', 'Obras / mantenimiento', 'Tráfico intenso', 'Bache', 'Clima / vía (niebla, lluvia, derrumbe)', 'Otro'],
    security: ['Asalto / robo', 'Ataque armado', 'Bloqueo / manifestación', 'Operativo policial', 'Vehículo sospechoso', 'Otro']
  };
  var GUIDED_LANE = ['No aplica', 'Carril izquierdo', 'Carril central', 'Carril derecho', 'Acotamiento', 'Todos los carriles', 'Cierre total'];
  var GUIDED_ACTION = ['No aplica', 'Reducir velocidad', 'Precaución al circular', 'Usar ruta alterna', 'Evitar la zona', 'Detenerse en zona segura'];
  var GUIDED_SEV = [['info', 'Informativa'], ['precaucion', 'Precaución'], ['importante', 'Importante (alto riesgo)']];

  function optsHTML(list, selected) {
    return list.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }
  function fillGuidedSub(cat) {
    var sel = byId('fz-g-sub'); if (!sel) return;
    sel.innerHTML = '<option value="">— Sin especificar —</option>' + optsHTML(GUIDED_SUB[cat] || GUIDED_SUB.road);
  }
  function injectGuidedFields() {
    var body = document.querySelector('#entry-modal .m-body'); if (!body) return;
    var cat = byId('ent-cat');
    if (byId('fz-guided')) { if (cat) fillGuidedSub(cat.value); return; }
    var box = document.createElement('div');
    box.id = 'fz-guided'; box.className = 'fz-guided';
    box.innerHTML =
      '<div class="fz-guided-head"><i class="fa-solid fa-wand-magic-sparkles"></i> Guía de reporte <span class="fz-badge fz-info">opcional</span></div>' +
      '<div class="fz-field"><label>Tipo de incidente</label><select id="fz-g-sub"></select></div>' +
      '<div class="fz-grid2">' +
        '<div class="fz-field"><label>Carril afectado</label><select id="fz-g-lane">' + optsHTML(GUIDED_LANE) + '</select></div>' +
        '<div class="fz-field"><label>Gravedad</label><select id="fz-g-sev">' + optsHTML(GUIDED_SEV) + '</select></div>' +
      '</div>' +
      '<div class="fz-field"><label>Acción recomendada</label><select id="fz-g-act">' + optsHTML(GUIDED_ACTION) + '</select></div>';
    body.appendChild(box);
    linkLabels(box);
    fillGuidedSub(cat ? cat.value : 'road');
    if (cat && !cat.__fzGs) { cat.__fzGs = true; cat.addEventListener('change', function () { fillGuidedSub(cat.value); }); }
  }
  function composeGuidedDetail() {
    if (!byId('fz-guided')) return;
    var det = byId('ent-detail'); if (!det) return;
    var sub = (byId('fz-g-sub') || {}).value || '';
    var lane = (byId('fz-g-lane') || {}).value || '';
    var act = (byId('fz-g-act') || {}).value || '';
    var gsev = (byId('fz-g-sev') || {}).value || 'info';
    var cat = (byId('ent-cat') || {}).value || 'road';
    var extras = [];
    if (sub) extras.push('Tipo: ' + sub);
    if (lane && lane !== 'No aplica') extras.push('Carril: ' + lane);
    if (act && act !== 'No aplica') extras.push('Acción: ' + act);
    if (gsev === 'importante') { var imp = byId('ent-imp'); if (imp) imp.checked = true; }
    // Ajuste guiado del tráfico solo si el usuario no lo definió.
    var traf = byId('ent-trafico');
    if (cat === 'road' && traf && !traf.value) {
      if (lane === 'Cierre total') traf.value = 'detenido';
      else if (/Carril|Acotamiento|Todos/.test(lane)) traf.value = 'moderado';
    }
    if (!extras.length) return;
    var base = String(det.value || '').replace(/\s*·?\s*(Tipo|Carril|Acción):\s*[^·]*/g, '').replace(/\s{2,}/g, ' ').trim();
    var tail = extras.join(' · ');
    var room = 280 - (tail.length + 3);
    if (base.length > room) base = base.slice(0, Math.max(0, room)).trim();
    det.value = base ? base + ' · ' + tail : tail;
  }
  function installGuidedEntry() {
    if (typeof window.openEntryModal === 'function' && !window.openEntryModal.__fz) {
      var oO = window.openEntryModal;
      var wO = function () { var r = oO.apply(this, arguments); try { injectGuidedFields(); } catch (e) {} return r; };
      wO.__fz = true; window.openEntryModal = wO;
    }
    if (typeof window.submitEntryAlert === 'function' && !window.submitEntryAlert.__fz) {
      var oS = window.submitEntryAlert;
      var wS = function () { try { composeGuidedDetail(); } catch (e) {} return oS.apply(this, arguments); };
      wS.__fz = true; window.submitEntryAlert = wS;
    }
  }

  /* =========================================================================
     13. ANALÍTICAS HISTÓRICAS (AnalyticsCharts de VíaSegura)
     Tendencia por periodo, franja horaria de mayor incidencia, tipos de
     incidente y comparación contra el periodo anterior. Todo derivado de las
     alertas reales (sin datos simulados).
     ========================================================================= */
  function secRange(startMs, endMs) {
    return allAlerts().filter(function (a) {
      var t = new Date(a.time).getTime(); if (!isFinite(t)) return false;
      if (t < startMs || t > endMs) return false;
      if (secState.state && (a.state || '') !== secState.state) return false;
      if (secState.q) {
        var hay = ((a.title || '') + ' ' + (a.location || '') + ' ' + (a.state || '') + ' ' + refOf(a)).toLowerCase();
        if (hay.indexOf(secState.q.toLowerCase()) < 0) return false;
      }
      return true;
    });
  }
  function classifyIncident(a) {
    try {
      if (a.category === 'security' && window.securityType) return window.securityType(a.title || '');
      if (window.roadIncidentType) return window.roadIncidentType(a);
    } catch (e) {}
    return a.category === 'security' ? 'Seguridad' : 'Otra vial';
  }
  function hStat(value, label, color) {
    return '<div class="fz-stat"><b' + (color ? ' style="color:' + color + '"' : '') + '>' + value + '</b><span>' + label + '</span></div>';
  }
  function renderHistorySec(box, list) {
    var winDays = SEC_DAYS[secState.win] || 90; if (winDays > 400) winDays = 365;
    var now = Date.now(), start = now - winDays * 86400000;
    var prev = secRange(now - 2 * winDays * 86400000, start);
    var res = FZ.safetyScore(list, false);

    var unitDays = winDays <= 45 ? 1 : (winDays <= 120 ? 7 : 14);
    var buckets = Math.max(1, Math.ceil(winDays / unitDays));
    var labels = [], roadSeries = [], secSeries = [];
    for (var i = 0; i < buckets; i++) {
      var s = start + i * unitDays * 86400000, e = s + unitDays * 86400000;
      var sl = list.filter(function (a) { var t = new Date(a.time).getTime(); return t >= s && t < e; });
      labels.push(new Date(s).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }));
      roadSeries.push(sl.filter(function (a) { return a.category !== 'security'; }).length);
      secSeries.push(sl.filter(function (a) { return a.category === 'security'; }).length);
    }
    var hours = new Array(24).fill(0);
    list.forEach(function (a) { var d = new Date(a.time); if (isFinite(d.getTime())) hours[d.getHours()]++; });
    var peak = hours.indexOf(Math.max.apply(null, hours));
    var byType = groupCount(list, classifyIncident, null);
    var byState = groupCount(list, function (a) { return a.state || 'Sin estado'; }, function (a) { return SEV_RANK[sev(a)] || 1; });
    var delta = list.length - prev.length;
    var deltaTxt = (delta > 0 ? '+' + delta : String(delta)) + ' vs periodo previo';

    var typeColors = ['#2563EB', '#EA580C', '#DC2626', '#F59E0B', '#7C3AED', '#0EA5E9', '#64748B', '#14B8A6'];
    box.innerHTML =
      '<div class="fz-stats" style="margin-bottom:12px">' +
        hStat(list.length, 'Incidentes · ' + (winDays >= 365 ? '12 m' : winDays + ' d')) +
        hStat(num(delta, 0) === '0' ? '0' : ((delta > 0 ? '+' : '') + num(delta, 0)), 'Cambio') +
        hStat(pad(peak) + ':00', 'Hora pico') +
        hStat(esc((byState[0] || {}).key || '—'), 'Zona top') +
      '</div>' +
      '<div class="fz-grid2">' +
        '<div><h4 style="margin:0 0 6px;font-size:13px">Tendencia de incidencias</h4><p class="fz-muted" style="font-size:11.5px;margin:0">Cada punto agrupa ' + unitDays + ' día(s). ' + deltaTxt + '.</p><div class="fz-canvas-wrap" style="height:250px"><canvas id="fz-hist-trend"></canvas></div></div>' +
        '<div><h4 style="margin:0 0 6px;font-size:13px">Franja horaria de mayor incidencia</h4><p class="fz-muted" style="font-size:11.5px;margin:0">Distribución de las ' + list.length + ' incidencias filtradas por hora del día.</p><div class="fz-canvas-wrap" style="height:250px"><canvas id="fz-hist-hours"></canvas></div></div>' +
      '</div>' +
      '<div class="fz-sep"></div>' +
      '<div class="fz-grid2">' +
        '<div><h4 style="margin:0 0 6px;font-size:13px">Tipos de incidente</h4><div class="fz-canvas-wrap" style="height:230px"><canvas id="fz-hist-types"></canvas></div></div>' +
        '<div><h4 style="margin:0 0 6px;font-size:13px">Estados con más incidencias</h4>' + rankingHTML(byState.slice(0, 8)) + '</div>' +
      '</div>' +
      '<div class="fz-sep"></div><div class="fz-flex">' +
        '<span class="fz-badge ' + (res.score >= 70 ? 'fz-ok' : res.score >= 50 ? 'fz-medium' : 'fz-critical') + '"><i class="fa-solid fa-gauge-high"></i> Índice actual ' + res.score + ' · ' + esc(res.label) + '</span>' +
        '<span class="fz-badge fz-info"><i class="fa-solid fa-clock-rotate-left"></i> Periodo previo: ' + prev.length + ' incidentes</span>' +
        '<button class="fz-btn fz-sm" onclick="Fusion.security.exportCsv()"><i class="fa-solid fa-file-csv"></i> Exportar datos</button>' +
      '</div>';

    var ax = themeAxis();
    chart('fz-hist-trend', {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Viales', data: roadSeries, borderColor: '#2563EB', backgroundColor: 'rgba(37,99,235,.14)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
          { label: 'Seguridad', data: secSeries, borderColor: '#DC2626', backgroundColor: 'rgba(220,38,38,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { color: ax.text, font: { size: 10 }, boxWidth: 10 } } }, scales: { x: { ticks: { color: ax.text, font: { size: 9 }, maxRotation: 0, autoSkip: true }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: ax.text, precision: 0 }, grid: { color: ax.grid } } } }
    });
    chart('fz-hist-hours', {
      type: 'bar',
      data: { labels: hours.map(function (_, h) { return pad(h); }), datasets: [{ label: 'Incidencias', data: hours, backgroundColor: hours.map(function (v) { return v === Math.max.apply(null, hours) && v > 0 ? '#F59E0B' : '#2563EB'; }), borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: ax.text, font: { size: 9 } }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: ax.text, precision: 0 }, grid: { color: ax.grid } } } }
    });
    chart('fz-hist-types', {
      type: 'doughnut',
      data: { labels: byType.slice(0, 8).map(function (r) { return r.key; }), datasets: [{ data: byType.slice(0, 8).map(function (r) { return r.count; }), backgroundColor: typeColors, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'bottom', labels: { color: ax.text, font: { size: 10 }, boxWidth: 10 } } } }
    });
  }

  /* =========================================================================
     14. INYECCIÓN DE UI (botones en topbar, herramientas y FAB)
     ========================================================================= */
  function injectTopbar() {
    var actions = $('.nt-actions'); if (!actions) return;
    if (byId('fz-night-btn')) return;
    var night = document.createElement('button');
    night.id = 'fz-night-btn'; night.className = 'nt-btn';
    night.title = 'Modo nocturno'; night.setAttribute('aria-label', 'Modo nocturno de carretera');
    night.innerHTML = '<i class="fa-solid fa-moon"></i>';
    night.onclick = function () { FZ.night.toggle(); };
    actions.insertBefore(night, actions.firstChild);

    var install = document.createElement('button');
    install.className = 'nt-btn fz-install-btn fz-hidden';
    install.title = 'Instalar Zero Vial'; install.innerHTML = '<i class="fa-solid fa-download" style="color:#FBBF24"></i><span>Instalar</span>';
    install.onclick = installApp;
    actions.insertBefore(install, night);
  }

  // Menú superior: agrupa todas las herramientas de fusión en la barra de navegación.
  function topMenuHTML() {
    var items = [
      ['fa-car-on', 'Modo Viaje (HUD)', 'Tablero de conducción con alertas y puntaje', 'Fusion.trip.open()'],
      ['fa-route', 'Ruta con costos', 'Peajes y combustible por alternativa', 'Fusion.routes.open()'],
      ['fa-money-bill-wave', 'Calculadora de peajes', 'Casetas, combustible y costo total', 'Fusion.tolls.open()'],
      ['fa-shield-halved', 'Zonas de seguridad', 'Ranking por estado, corredor y riesgo', 'Fusion.security.open()'],
      ['fa-chart-line', 'Análisis histórico', 'Tendencia, horas pico y comparativas', 'Fusion.security.openHistory()'],
      ['fa-file-pdf', 'Reporte mensual PDF', 'Descarga el reporte de seguridad', 'Fusion.report.open()'],
      ['fa-wand-magic-sparkles', 'Reporte guiado', 'Nueva alerta con tipo, carril y acción', 'Fusion.guided.open()'],
      ['fa-bell', 'Alertas push', 'Avisos por zona de influencia y ruta', 'Fusion.push.open()'],
      ['fa-moon', 'Modo nocturno', 'Alto contraste automático para conducir', 'Fusion.night.open()']
    ];
    return '<div class="fz-topmenu-head"><i class="fa-solid fa-layer-group"></i> Herramientas Zero Vial</div>' +
      '<div class="fz-topmenu-grid">' + items.map(function (it) {
        return '<button type="button" class="fz-topmenu-item" data-fz-open="1" onclick="' + it[3] + '">' +
          '<span class="fz-tmi-icon"><i class="fa-solid ' + it[0] + '"></i></span>' +
          '<span class="fz-tmi-copy"><b>' + esc(it[1]) + '</b><small>' + esc(it[2]) + '</small></span>' +
        '</button>';
      }).join('') + '</div>';
  }
  function toggleTopMenu() {
    var m = byId('fz-topmenu'); if (!m) return;
    var open = m.classList.toggle('fz-open');
    var b = byId('fz-topmenu-btn'); if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && b) b.classList.add('active'); else if (b) b.classList.remove('active');
  }
  function closeTopMenu() {
    var m = byId('fz-topmenu'); if (m) m.classList.remove('fz-open');
    var b = byId('fz-topmenu-btn'); if (b) { b.setAttribute('aria-expanded', 'false'); b.classList.remove('active'); }
  }
  FZ.topMenu = { open: function () { var m = byId('fz-topmenu'); if (m && !m.classList.contains('fz-open')) toggleTopMenu(); }, close: closeTopMenu, toggle: toggleTopMenu };

  function injectTopMenu() {
    var nav = $('.nt-nav'); if (!nav || byId('fz-topmenu-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'fz-topmenu-btn'; btn.type = 'button'; btn.className = 'nt-btn fz-topmenu-btn';
    btn.title = 'Herramientas Zero Vial'; btn.setAttribute('aria-haspopup', 'true'); btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<i class="fa-solid fa-layer-group"></i><span>Fusión</span>';
    var grupos = nav.querySelector('.feature-soon');
    if (grupos) nav.insertBefore(btn, grupos); else nav.appendChild(btn);

    var menu = document.createElement('div');
    menu.id = 'fz-topmenu'; menu.className = 'fz-topmenu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = topMenuHTML();
    var bar = $('.nv-topbar') || document.body;
    bar.appendChild(menu);

    btn.onclick = function (e) { e.stopPropagation(); toggleTopMenu(); };
    menu.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('[data-fz-open]')) closeTopMenu();
    });
    if (!document.__fzTopMenuBound) {
      document.__fzTopMenuBound = true;
      document.addEventListener('click', function (e) {
        if (e.target && e.target.closest && (e.target.closest('#fz-topmenu') || e.target.closest('#fz-topmenu-btn'))) return;
        closeTopMenu();
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeTopMenu(); });
    }
  }

  function injectFab() {
    if (byId('fz-fab')) return;
    var fab = document.createElement('div');
    fab.id = 'fz-fab'; fab.className = 'fz-fab';
    fab.setAttribute('role', 'toolbar'); fab.setAttribute('aria-label', 'Herramientas de Fusión');
    function b(cls, label, call, icon) {
      return '<button type="button" class="fz-fab-item ' + cls + '" title="' + label + '" aria-label="' + label + '" onclick="Fusion.fabClose();' + call + '"><i class="fa-solid ' + icon + '"></i></button>';
    }
    fab.innerHTML =
      '<button type="button" class="fz-fab-toggle" id="fz-fab-toggle" aria-expanded="false" aria-controls="fz-fab" title="Herramientas de Fusión" aria-label="Herramientas de Fusión"><i class="fa-solid fa-bolt"></i></button>' +
      b('fz-fab-primary', 'Modo Viaje (HUD)', 'Fusion.trip.open()', 'fa-car-on') +
      b('', 'Calculadora de peajes', 'Fusion.tolls.open()', 'fa-money-bill-wave') +
      b('', 'Zonas de seguridad', 'Fusion.security.open()', 'fa-shield-halved') +
      b('', 'Reporte guiado', 'Fusion.guided.open()', 'fa-wand-magic-sparkles') +
      b('', 'Modo nocturno', 'Fusion.night.open()', 'fa-moon');
    document.body.appendChild(fab);

    // En móvil el FAB se colapsa en un solo botón; en escritorio sigue visible como barra.
    var toggle = byId('fz-fab-toggle');
    toggle.addEventListener('click', function (e) { e.stopPropagation(); FZ.fabToggle(); });
    document.addEventListener('click', function (e) { if (!fab.contains(e.target)) FZ.fabClose(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') FZ.fabClose(); });
  }
  FZ.fabToggle = function () {
    var fab = byId('fz-fab'); if (!fab) return;
    var open = fab.classList.toggle('fz-fab-open');
    var t = byId('fz-fab-toggle'); if (t) t.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  FZ.fabClose = function () {
    var fab = byId('fz-fab'); if (!fab) return;
    fab.classList.remove('fz-fab-open');
    var t = byId('fz-fab-toggle'); if (t) t.setAttribute('aria-expanded', 'false');
  };

  /* =========================================================================
     11. INICIALIZACIÓN
     ========================================================================= */
  function onAlertsChanged() {
    if (trip.open) renderTrip();
    if (byId('fz-sec-ov') && byId('fz-sec-ov').classList.contains('fz-open')) renderSecurity();
    scanPush(false);
  }

  function labelNavigation() {
    $$('#sidebar .nav-item').forEach(function (item) {
      if (item.hasAttribute('aria-label') || item.hasAttribute('aria-labelledby')) return;
      var label = item.querySelector('.nav-label');
      var text = label && label.textContent ? label.textContent.trim() : '';
      if (text) item.setAttribute('aria-label', text);
    });
  }

  function installPRTabsA11y() {
    var tabs = $('.pr-tabs'); if (!tabs) return;
    function sync() {
      $$('.pr-tab', tabs).forEach(function (tab) {
        tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
      });
    }
    sync();
    if (!tabs.__fzA11yObserver && typeof MutationObserver !== 'undefined') {
      tabs.__fzA11yObserver = new MutationObserver(sync);
      tabs.__fzA11yObserver.observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }
  }

  function init() {
    // Tema nocturno
    if (night.mode === 'auto') startLuxSensor();
    applyNight();
    nightTick = setInterval(applyNight, 60000);

    // Conectividad / PWA
    initOffline();
    registerServiceWorker();
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; refreshInstallButtons(); });
    window.addEventListener('appinstalled', function () { deferredPrompt = null; refreshInstallButtons(); toast('Zero Vial instalada', 'ok'); });

    // UI
    injectTopbar();
    injectTopMenu();
    // injectFab() ya no se usa: las herramientas de fusión quedaron centralizadas
    // en el botón "Fusión" de la barra superior (injectTopMenu) para no duplicar accesos.
    refreshInstallButtons();
    labelNavigation();
    installPRTabsA11y();

    // Integraciones quirúrgicas sobre el código existente
    installRouteEnricher();
    installVerification();
    installGuidedEntry();
    installLegacyModalA11y();

    // Engancha el pipeline de la app
    if (typeof window.rebuildU === 'function' && !window.rebuildU.__fz) {
      var orig = window.rebuildU;
      var wrapped = function () { var r = orig.apply(this, arguments); try { onAlertsChanged(); } catch (e) {} return r; };
      wrapped.__fz = true;
      window.rebuildU = wrapped;
    }

    // Escaneo periódico de push
    setInterval(function () { scanPush(false); }, 90000);

    // Atajos de teclado
    document.addEventListener('keydown', function (e) {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'Escape' && trip.open) FZ.trip.close();
    });

    // Reintenta inyección si la app re-renderiza la barra
    setInterval(function () { injectTopbar(); injectTopMenu(); }, 4000);

    // Accesos directos (manifest / ?fusion=trip|tolls|security|push|report|night)
    try {
      var deep = new URLSearchParams(location.search).get('fusion');
      var deepMap = { trip: 'trip', tolls: 'tolls', security: 'security', push: 'push', report: 'report', night: 'night', routes: 'routes', guided: 'guided' };
      if (deep && deepMap[deep]) setTimeout(function () { (FZ[deepMap[deep]] && FZ[deepMap[deep]].open) && FZ[deepMap[deep]].open(); }, 800);
    } catch (e) {}

    console.log('[Fusion] Zero Vial + VíaSegura listo. Usa Fusion.trip.open(), Fusion.tolls.open(), Fusion.security.open(), Fusion.report.open(), Fusion.push.open(), Fusion.night.open(), Fusion.routes.open(), Fusion.guided.open().');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); });
  else setTimeout(init, 0);

  // Expone utilidades de cierre para los botones en línea
  window.closeModal = window.closeModal || function (id) { closeM(id); };
})();
