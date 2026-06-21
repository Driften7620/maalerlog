// Version 6 - data-requests rører vi slet ikke ved, så app'ens egen fejlhåndtering ser ægte netværksfejl
const CACHE = "driften-v6";
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

  // Firebase-data og eksterne API-kald: lad dem passere uberørt til netværket.
  // VIGTIGT: respondWith() kaldes IKKE her. Hvis vi selv leverer et erstatnings-svar
  // ved netværksfejl, ser app'ens egen fbG()/fbGS() en "vellykket" 503-besked i stedet
  // for en rigtig netværks-exception - det forvirrer app'ens online/offline-logik
  // (den tror fejlagtigt den er online, fordi fetch() ikke kastede en fejl).
  // Ved bare ikke at gøre noget her, opfører requesten sig som om Service Workeren
  // slet ikke var der, og app'ens eksisterende try/catch fanger fejlen korrekt.
  const isDataRequest =
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("workers.dev") ||
    url.hostname.includes("qrserver.com");

  if (isDataRequest) return;

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

