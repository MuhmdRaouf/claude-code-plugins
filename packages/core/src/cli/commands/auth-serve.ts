// `auth-serve`: internal. Setup starts it detached; it prints the page URL as its only output line, serves the page
// until the key is saved (exit 0), 10 minutes pass or 5 tries fail (exit 6), and never prints anything else.
import { writableKeyStore } from "../../adapters/keystore/index.ts";
import { checkKey } from "../../auth-page/check.ts";
import { startAuthPage } from "../../auth-page/server.ts";
import type { Command } from "../command.ts";
import { EXIT } from "../exit.ts";

export const authServeCommand: Command = {
  name: "auth-serve",
  synopsis: ["auth-serve"],
  options: {},
  hidden: true,
  async run(call) {
    const { provider, env, out } = call.deps;
    const store = await writableKeyStore(provider, env);
    const page = await startAuthPage({
      display: provider.display,
      billingUrl: provider.billingUrl,
      storeLabel: store.label,
      check: (key) => checkKey(provider, key),
      save: (key) => store.set(key),
    });
    out.line(page.url);
    return (await page.done) === "saved" ? EXIT.ok : EXIT.notReady;
  },
};
