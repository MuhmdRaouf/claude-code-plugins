// qwen-router: lets Claude Code subagents run on Qwen. Point Claude Code at it (ANTHROPIC_BASE_URL) and every request
// whose model is `qwen*` goes to Alibaba Cloud with the qwen key, while every other request goes to Anthropic untouched.
//   qwen-router run | start | stop | status   (the plugin starts it as one background process and its hooks keep it up)
import { stateRoot } from "@muhmdraouf/core/adapters/state-root.ts";
import { routerService } from "@muhmdraouf/core/router/service.ts";
import { QWEN_PROVIDER } from "../provider.ts";

process.exitCode = await routerService({
  provider: QWEN_PROVIDER,
  stateRoot: stateRoot(QWEN_PROVIDER, process.env),
  // This very script: the front forks it as its worker, and `start` copies it (and its passthrough) into the state root.
  script: process.argv[1] ?? "",
  env: process.env,
  argv: process.argv,
});
