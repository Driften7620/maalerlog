// Version 5 - rettet "Returned response is null" fejl i flytilstand
const CACHE = "driften-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      // Cache hver fil for sig, så én fejlende ressource ikke vælter hele cachingen
      // (cache.addAll() fejler ALT hvis bare én fil ikke kan hentes)
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

  // Firebase-data og eksterne API-kald skal ALTID gå til netværket - aldrig caches.
  // Det sikrer at måler-/lagerdata altid er friskt når der er forbindelse,
  // og at appen ikke utilsigtet viser forældede tal som om de var aktuelle.
  const isDataRequest =
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("workers.dev") ||
    url.hostname.includes("qrserver.com");

  if (isDataRequest) {
    // Returnér altid et gyldigt Response - aldrig undefined/null, ellers fejler Safari hårdt
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response("", { status: 503, statusText: "Offline" })
      )
    );
    return;
  }

  // App-skal (HTML/CSS/JS/manifest): cache-first med netværks-opdatering i baggrunden.
  // Virker offline med det samme; opdaterer sig selv stille når der er forbindelse igen.
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
        // Har vi noget i cachen, brug det med det samme og opdater i baggrunden
        networkFetch.catch(() => {});
        return cached;
      }
      // Intet i cachen - vent på netværket, og giv et eksplicit svar hvis det også fejler
      return networkFetch.then(res =>
        res || new Response(
          "<h1>Offline</h1><p>Denne side er ikke tilgængelig uden internetforbindelse endnu. Åbn appen mens du har forbindelse mindst én gang først.</p>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        )
      );
    })
  );
});

