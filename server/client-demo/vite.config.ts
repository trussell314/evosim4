import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5174, // distinct from the main app
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
