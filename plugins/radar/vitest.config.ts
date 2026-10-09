import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("../../packages/ui/src", import.meta.url));

const coverage = {
  provider: "v8" as const,
  include: ["src/**/*.{ts,tsx}"],
  // Entry points are thin glue around tested logic (same call as zai's mains).
  exclude: ["src/cli/main.ts", "src/hook/main.ts", "src/ui/main.tsx", "src/ui/jsx.d.ts"],
  thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
};

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  // The owner UI's markdown, by alias, on this project's own Preact (dedupe) — huddle does the same.
  resolve: { alias: [{ find: /^@muhmdraouf\/ui\/(.*)$/, replacement: `${shared}/$1` }], dedupe: ["preact"] },
  test: {
    testTimeout: 60_000,
    coverage,
    projects: [
      // server, CLI, hooks and the pure UI logic: plain Node
      { extends: true, test: { name: "node", include: ["test/**/*.test.ts"], environment: "node" } },
      // Preact components, rendered into happy-dom
      {
        extends: true,
        test: {
          name: "ui",
          include: ["test/**/*.test.tsx"],
          environment: "happy-dom",
          setupFiles: ["test/ui/setup.ts"],
        },
      },
    ],
  },
});
