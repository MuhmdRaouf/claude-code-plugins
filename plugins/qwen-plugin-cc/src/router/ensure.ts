// qwen-ensure: the UserPromptSubmit and SubagentStart hook. A 100 ms check that the qwen router still answers; only
// when it does not, `qwen-router.js start` goes out detached. Never prints, always exits 0.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRouter } from "@muhmdraouf/core/router/ensure.ts";
import { QWEN_PROVIDER } from "../provider.ts";

try {
  await ensureRouter({
    name: QWEN_PROVIDER.name,
    envPrefix: QWEN_PROVIDER.envPrefix,
    defaultPort: QWEN_PROVIDER.router.port,
    env: process.env,
    routerScript: join(dirname(fileURLToPath(import.meta.url)), "qwen-router.js"),
  });
} catch {
  // A hook must never fail a prompt.
}
process.exit(0);
