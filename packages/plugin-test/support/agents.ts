import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Provider } from "./provider.ts";

/** The agents beside the plugin's dist, `model: sonnet` as the plugin ships them, so setup's rewrite has something
 *  to hit. */
export function writeAgents(bundlePath: string, provider: Provider, model = "sonnet"): void {
  const dir = join(dirname(bundlePath), "..", "agents");
  mkdirSync(dir, { recursive: true });
  for (const tier of ["main", "flash"] as const) {
    writeFileSync(join(dir, `${provider.agents[tier]}.md`), `model: ${model}\n`);
  }
}
