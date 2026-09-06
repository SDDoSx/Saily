/* Saily service worker: offline app shell, tile cache, weather cache. */
const VERSION = 'saily-v3';
const SHELL = 'shell-' + VERSION;
const TILES = 'tiles-v1';
const DATA = 'data-v1';
const SHELL_FILES = [
  './', './index.html', './app.js', './nav.js', './weather.js', './ais.js', './chart-data.js', './passage.js', './manifest.webmanifest',
  './vendor/leaflet/leaflet.css', './vendor/leaflet/leaflet.min.js',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const TILE_HOSTS = ['tile.openstreetmap.org', 'tiles.openseamap.org', 't1.openseamap.org', 'basemaps.cartocdn.com', 'server.arcgisonline.com'];
const DATA_HOSTS = ['api.open-meteo.com', 'marine-api.open-meteo.com'];
const BLANK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // app shell: cache first, refresh in background
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const fetchP = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) { fetchP.catch(() => {}); return hit; }
      const res = await fetchP;
      if (res) return res;
      if (req.mode === 'navigate') return c.match('./index.html');
      return new Response('offline', { status: 503 });
    }));
    return;
  }
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      } catch (err) {
        // offline and not cached: transparent tile, so Leaflet shows the vector chart underneath without errors
        return new Response(Uint8Array.from(atob(BLANK_PNG), c => c.charCodeAt(0)), { status: 200, headers: { 'Content-Type': 'image/png', 'X-Saily': 'blank' } });
      }
    }));
    return;
  }
  if (DATA_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(DATA).then(async c => {
      try {
        const res = await fetch(req);
        if (res && res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await c.match(req);
        if (hit) { // mark it so the app knows this is the last stored forecast, not a fresh one
          const h = new Headers(hit.headers); h.set('X-Saily-Cache', 'stale');
          return new Response(await hit.blob(), { status: 200, headers: h });
        }
        return new Response(JSON.stringify({ error: true, reason: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    }));
  }
});
