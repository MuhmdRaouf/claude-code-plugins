// The plugin runs the built bundle, not src/: it must load and run on its own (see @muhmdraouf/core's
// bundleSmokeSuite). Runs on node in `npm test` and on bun in `npm run test:bun`.
import { join } from "node:path";
import { bundleSmokeSuite } from "@muhmdraouf/core/testing";
import { KIMI_PROVIDER } from "../../src/provider.ts";

bundleSmokeSuite({
  provider: KIMI_PROVIDER,
  pluginDir: join(import.meta.dirname, "../../plugin"),
});
