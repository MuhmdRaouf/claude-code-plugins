// The commands, agents and hooks deepseek ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/plugin-test/testing";
import { DEEPSEEK_PROVIDER } from "../provider.ts";

describePluginSurface({ provider: DEEPSEEK_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
