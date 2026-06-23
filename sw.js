// Version 22 - offline fix baseret på v17
const CACHE = "driften-v22";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      await Promise.all(APP_SHELL.map(url =>
        cache.add(url).catch(err => console.warn("Kunne ikke cache", url, err))
      ));
    })
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

  const isDataRequest =
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("workers.dev") ||
    url.hostname.includes("qrserver.com") ||
    url.hostname.includes("open-meteo.com") ||
    url.hostname.includes("energidataservice.dk") ||
    url.hostname.includes("githubusercontent.com");

  if (isDataRequest) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request)
        .then(res => {
          if (res && res.ok) {
            const resClone = res.clone();
            caches.open(CACHE).then(cache => cache.put(e.request, resClone));
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        networkFetch.catch(() => {});
        return cached;
      }
      return networkFetch.then(res =>
        res || new Response(
          "<h1>Offline</h1><p>Åbn appen mens du har forbindelse mindst én gang først.</p>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        )
      );
    })
  );
});
