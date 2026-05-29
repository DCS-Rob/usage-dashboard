const CACHE_NAME = 'usagedashboard-cache-v0.7.3';
const APP_BUILD = '0.7.3';

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
  './style.css?v=0.7.3',
  './app.js?v=0.7.3',
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

// Fetch Event: Stale-while-revalidate caching strategy
self.addEventListener('fetch', (e) => {
  // Only intercept HTTP/S GET requests (skip chrome-extension:// schemes and POST requests)
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) {
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
