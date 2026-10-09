// minimax-router: lets Claude Code subagents run on MiniMax. Point Claude Code at it (ANTHROPIC_BASE_URL) and every request
// whose model is `MiniMax-*` goes to MiniMax with the minimax key, while every other request goes to Anthropic untouched.
//   minimax-router run | start | stop | status   (the plugin starts it as one background process and its hooks keep it up)
import { stateRoot } from "@muhmdraouf/core/adapters/state-root.ts";
import { routerService } from "@muhmdraouf/core/router/service.ts";
import { MINIMAX_PROVIDER } from "../provider.ts";

process.exitCode = await routerService({
  provider: MINIMAX_PROVIDER,
  stateRoot: stateRoot(MINIMAX_PROVIDER, process.env),
  // This very script: the front forks it as its worker, and `start` copies it (and its passthrough) into the state root.
  script: process.argv[1] ?? "",
  env: process.env,
  argv: process.argv,
});
