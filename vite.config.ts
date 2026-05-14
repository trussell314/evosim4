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
  },
});
