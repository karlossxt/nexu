'use strict';
// Ejecuta el service-worker.js real con Cache Storage y red simuladas.
// Cubre el fallo de las URLs versionadas (?v=) y la caída a caché ante un 5xx.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ORIGIN = 'http://localhost:3123';
const SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8');
const RealRequest = Request;

function keyOf(req) {
  if (typeof req === 'string') return new URL(req, ORIGIN).href;
  if (req && typeof req.url === 'string') return new URL(req.url, ORIGIN).href;
  return String(req);
}

class BrowserRequest extends RealRequest {
  constructor(input, init) {
    if (typeof input === 'string') input = new URL(input, ORIGIN).href;
    super(input, init);
  }
}

function createHarness() {
  let online = true;
  let serverError = false;
  const fetched = [];
  const cacheStores = new Map();
  const listeners = new Map();

  async function fakeFetch(input) {
    const url = typeof input === 'string' ? input : input.url;
    fetched.push(url);
    if (!online) throw new TypeError('Failed to fetch');

    const pathname = new URL(url, ORIGIN).pathname;
    if (serverError && (pathname === '/' || pathname === '/index.html')) {
      return new Response('error del servidor', { status: 502 });
    }
    if (pathname === '/' || pathname === '/index.html') {
      return new Response('<!doctype html><title>Zero Vial offline shell</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (pathname.startsWith('/api/')) {
      return new Response('{"error":"no"}', { status: 500 });
    }
    const parsed = new URL(url, ORIGIN);
    return new Response('/* ' + parsed.pathname + parsed.search + ' */', {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  class FakeCache {
    constructor() { this.map = new Map(); }
    async add(req) {
      const key = keyOf(req);
      const res = await fakeFetch(new BrowserRequest(key));
      if (!(res && (res.ok || res.type === 'opaque'))) throw new Error('add failed: ' + key);
      this.map.set(key, res.clone());
    }
    async put(req, res) { this.map.set(keyOf(req), res.clone()); }
    async match(req, options) {
      const key = keyOf(req);
      const exact = this.map.get(key);
      if (exact) return exact.clone();
      if (options && options.ignoreSearch) {
        const target = new URL(key);
        for (const [cachedKey, res] of this.map) {
          const cached = new URL(cachedKey);
          if (cached.origin === target.origin && cached.pathname === target.pathname && cached.hash === target.hash) {
            return res.clone();
          }
        }
      }
      return undefined;
    }
    async keys() { return [...this.map.keys()].map((key) => new BrowserRequest(key)); }
    async delete(req) { return this.map.delete(keyOf(req)); }
  }

  const caches = {
    async open(name) {
      if (!cacheStores.has(name)) cacheStores.set(name, new FakeCache());
      return cacheStores.get(name);
    },
    async keys() { return [...cacheStores.keys()]; },
    async delete(name) { return cacheStores.delete(name); },
    async match(req, options) {
      for (const cache of cacheStores.values()) {
        const hit = await cache.match(req, options);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) { listeners.set(type, fn); },
    skipWaiting() {},
    clients: {
      claim() {},
      matchAll: async () => [],
      openWindow: async () => null,
    },
  };

  vm.runInContext(SW_SOURCE, vm.createContext({
    self, caches, fetch: fakeFetch, Request: BrowserRequest, Response, URL,
    TypeError, Promise, console, setTimeout, clearTimeout,
  }), { filename: 'service-worker.js' });

  async function install() {
    const handler = listeners.get('install');
    assert.ok(handler, 'el service worker debe registrar install');
    let pending;
    handler({ waitUntil: (value) => { pending = value; } });
    await pending;
  }

  function request(url, options = {}) {
    const handler = listeners.get('fetch');
    assert.ok(handler, 'el service worker debe registrar fetch');
    const request = {
      method: options.method || 'GET',
      url: new URL(url, ORIGIN).href,
      mode: options.mode || 'no-cors',
    };
    let response;
    handler({ request, respondWith: (value) => { response = value; } });
    return response;
  }

  return {
    install,
    request,
    caches,
    fetched,
    setOnline(value) { online = value; },
    setServerError(value) { serverError = value; },
    clearCaches() { cacheStores.clear(); },
  };
}

test('install precarga el app shell', async () => {
  const h = createHarness();
  await h.install();
  const keys = await h.caches.keys();
  assert.equal(keys.length, 1);
  assert.match(keys[0], /-shell$/);
  const entries = await (await h.caches.open(keys[0])).keys();
  const paths = entries.map((r) => new URL(r.url).pathname).sort();
  assert.equal(paths.length, 14);
  assert.ok(paths.includes('/index.html'));
  assert.ok(paths.includes('/fusion/fusion.js'));
  assert.ok(paths.includes('/landing-city-v1.webp'));
});

test('offline: la navegación devuelve el index cacheado', async () => {
  const h = createHarness();
  await h.install();
  h.setOnline(false);
  const res = await h.request('/', { mode: 'navigate' });
  assert.ok(res, 'la navegación offline debe llamar a respondWith');
  assert.match(await res.text(), /Zero Vial offline shell/);
});

test('offline: una ruta desconocida cae al index cacheado', async () => {
  const h = createHarness();
  await h.install();
  h.setOnline(false);
  const res = await h.request('/ruta-inexistente', { mode: 'navigate' });
  assert.match(await res.text(), /Zero Vial offline shell/);
});

test('offline: los assets con ?v= usan el shell precargado', async () => {
  const h = createHarness();
  await h.install();
  h.setOnline(false);
  const res = await h.request('/fusion/fusion.js?v=10');
  assert.ok(res, 'el asset versionado debe resolverse desde caché');
  assert.match(await res.text(), /fusion\/fusion\.js/);
});

test('un asset versionado se pide a red y no queda atrapado en la copia vieja', async () => {
  const h = createHarness();
  await h.install();
  const res = await h.request('/fusion/fusion.js?v=99');
  assert.ok(res);
  assert.match(await res.text(), /\?v=99/);
  assert.ok(h.fetched.some((url) => url.endsWith('/fusion/fusion.js?v=99')));
});

test('offline sin caché: respuesta 503 propia', async () => {
  const h = createHarness();
  await h.install();
  h.clearCaches();
  h.setOnline(false);
  const res = await h.request('/', { mode: 'navigate' });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Sin conexi/);
});

test('una respuesta opaca vieja no satisface una petición CORS', async () => {
  const h = createHarness();
  await h.install();
  const url = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const shell = (await h.caches.keys()).find((key) => key.endsWith('-shell'));
  const cache = await h.caches.open(shell.replace(/-shell$/, '-runtime'));
  const opaque = { type: 'opaque', ok: false, status: 0, clone() { return this; } };
  await cache.put(url, opaque);
  h.setOnline(false);
  const res = await h.request(url, { mode: 'cors' });
  assert.equal(res.status, 503, 'no debe servir una opaca a una petición CORS');
});

test('las peticiones /api/ no se interceptan', async () => {
  const h = createHarness();
  await h.install();
  assert.equal(h.request('/api/feed', { mode: 'cors' }), undefined);
});

test('las credenciales de despliegue en /.well-known/ no se cachean', async () => {
  const h = createHarness();
  await h.install();
  assert.equal(h.request('/.well-known/vercel/jwe', { mode: 'cors' }), undefined);
});

test('un 5xx de navegación cae a la copia cacheada', async () => {
  const h = createHarness();
  await h.install();
  h.setServerError(true);
  const res = await h.request('/', { mode: 'navigate' });
  assert.ok(res, 'el 5xx debe resolverse con la copia cacheada');
  assert.match(await res.text(), /Zero Vial offline shell/);
});
