// A brand-new user installs the plugin and runs setup, nothing else (see @muhmdraouf/plugin-test's
// freshInstallSuite).
import { join } from "node:path";
import { freshInstallSuite } from "@muhmdraouf/plugin-test/testing";
import { MINIMAX_PROVIDER } from "../provider.ts";

freshInstallSuite({ provider: MINIMAX_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
