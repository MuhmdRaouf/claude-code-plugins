import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry points and the DOM mount layer are thin glue around tested logic (same call as zai's mains).
      exclude: ["src/cli/main.ts", "src/hook/main.ts", "src/ui/main.ts", "src/ui/dom.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
