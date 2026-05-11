import { defineConfig } from "vitest/config";

// Benchmark runner. Standalone perf measurements. Invoke via `npm run bench`.
export default defineConfig({
  test: {
    include: ["src/**/*.bench.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    reporters: ["verbose"],
    testTimeout: 120_000,
  },
});
