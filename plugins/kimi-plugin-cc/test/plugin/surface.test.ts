// The commands, agents and hooks kimi ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/core/testing";
import { KIMI_PROVIDER } from "../../src/provider.ts";

describePluginSurface({ provider: KIMI_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
