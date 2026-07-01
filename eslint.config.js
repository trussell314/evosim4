// ESLint flat config -- SCOPED to the import-cycle gate only (it replaces
// `madge --circular` as the project's cycle check). We deliberately do NOT
// turn on the full typescript-eslint ruleset here; the only job of this
// config is to fail CI when a runtime import cycle is introduced. The win
// over madge: `import type` back-edges are allowed (erased at compile
// time, so they can't cause a runtime cycle), which lets modules carry
// lean type-only references without a false-positive cycle.

import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    plugins: { "import-x": importX },
    // We only run the cycle rule here, so don't flag the codebase's
    // existing inline `eslint-disable` directives (for rules this config
    // doesn't enable) as unused.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: false },
    },
    settings: {
      // no-cycle re-parses each *imported* file to follow the graph, so it
      // must use the TS parser for .ts files (else it silently sees no
      // imports in them and never finds a cycle).
      "import-x/parsers": { "@typescript-eslint/parser": [".ts", ".tsx"] },
      "import-x/resolver-next": [
        // TS-aware resolver: maps extensionless "./foo" -> foo.ts so the
        // cycle rule can actually follow the import graph.
        createTypeScriptImportResolver({ project: "./tsconfig.json" }),
      ],
    },
    rules: {
      // import-x/no-cycle skips type-only imports by default (they are
      // erased at compile time, so a type-only back-edge can't form a
      // runtime cycle) -- which is exactly the latitude we wanted over
      // madge's purely structural check.
      "import-x/no-cycle": ["error", { maxDepth: Infinity, ignoreExternal: true }],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "scripts/**", "*.config.*"],
  },
);
