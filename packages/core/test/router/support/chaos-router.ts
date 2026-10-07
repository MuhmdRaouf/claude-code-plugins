// The chaos suite's router entry: what a plugin's src/router/main.ts is, for the chaos provider. Run by node directly
// (type stripping) through a one-line `chaos-router.js` wrapper the suite writes, as a front and as its worker.
import { stateRoot } from "../../../src/adapters/state-root.ts";
import { routerService } from "../../../src/router/service.ts";
import { CHAOS_PROVIDER } from "./chaos-provider.ts";

process.exitCode = await routerService({
  provider: CHAOS_PROVIDER,
  stateRoot: stateRoot(CHAOS_PROVIDER, process.env),
  script: process.argv[1] ?? "",
  env: process.env,
  argv: process.argv,
});
