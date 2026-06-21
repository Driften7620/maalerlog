// Version 4 - app-skal caches til offline brug, data hentes altid friskt online
const CACHE = "driften-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Firebase-data og eksterne API-kald skal ALTID gå til netværket - aldrig caches.
  // Det sikrer at måler-/lagerdata altid er friskt når der er forbindelse,
  // og at appen ikke utilsigtet viser forældede tal som om de var aktuelle.
  const isDataRequest =
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("workers.dev") ||
    url.hostname.includes("qrserver.com");

  if (isDataRequest) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App-skal (HTML/CSS/JS/manifest): cache-first med netværks-opdatering i baggrunden.
  // Virker offline med det samme; opdaterer sig selv stille når der er forbindelse igen.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, resClone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
