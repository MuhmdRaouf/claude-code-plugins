// deepseek-passthrough: the emergency passthrough `deepseek-router start` falls back to when the main router cannot start (a
// broken update, a missing module). Built from Node built-ins only: every non-deepseek request goes to Anthropic untouched.
import { modelClaim, resolveProvider } from "@muhmdraouf/core/domain/provider.ts";
import { runEmergency } from "@muhmdraouf/core/router/emergency.ts";
import { DEEPSEEK_PROVIDER } from "../provider.ts";

const provider = resolveProvider(DEEPSEEK_PROVIDER, process.env);
await runEmergency(
  {
    name: provider.name,
    display: provider.display,
    envPrefix: provider.envPrefix,
    healthPath: provider.router.healthPath,
    port: provider.router.port,
    claim: modelClaim(provider),
  },
  process.env,
);
