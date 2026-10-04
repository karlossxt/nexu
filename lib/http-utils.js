'use strict';

const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

function sendJson(res, code, obj, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {});
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}

function validIp(value) {
  const ip = String(value || '').trim().replace(/^::ffff:/, '');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split('.').every(part => {
      const n = Number(part);
      return Number.isFinite(n) && n >= 0 && n <= 255;
    }) ? ip : '';
  }
  return /^[0-9a-f:]{2,45}$/i.test(ip) && ip.includes(':') ? ip.toLowerCase() : '';
}

function remoteIp(req, options = {}) {
  const trustProxy = options.trustProxy === true || options.trustProxy === '1';
  const proxyHops = Math.max(1, parseInt(options.proxyHops, 10) || 1);

  if (trustProxy) {
    const fwd = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-vercel-forwarded-for']);
    if (fwd) {
      const parts = String(fwd).split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) {
        const idx = Math.max(0, parts.length - proxyHops);
        const ip = validIp(parts[idx]);
        if (ip) return ip;
      }
    }
    const real = req.headers && req.headers['x-real-ip'];
    if (real) {
      const ip = validIp(String(real).trim());
      if (ip) return ip;
    }
  }
  const sockIp = req.socket && req.socket.remoteAddress;
  if (sockIp) {
    const ip = validIp(sockIp);
    if (ip) return ip;
  }
  return 'anon';
}

function createRateLimiter(options = {}) {
  const maxPerMin = Number.isFinite(options.maxPerMin) ? options.maxPerMin : 60;
  const maxGlobalPerMin = Number.isFinite(options.maxGlobalPerMin) ? options.maxGlobalPerMin : 0;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 2000;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 60 * 1000;
  const globalTtlMs = Number.isFinite(options.globalTtlMs) ? options.globalTtlMs : 60 * 1000;

  const map = new Map();
  let global = { n: 0, t: Date.now() };

  function cleanup(now) {
    if (map.size <= maxEntries) return;
    for (const [key, value] of map) {
      if (now - value.t > ttlMs * 2) map.delete(key);
    }
    if (map.size > maxEntries) {
      const first = map.keys().next();
      if (!first.done) map.delete(first.value);
    }
  }

  function isLimited(ip) {
    const id = String(ip || 'anon');
    const now = Date.now();

    if (maxGlobalPerMin > 0) {
      if (now - global.t > globalTtlMs) global = { n: 0, t: now };
      global.n += 1;
      if (global.n > maxGlobalPerMin) return true;
    }

    const cur = map.get(id) || { n: 0, t: now };
    if (now - cur.t > ttlMs) {
      cur.n = 0;
      cur.t = now;
    }
    cur.n += 1;
    map.set(id, cur);

    cleanup(now);
    return cur.n > maxPerMin;
  }

  function reset() {
    map.clear();
    global = { n: 0, t: Date.now() };
  }

  function size() {
    return map.size;
  }

  return { isLimited, reset, size, _map: map, _global: global };
}

// Comparación en tiempo constante (hash para igualar longitudes)
function safeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  const ba = Buffer.from(sa);
  const bb = Buffer.from(sb);
  if (ba.length !== bb.length) {
    const pad = Buffer.alloc(Math.max(ba.length, bb.length), 0);
    return crypto.timingSafeEqual(pad, pad);
  }
  return crypto.timingSafeEqual(ba, bb);
}

function cleanStr(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = {
  HttpError,
  sendJson,
  validIp,
  remoteIp,
  createRateLimiter,
  safeEqual,
  cleanStr
};