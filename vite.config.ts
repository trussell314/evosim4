import { defineConfig } from "vite";

// COOP / COEP headers gate SharedArrayBuffer behind cross-origin
// isolation. The particle subworker pool only spins up when SAB is
// usable; without these headers the dev server still works, but the
// sim runs single-threaded.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "/evosim4/",
  // Build timestamp (ISO 8601, UTC) baked in at build/dev-server
  // start. Surfaced in the HUD stats line so a deployed page makes
  // clear which build it is.
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // Sourcemaps emit alongside the bundle (foo.js.map). Browsers fetch
    // them on demand from devtools; pages without devtools open pay
    // nothing. Worth the few KB to get readable stack traces in
    // production failures.
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5173,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: { sourcemap: true },
    },
  },
});
