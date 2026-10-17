// The commands, agents and hooks kimi ships, checked by the shared surface suite every provider plugin runs.
import { join } from "node:path";
import { describePluginSurface } from "@muhmdraouf/plugin-test/testing";
import { KIMI_PROVIDER } from "../provider.ts";

describePluginSurface({ provider: KIMI_PROVIDER, pluginDir: join(import.meta.dirname, "../../plugin") });
