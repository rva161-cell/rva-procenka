// Service worker органайзера: минимальный — нужен для установки PWA на телефон
// (Android) и оффлайн-заглушки. Стратегия: сеть first, кэш — только если сеть недоступна.
const CACHE = "rva-organizer-v1";
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;                    // запросы данных — только сеть
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
