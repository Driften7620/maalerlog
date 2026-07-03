// Driften — Service Worker
// Version: 2026-07-02-v1
// Opdater CACHE_NAME ved hver ny deploy af index.html

const CACHE_NAME = 'driften-2026-07-03-v6';

const APP_SHELL = [
  './',
  './index.html',
];

// ── Install: cache app shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: ryd gamle caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for navigation, cache-first for assets ───────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Eksterne services går direkte på netværk — aldrig cache
  const isExternal =
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebasestorage.googleapis.com') ||
    url.hostname.includes('workers.dev') ||
    url.hostname.includes('open-meteo.com') ||
    url.hostname.includes('energidataservice.dk') ||
    url.hostname.includes('emailjs.com');

  if (isExternal) return;

  // Navigation: prøv netværk, fald tilbage til cached index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() =>
          caches.match('./index.html').then(
            cached => cached || new Response('Offline', { status: 503 })
          )
        )
    );
    return;
  }

  // Alt andet: cache-first med netværk-fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => new Response('Offline', { status: 503 }));
    })
  );
});
