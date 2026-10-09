import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url));

// The owner UI's components, rendered into happy-dom. Shared pieces come from packages/ui by alias, on this
// project's own Preact (dedupe), so both dashboards ship one copy of it.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  resolve: { alias: [{ find: /^@muhmdraouf\/ui\/(.*)$/, replacement: `${shared}/$1` }], dedupe: ["preact"] },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx"],
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
