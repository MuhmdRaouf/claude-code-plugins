// The chaos suite's emergency passthrough entry, as a plugin's src/router/passthrough.ts is.
import { modelClaim, resolveProvider } from "../../../src/domain/provider.ts";
import { runEmergency } from "../../../src/router/emergency.ts";
import { CHAOS_PROVIDER } from "./chaos-provider.ts";

await runEmergency(
  {
    name: CHAOS_PROVIDER.name,
    display: CHAOS_PROVIDER.display,
    envPrefix: CHAOS_PROVIDER.envPrefix,
    healthPath: CHAOS_PROVIDER.router.healthPath,
    port: CHAOS_PROVIDER.router.port,
    claim: modelClaim(resolveProvider(CHAOS_PROVIDER, process.env)),
  },
  process.env,
);
