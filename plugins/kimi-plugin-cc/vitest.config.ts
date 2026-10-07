import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The four process entry points: each is a few lines wiring the provider into core and runs only as the built
      // bundle in a child process (test/e2e: bundle and fresh-install, on node and bun), where in-process coverage
      // cannot see it. scripts/check-siblings.mjs keeps them identical to zai's modulo the provider's names.
      exclude: ["src/cli/main.ts", "src/router/main.ts", "src/router/passthrough.ts", "src/router/ensure.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
