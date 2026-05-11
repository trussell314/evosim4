import { defineConfig } from "vitest/config";

// Smoke-test runner. Long-running simulation scenario; not part of the default
// suite. Invoke explicitly via `npm run test:smoke`.
export default defineConfig({
  test: {
    include: ["src/**/*.smoke.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    reporters: ["verbose"],
    testTimeout: 60_000,
  },
});
