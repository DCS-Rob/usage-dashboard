const CACHE_NAME = 'usagedashboard-cache-v0.27.2';
const APP_BUILD = '0.27.2';

// Beantwoord versievragen vanuit de page (voor de Build info-strip)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_SW_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ cacheName: CACHE_NAME, build: APP_BUILD });
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
const ASSETS = [
  './',
  './index.html',
  './style.css?v=0.27.2',
  './app.js?v=0.27.2',
  './lib/chart.min.js',
  './assets/usage-dashboard-logo.svg',
  './assets/openai-badge.svg',
  './assets/anthropic-ai-badge.svg',
  './assets/profile-avatar.svg'
];

// Install Event: Cache all essential assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Usage Dashboard ServiceWorker] Caching App Shell...');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event: Clear outdated caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Usage Dashboard ServiceWorker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Is dit het app-shell-document (index.html of de directory-root)?
// Dit is het ENIGE bestand met een onversioneerde URL: alle overige assets hebben een
// ?v=<versie>-query, dus daarvoor is cache-first veilig (nieuwe versie = nieuwe URL).
function isAppShellRequest(request) {
  if (request.mode === 'navigate') return true;
  const path = new URL(request.url).pathname;
  return path.endsWith('/') || path.endsWith('/index.html');
}

// Fetch Event
self.addEventListener('fetch', (e) => {
  // Only intercept HTTP/S GET requests (skip chrome-extension:// schemes and POST requests)
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) {
    return;
  }

  // App shell: NETWORK-FIRST (cache alleen als offline-fallback).
  // Waarom: index.html verwijst naar app.js?v=<versie>. Bij cache-first kreeg je na een
  // update eerst de OUDE index.html → die vroeg de OUDE app.js op → pas bij een tweede
  // refresh zag je de nieuwe versie. Dat was de oorzaak van "ik moet 2x verversen"
  // en van een telefoon die op een oude versie bleef hangen.
  if (isAppShellRequest(e.request)) {
    e.respondWith(
      // 'no-cache' = wél revalideren bij de server (ETag → goedkope 304), niet blind
      // uit de HTTP-cache van de browser serveren.
      fetch(new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }))
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
          }
          return networkResponse;
        })
        .catch(() =>
          // Offline: val terug op de cache (exacte request, anders de shell-varianten).
          caches.match(e.request)
            .then((hit) => hit || caches.match('./index.html'))
            .then((hit) => hit || caches.match('./'))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch new version in background to update cache for next time
        fetch(e.request).then((networkResponse) => {
          if (networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(e.request, networkResponse);
            });
          }
        }).catch(() => {
          // Ignore network errors when updating cache offline
        });
        return cachedResponse;
      }
      return fetch(e.request);
    })
  );
});
