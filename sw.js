// Driften — Service Worker
// Version: 2026-07-03-v7
// Opdater CACHE_NAME ved hver ny deploy af index.html

const CACHE_NAME = 'driften-2026-07-07-v21';
const APP_SHELL = ['./', './index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Eksterne services — aldrig cache
  // VIGTIGT: Firebase-databaser i ikke-standard regioner (fx europe-west1, som denne)
  // bruger domænet *.firebasedatabase.app i stedet for det klassiske *.firebaseio.com.
  // Uden dette tjek blev ALLE Firebase-læsninger fanget af cache-first-reglen nedenfor,
  // og frøs fast som et øjebliksbillede efter første læsning efter hver deploy - ændringer
  // så ud til at "forsvinde" ved genindlæsning, selvom de var gemt korrekt i databasen.
  const isExternal =
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebasedatabase.app') ||
    url.hostname.includes('workers.dev') ||
    url.hostname.includes('open-meteo.com') ||
    url.hostname.includes('energidataservice.dk') ||
    url.hostname.includes('emailjs.com') ||
    url.hostname.includes('googleapis.com');

  if (isExternal) return;

  // index.html: altid network-first for at få nye versioner
  if (event.request.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html').then(c => c || new Response('Offline', {status:503})))
    );
    return;
  }

  // sw.js: aldrig cache — hent altid fra netværk
  if (url.pathname.endsWith('sw.js')) return;

  // Alt andet: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
        }
        return response;
      }).catch(() => new Response('Offline', {status:503}));
    })
  );
});
