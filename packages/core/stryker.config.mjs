// Stryker's vitest runner never activates mutants under Vitest 5, and TypeScript 7 has no compiler JS API for the
// checker, so mutants are judged by the command runner: one `vitest run` of the domain suite per mutant (a mutant is
// killed when the run exits non-zero). The tsconfigFile points at a file that does not exist, so Stryker leaves the
// real tsconfig.json alone instead of rewriting it through the TypeScript API.
export default {
  testRunner: "command",
  commandRunner: { command: "npx vitest run test/domain --reporter=dot --silent" },
  tsconfigFile: "stryker.no-tsconfig.json",
  mutate: ["src/domain/**/*.ts"],
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ["clear-text", "progress"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
