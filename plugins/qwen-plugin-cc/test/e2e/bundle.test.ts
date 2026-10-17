// The plugin runs the installed plugin-core binary through its dist/run launcher (see
// @muhmdraouf/plugin-test's bundleSmokeSuite).
import { join } from "node:path";
import { bundleSmokeSuite } from "@muhmdraouf/plugin-test/testing";
import { QWEN_PROVIDER } from "../provider.ts";

bundleSmokeSuite({
  provider: QWEN_PROVIDER,
  pluginDir: join(import.meta.dirname, "../../plugin"),
});
