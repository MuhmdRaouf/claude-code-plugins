// The commands, agents and hooks deepseek ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/core/testing";
import { DEEPSEEK_PROVIDER } from "../../src/provider.ts";

describePluginSurface({ provider: DEEPSEEK_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
