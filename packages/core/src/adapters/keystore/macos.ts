// macOS Keychain through /usr/bin/security. Writes and deletes go through `security -i`, which reads its command line
// from stdin, so the key never reaches argv (where `ps` would show it). Reads print the password on stdout.

import type { KeyStore } from "../../ports/keys.ts";
import { assertValidKey, type KeyIdentity, type Runner, storeFailure, trimNewline } from "./port.ts";

export const SECURITY = "/usr/bin/security";
const LABEL = "macOS Keychain";

export function macosKeyStore(id: KeyIdentity, run: Runner): KeyStore {
  const where = `-s "${id.service}" -a "${id.account}"`;
  const read = () => run(SECURITY, ["find-generic-password", "-s", id.service, "-a", id.account, "-w"]);
  return {
    kind: "macos",
    label: LABEL,
    async available() {
      const result = await run(SECURITY, ["default-keychain"]);
      return result.missing !== true && result.code === 0;
    },
    async get() {
      const result = await read();
      if (result.code !== 0) return undefined;
      return trimNewline(result.stdout) || undefined;
    },
    async set(key) {
      assertValidKey(key);
      // `-U` updates an existing item. The key is validated, so the double quotes cannot be broken out of.
      const result = await run(SECURITY, ["-i"], `add-generic-password -U ${where} -w "${key}"\n`);
      // `security -i` may exit 0 after a failed command: only a read-back proves the write.
      const back = await read();
      if (result.code !== 0 || back.code !== 0 || trimNewline(back.stdout) !== key)
        throw storeFailure(LABEL, "store", result.code !== 0 ? result : back);
    },
    async remove() {
      const result = await run(SECURITY, ["-i"], `delete-generic-password ${where}\n`);
      if (result.missing === true) throw storeFailure(LABEL, "remove", result);
    },
  };
}
