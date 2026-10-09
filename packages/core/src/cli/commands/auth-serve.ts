// `auth-serve`: internal. Setup starts it detached; it prints the page URL as its only output line, serves the page
// until the key is saved (exit 0), 10 minutes pass or 5 tries fail (exit 6), and never prints anything else.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writableKeyStore } from "../../adapters/keystore/index.ts";
import { checkKey } from "../../auth-page/check.ts";
import { startAuthPage } from "../../auth-page/server.ts";
import type { Command } from "../command.ts";
import { EXIT } from "../exit.ts";

/** The plugin's version from plugin/.claude-plugin/plugin.json beside the bundle's dist/, when it is there. */
export function pluginVersion(bundlePath: string): string | undefined {
  try {
    const manifest = join(dirname(bundlePath), "..", ".claude-plugin", "plugin.json");
    const version: unknown = JSON.parse(readFileSync(manifest, "utf8")).version;
    return typeof version === "string" && /^[\w.+-]{1,32}$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export const authServeCommand: Command = {
  name: "auth-serve",
  synopsis: ["auth-serve"],
  options: {},
  hidden: true,
  async run(call) {
    const { provider, env, out, bundlePath } = call.deps;
    const store = await writableKeyStore(provider, env);
    const version = pluginVersion(bundlePath);
    const page = await startAuthPage({
      plugin: `${provider.name}-plugin-cc`,
      ...(version === undefined ? {} : { version }),
      display: provider.display,
      keysUrl: provider.keysUrl,
      billingUrl: provider.billingUrl,
      storeLabel: store.label,
      check: (key) => checkKey(provider, key),
      save: (key) => store.set(key),
    });
    out.line(page.url);
    return (await page.done) === "saved" ? EXIT.ok : EXIT.notReady;
  },
};
