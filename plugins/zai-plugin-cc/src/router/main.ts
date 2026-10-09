// zai-router: lets Claude Code subagents run on GLM. Point Claude Code at it (ANTHROPIC_BASE_URL) and every request
// whose model is `glm-*` goes to Z.ai with the zai key, while every other request goes to Anthropic untouched.
//   zai-router run | start | stop | status   (the plugin starts it as one background process and its hooks keep it up)
import { stateRoot } from "@muhmdraouf/core/adapters/state-root.ts";
import { routerService } from "@muhmdraouf/core/router/service.ts";
import { ZAI_PROVIDER } from "../provider.ts";

process.exitCode = await routerService({
  provider: ZAI_PROVIDER,
  stateRoot: stateRoot(ZAI_PROVIDER, process.env),
  // This very script: the front forks it as its worker, and `start` copies it (and its passthrough) into the state root.
  script: process.argv[1] ?? "",
  env: process.env,
  argv: process.argv,
});
