import { defineConfig } from "vitest/config";

const CHAOS = "test/router/chaos.test.ts";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // No test reaches a real OS secret store: every default store runs its tools through a refusing fake.
    setupFiles: ["test/support/no-os-keystore.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Process entry glue, run for real (in child processes) by the router chaos suite.
      exclude: ["src/router/service.ts", "src/router/worker.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        "src/domain/**": { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
    projects: [
      // `extends` merges include lists, so each project names its own files and the root names none.
      { extends: true, test: { name: "unit", include: ["test/**/*.test.ts"], exclude: [CHAOS] } },
      // The chaos suite times real router processes: it runs alone, after every other file has finished, so no
      // sibling fork spawning its own processes competes with it for the CPU.
      {
        extends: true,
        test: { name: "chaos", include: [CHAOS], fileParallelism: false, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
