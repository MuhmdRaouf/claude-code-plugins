// The freedesktop Secret Service (GNOME Keyring, KWallet) through secret-tool. `store` reads the secret from stdin.

import type { KeyStore } from "../../ports/keys.ts";
import { assertValidKey, type KeyIdentity, type Runner, storeFailure, trimNewline } from "./port.ts";

const SECRET_TOOL = "secret-tool";
const LABEL = "Secret Service";

export function linuxKeyStore(id: KeyIdentity, run: Runner): KeyStore {
  const attributes = ["service", id.service, "account", id.account];
  const lookup = () => run(SECRET_TOOL, ["lookup", ...attributes]);
  return {
    kind: "linux",
    label: LABEL,
    async available() {
      const result = await lookup();
      if (result.missing === true) return false;
      // Exit 1 with nothing on stderr is "no such secret"; a D-Bus or "no secret service" failure says why on stderr.
      return result.code === 0 || (result.code === 1 && result.stderr.trim() === "");
    },
    async get() {
      const result = await lookup();
      if (result.code !== 0) return undefined;
      return trimNewline(result.stdout) || undefined;
    },
    async set(key) {
      assertValidKey(key);
      // No trailing newline: secret-tool stores stdin up to EOF as it is.
      const result = await run(SECRET_TOOL, ["store", `--label=${id.display} API key`, ...attributes], key);
      if (result.code !== 0) throw storeFailure(LABEL, "store", result);
    },
    async remove() {
      const result = await run(SECRET_TOOL, ["clear", ...attributes]);
      if (result.missing === true) throw storeFailure(LABEL, "remove", result);
    },
  };
}
