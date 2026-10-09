// A brand-new user installs the plugin and runs setup, nothing else (see @muhmdraouf/core's freshInstallSuite). Runs
// on node in `npm test` and on bun in `npm run test:bun`.
import { join } from "node:path";
import { freshInstallSuite } from "@muhmdraouf/core/testing";
import { KIMI_PROVIDER } from "../../src/provider.ts";

freshInstallSuite({ provider: KIMI_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
