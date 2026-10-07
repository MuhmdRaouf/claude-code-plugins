// minimax-ensure: the UserPromptSubmit and SubagentStart hook. A 100 ms check that the minimax router still answers; only
// when it does not, `minimax-router.js start` goes out detached. Never prints, always exits 0.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRouter } from "@muhmdraouf/core/router/ensure.ts";
import { MINIMAX_PROVIDER } from "../provider.ts";

try {
  await ensureRouter({
    name: MINIMAX_PROVIDER.name,
    envPrefix: MINIMAX_PROVIDER.envPrefix,
    defaultPort: MINIMAX_PROVIDER.router.port,
    env: process.env,
    routerScript: join(dirname(fileURLToPath(import.meta.url)), "minimax-router.js"),
  });
} catch {
  // A hook must never fail a prompt.
}
process.exit(0);
