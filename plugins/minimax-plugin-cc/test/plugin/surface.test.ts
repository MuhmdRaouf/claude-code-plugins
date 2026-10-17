// The commands, agents and hooks minimax ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/plugin-test/testing";
import { MINIMAX_PROVIDER } from "../provider.ts";

describePluginSurface({ provider: MINIMAX_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
