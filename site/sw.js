/* Saily service worker: offline app shell, tile cache, weather cache. */
const VERSION = 'saily-1b87a1db';
const SHELL = 'shell-' + VERSION;
const TILES = 'tiles-v1';
const DATA = 'data-v1';
// Every bundled passage is precached: switching passage at sea must not need a network.
// tools/stamp_build.py rewrites PASSAGE_FILES from site/passages/ on every build.
const PASSAGE_FILES = ['./passages/index.json', './passages/strait-of-gibraltar/chart-data.js', './passages/strait-of-gibraltar/passage.js'];
const SHELL_FILES = [
  './', './index.html', './boot.js', './app.js', './nav.js', './weather.js', './ais.js', './boats.json', ...PASSAGE_FILES, './manifest.webmanifest',
  './vendor/leaflet/leaflet.css', './vendor/leaflet/leaflet.min.js',
  './vendor/fonts/plex-sans-var-latin.woff2', './vendor/fonts/plex-cond-600-latin.woff2', './vendor/fonts/plex-cond-700-latin.woff2',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './version.json',
];
const TILE_HOSTS = ['tile.openstreetmap.org', 'tiles.openseamap.org', 't1.openseamap.org', 'server.arcgisonline.com'];
const DATA_HOSTS = ['api.open-meteo.com', 'marine-api.open-meteo.com'];
const BLANK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' }))))); // no skipWaiting: the new version waits until the user applies it
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'version' && e.source) e.source.postMessage({ type: 'version', version: VERSION });
  if (e.data === 'shell-status') {
    const port = e.ports && e.ports[0];
    caches.open(SHELL).then(async c => { const missing = []; for (const f of SHELL_FILES) { if (!(await c.match(f, { ignoreSearch: true }))) missing.push(f); } const msg = { type: 'shell-status', version: VERSION, missing }; if (port) port.postMessage(msg); else if (e.source) e.source.postMessage(msg); });
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // app shell: served only from the set precached at install (atomic: every file from one build); nothing is
    // written into the shell cache at fetch time, so index.html and app.js can never come from different pushes
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); } catch (err) {
        if (req.mode === 'navigate') return c.match('./index.html');
        return new Response('offline', { status: 503 });
      }
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
