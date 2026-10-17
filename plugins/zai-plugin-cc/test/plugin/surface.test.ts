// The commands, agents and hooks zai ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/plugin-test/testing";
import { ZAI_PROVIDER } from "../provider.ts";

describePluginSurface({ provider: ZAI_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
