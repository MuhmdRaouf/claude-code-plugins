// kimi-ensure: the UserPromptSubmit and SubagentStart hook. A 100 ms check that the kimi router still answers; only
// when it does not, `kimi-router.js start` goes out detached. Never prints, always exits 0.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRouter } from "@muhmdraouf/core/router/ensure.ts";
import { KIMI_PROVIDER } from "../provider.ts";

try {
  await ensureRouter({
    name: KIMI_PROVIDER.name,
    envPrefix: KIMI_PROVIDER.envPrefix,
    defaultPort: KIMI_PROVIDER.router.port,
    env: process.env,
    routerScript: join(dirname(fileURLToPath(import.meta.url)), "kimi-router.js"),
  });
} catch {
  // A hook must never fail a prompt.
}
process.exit(0);
