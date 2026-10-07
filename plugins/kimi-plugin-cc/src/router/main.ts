// kimi-router: lets Claude Code subagents run on Kimi. Point Claude Code at it (ANTHROPIC_BASE_URL) and every request
// whose model is `kimi-*` goes to Moonshot AI with the kimi key, while every other request goes to Anthropic untouched.
//   kimi-router run | start | stop | status   (the plugin starts it as one background process and its hooks keep it up)
import { stateRoot } from "@muhmdraouf/core/adapters/state-root.ts";
import { routerService } from "@muhmdraouf/core/router/service.ts";
import { KIMI_PROVIDER } from "../provider.ts";

process.exitCode = await routerService({
  provider: KIMI_PROVIDER,
  stateRoot: stateRoot(KIMI_PROVIDER, process.env),
  // This very script: the front forks it as its worker, and `start` copies it (and its passthrough) into the state root.
  script: process.argv[1] ?? "",
  env: process.env,
  argv: process.argv,
});
