// zai-ensure: the UserPromptSubmit and SubagentStart hook. A 100 ms check that the zai router still answers; only
// when it does not, `zai-router.js start` goes out detached. Never prints, always exits 0.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRouter } from "@muhmdraouf/core/router/ensure.ts";
import { ZAI_PROVIDER } from "../provider.ts";

try {
  await ensureRouter({
    name: ZAI_PROVIDER.name,
    envPrefix: ZAI_PROVIDER.envPrefix,
    defaultPort: ZAI_PROVIDER.router.port,
    env: process.env,
    routerScript: join(dirname(fileURLToPath(import.meta.url)), "zai-router.js"),
  });
} catch {
  // A hook must never fail a prompt.
}
process.exit(0);
