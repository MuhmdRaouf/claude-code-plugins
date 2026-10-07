// The commands, agents and hooks qwen ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/core/testing";
import { QWEN_PROVIDER } from "../../src/provider.ts";

describePluginSurface({ provider: QWEN_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
