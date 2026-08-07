const CACHE = "p5n-shell-v5";
const SHELL = ["/", "/assets/index.js", "/assets/index.css"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if ((url.pathname === "/" || url.pathname.startsWith("/assets/")) && !url.pathname.includes("/api")) {
    ev.respondWith(
      fetch(ev.request)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            void caches.open(CACHE).then((c) => c.put(ev.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(ev.request)),
    );
  }
});
