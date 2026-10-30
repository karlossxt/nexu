/* ============================================================================
   ZERO VIAL · FUSIÓN  ·  Service Worker
   - App shell cacheado para uso sin conexión en carretera.
   - Navegación: network-first con respaldo en caché.
   - Estáticos del sitio: stale-while-revalidate.
   - Tiles / fuentes: cache-first.
   - Nunca cachea peticiones de API (POST/GET dinámicos) ni Supabase.
   ============================================================================ */
const VERSION = 'zv-fusion-v46';
const RUNTIME_MAX_ENTRIES = 400; // tope para tiles/CDN: evita llenar el almacenamiento del móvil
const SHELL_CACHE = VERSION + '-shell';
const RUNTIME_CACHE = VERSION + '-runtime';

const SHELL = [
  '/',
  '/index.html',
  '/red-vial.js',
  '/casetas-data.js',
  '/fusion/fusion.css',
  '/fusion/polish.css',
  '/fusion/fusion.js',
  '/fusion/tolls-data.js',
  '/manifest.webmanifest',
  '/landing-city-v1.webp',
  '/zero-mark.png',
  '/favicon-256.png',
  '/apple-touch-icon.png',
  '/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.indexOf(VERSION) !== 0).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting' || (event.data && event.data.type === 'SKIP_WAITING')) self.skipWaiting();
});


// Solo se cachean respuestas válidas (200 o 'opaque' de CDN/tiles). Antes se guardaba
// cualquier respuesta, incluidos 404/500, y luego se servían como si fueran la página.
function cacheable(res) {
  return !!res && (res.ok || res.type === 'opaque');
}

// Recorta el caché de runtime a los N elementos más recientes (FIFO).
async function trimCache(name, max) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  } catch (e) { /* no crítico */ }
}

function offlineResponse() {
  return new Response(
    '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Sin conexión · Zero Vial</title><body style="font-family:system-ui,sans-serif;background:#050a12;color:#e6edf6;' +
    'display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">' +
    '<div><h1 style="margin:0 0 8px">Sin conexión</h1><p style="color:#9fb0c6;max-width:32ch;margin:0 auto 18px">' +
    'No pudimos cargar Zero Vial y aún no hay una copia guardada. Revisa tu red e inténtalo de nuevo.</p>' +
    '<button onclick="location.reload()" style="padding:12px 20px;border:0;border-radius:12px;background:#FFB000;color:#111;font-weight:700;font-size:16px">Reintentar</button></div></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function isApi(url) {
  return /\/api\//.test(url.pathname) || /supabase\.co/.test(url.hostname) || /rss2json|allorigins|router\.project-osrm/.test(url.hostname + url.pathname);
}
function isTileOrFont(url) {
  return /tile|arcgisonline|openstreetmap|basemaps|fonts\.gstatic|fonts\.googleapis|cdnjs|jsdelivr|unpkg/.test(url.hostname + url.pathname);
}
// Una respuesta opaca no puede satisfacer una petición CORS (por ejemplo, CSS/JS
// con integrity + crossorigin). Si la caché vieja tiene una opaca, hay que ir a red.
function usableCached(cached, req) {
  return !!cached && !(req.mode === 'cors' && cached.type === 'opaque');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // No interceptar APIs dinámicas, credenciales de despliegue ni websockets
  if (isApi(url) || url.pathname.startsWith('/.well-known/') || url.protocol === 'chrome-extension:') return;

  // Navegación (documentos): network-first, offline -> index cacheado
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        // Un 5xx (servidor caído o desplegando) no debe tapar la copia offline.
        if (res && res.status >= 500) {
          return caches.match(req, { ignoreSearch: true })
            .then((r) => r || caches.match('/index.html'))
            .then((r) => r || caches.match('/'))
            .then((r) => r || res);
        }
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('/index.html')).then((r) => r || caches.match('/')).then((r) => r || offlineResponse()))
    );
    return;
  }

  // Tiles, fuentes y CDNs: cache-first
  if (isTileOrFont(url)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (usableCached(cached, req)) return cached;
        return fetch(req).then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).then(() => trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES)).catch(() => {});
          }
          return res;
        }).catch(() => usableCached(cached, req) ? cached : new Response('', { status: 503, statusText: 'Offline' }));
      })
    );
    return;
  }

  // Mismo origen (estáticos): stale-while-revalidate. Un asset con ?v= se pide
  // primero a red para que el cambio de versión no quede atrapado en la copia
  // vieja del shell; si no hay red, se usa esa copia como respaldo.
  if (url.origin === self.location.origin) {
    if (url.searchParams.has('v')) {
      event.respondWith(
        fetch(req).then((res) => {
          if (res && res.status < 500 && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          }
          return caches.match(req, { ignoreSearch: true }).then((cached) => cached || res);
        }).catch(() => caches.match(req, { ignoreSearch: true }).then((cached) => cached || offlineResponse()))
      );
      return;
    }
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});

// Web Push real: llega aunque la app esté cerrada.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Zero Vial', {
    body: d.body || 'Hay una alerta nueva en tu zona.',
    icon: '/favicon-256.png', badge: '/favicon-256.png', tag: d.tag || 'zv-push',
    vibrate: [200, 100, 200], lang: 'es-MX', data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          const id = event.notification.data && event.notification.data.alertId;
          if (id != null) client.postMessage({ type: 'open-alert', id });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
