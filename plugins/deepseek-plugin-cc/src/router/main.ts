// deepseek-router: lets Claude Code subagents run on DeepSeek. Point Claude Code at it (ANTHROPIC_BASE_URL) and every request
// whose model is `deepseek-*` goes to DeepSeek with the deepseek key, while every other request goes to Anthropic untouched.
//   deepseek-router run | start | stop | status   (the plugin starts it as one background process and its hooks keep it up)
import { stateRoot } from "@muhmdraouf/core/adapters/state-root.ts";
import { routerService } from "@muhmdraouf/core/router/service.ts";
import { DEEPSEEK_PROVIDER } from "../provider.ts";

process.exitCode = await routerService({
  provider: DEEPSEEK_PROVIDER,
  stateRoot: stateRoot(DEEPSEEK_PROVIDER, process.env),
  // This very script: the front forks it as its worker, and `start` copies it (and its passthrough) into the state root.
  script: process.argv[1] ?? "",
  env: process.env,
  argv: process.argv,
});
