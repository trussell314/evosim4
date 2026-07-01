// Cross-origin isolation shim. Hosts like GitHub Pages don't send
// COOP / COEP headers; without them, crossOriginIsolated is false in
// the page and SharedArrayBuffer is unavailable. This service worker
// intercepts every fetch under its scope and tacks the headers onto
// the response, which is enough to flip crossOriginIsolated to true
// on the next document load.
//
// Lifecycle: registration in main.ts kicks off install; on first
// install we reload the page so the SW is in control of the document
// load; on subsequent loads the SW is already active and the page
// boots into a cross-origin-isolated context.
//
// Same pattern as the well-known gzuidhof/coi-serviceworker library;
// inlined here so we don't pull a runtime dependency.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Bail on cache-only requests we don't own (some bfcache paths).
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[coi-sw] fetch failed:", err);
      }),
  );
});
