// Version 19 - keyboard PIN support + offline fix
const CACHE = "driften-v19";
const APP_SHELL = ["./","./index.html","./manifest.json"];

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

  // Network-first for app shell: prøv netværk først (3 sek timeout),
  // fald tilbage på cache. Dette sikrer at ny index.html altid hentes
  // når online, og cache bruges som fallback ved offline.
  e.respondWith(
    new Promise(async (resolve) => {
      const cache = await caches.open(CACHE);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const networkRes = await fetch(e.request, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (networkRes && networkRes.ok) {
          cache.put(e.request, networkRes.clone());
          resolve(networkRes);
        } else {
          const cached = await cache.match(e.request);
          resolve(cached || networkRes);
        }
      } catch {
        const cached = await cache.match(e.request);
        resolve(cached || new Response(
          "<h1>Offline</h1><p>Åbn appen mens du har forbindelse mindst én gang først.</p>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        ));
      }
    })
  );
});
