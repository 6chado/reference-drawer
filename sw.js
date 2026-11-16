// Serves "_blob/<driveFileId>" image requests from the signed-in user's Google Drive,
// keeping a permanent local copy so each picture downloads only once.
const IMG_CACHE = "ref-drawer-img-v1";
const TOKEN_KEY = "/__ref_token__";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("message", e => {
  if (e.data && e.data.type === "token") {
    e.waitUntil(caches.open(IMG_CACHE).then(c => c.put(TOKEN_KEY, new Response(e.data.token || ""))));
  }
});

async function token() {
  const c = await caches.open(IMG_CACHE);
  const r = await c.match(TOKEN_KEY);
  return r ? r.text() : "";
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  const m = url.pathname.match(/\/_blob\/([A-Za-z0-9_-]+)$/);
  if (!m || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(IMG_CACHE);
    const key = "/__img__/" + m[1];
    const hit = await c.match(key);
    if (hit) return hit;
    const t = await token();
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${m[1]}?alt=media`, { headers: { Authorization: "Bearer " + t } });
    if (r.ok) {
      const blob = await r.blob();
      const res = new Response(blob, { headers: { "Content-Type": r.headers.get("Content-Type") || "image/jpeg" } });
      c.put(key, res.clone());
      return res;
    }
    return new Response("", { status: r.status });
  })());
});
