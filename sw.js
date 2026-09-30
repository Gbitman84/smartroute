// App-shell cache so SmartRun opens even with weak reception.
// Network-first for everything: fresh code when online, cached copy when offline.
// Data itself is synced by Firestore's own offline cache.
const CACHE = 'smartroute-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.json', 'icon.svg', 'icon-192.png',
  'js/app.js', 'js/db.js', 'js/util.js', 'js/nav.js', 'js/solver.js', 'js/firebase-config.js',
  'js/maps/provider.js', 'js/maps/osm.js', 'js/maps/google.js', 'js/members.js', 'Registration.html', 'js/registration.js'];
const CDN = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('smartroute-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const same = url.origin === self.location.origin;
  const cdn = CDN.includes(url.hostname) && !url.pathname.includes('/firestore') ;
  if (!same && !cdn) return; // APIs (OSRM, Nominatim, Firestore, Google) go straight to network
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: same }))
  );
});
