const CACHE = "maalerlog-v1";
const ASSETS = [
"/maalerlog/",
"/maalerlog/index.html",
"/maalerlog/manifest.json"
];

self.addEventListener("install", e => {
e.waitUntil(
caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
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
// Kun cache GET requests til egne filer
if (e.request.method !== "GET") return;
if (e.request.url.includes("firebasedatabase")) return;
if (e.request.url.includes("api.qrserver")) return;
if (e.request.url.includes("anthropic")) return;

e.respondWith(
fetch(e.request)
.then(response => {
const clone = response.clone();
caches.open(CACHE).then(c => c.put(e.request, clone));
return response;
})
.catch(() => caches.match(e.request))
);
});
