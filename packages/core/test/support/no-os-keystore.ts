// Vitest setup: the default key stores run their tools through this runner, which starts nothing and answers as if
// the tool were not installed. A test that wants a store passes its own fake runner.
import { replaceSystemRunner } from "../../src/adapters/keystore/index.ts";

replaceSystemRunner(async () => ({ code: null, stdout: "", stderr: "", missing: true }));
