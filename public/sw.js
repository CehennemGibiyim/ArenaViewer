/* AtikViewer hizmet işçisi (PWA): yalnızca statik varlıkları önbelleğe alır.
 *
 * Klinik veri asla önbelleğe alınmaz: /api, /paylas ve rapor sayfaları ağdan
 * gelir. Bu sayede çevrimdışı açılışta eski hasta bilgisi gösterilmez; açılış
 * kabuğu (statik shell) çevrimdışı da çalışır.
 */
const VERSION = "atikviewer-v1";
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const SHELL = ["/giris", "/icons/icon-192.png", "/icons/icon-512.png", "/offline.html"];
const STATIC_PREFIXES = ["/_next/static/", "/wasm/", "/codecs/", "/icons/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  const url = new URL(req.url);

  // Klinik/uzak kaynak: hiçbir şekilde önbelleğe yazma.
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/paylas") || url.pathname === "/cevrimdisi") return;

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
      ),
    );
    return;
  }

  // Sayfa gezinmesi: ağdan al; sadece statik kabuk çevrimdışıda kullanılabilir.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/giris").then((r) => r || caches.match("/offline.html"))),
    );
  }
});
