// The commands, agents and hooks zai ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/core/testing";
import { ZAI_PROVIDER } from "../../src/provider.ts";

describePluginSurface({ provider: ZAI_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
