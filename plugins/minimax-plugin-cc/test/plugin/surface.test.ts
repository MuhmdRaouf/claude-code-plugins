// The commands, agents and hooks minimax ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/core/testing";
import { MINIMAX_PROVIDER } from "../../src/provider.ts";

describePluginSurface({ provider: MINIMAX_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
