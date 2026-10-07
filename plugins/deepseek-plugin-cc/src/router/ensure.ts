// deepseek-ensure: the UserPromptSubmit and SubagentStart hook. A 100 ms check that the deepseek router still answers; only
// when it does not, `deepseek-router.js start` goes out detached. Never prints, always exits 0.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRouter } from "@muhmdraouf/core/router/ensure.ts";
import { DEEPSEEK_PROVIDER } from "../provider.ts";

try {
  await ensureRouter({
    name: DEEPSEEK_PROVIDER.name,
    envPrefix: DEEPSEEK_PROVIDER.envPrefix,
    defaultPort: DEEPSEEK_PROVIDER.router.port,
    env: process.env,
    routerScript: join(dirname(fileURLToPath(import.meta.url)), "deepseek-router.js"),
  });
} catch {
  // A hook must never fail a prompt.
}
process.exit(0);
