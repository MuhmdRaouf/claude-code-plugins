// The real macOS Keychain, end to end: set, read, update, remove a throwaway item through /usr/bin/security. The
// platform tests prove the command lines; this proves `security` accepts them. It touches the login keychain, so it
// runs only where KEYSTORE_ROUNDTRIP=1 says so (CI's macOS job), never on a developer's machine by accident.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { spawnRunner } from "../../../src/adapters/keystore/index.ts";
import { macosKeyStore } from "../../../src/adapters/keystore/macos.ts";

const enabled = process.env.KEYSTORE_ROUNDTRIP === "1" && process.platform === "darwin";

describe.runIf(enabled)("the macOS Keychain, for real", () => {
  it("stores, updates, reads back and removes a key; the item is gone afterwards", async () => {
    const id = {
      service: `muhmdraouf-ci-${randomBytes(6).toString("hex")}`,
      account: "roundtrip",
      display: "CI round trip",
    };
    const store = macosKeyStore(id, spawnRunner);
    const first = `ci-${randomBytes(12).toString("hex")}`;
    const second = `ci-${randomBytes(12).toString("hex")}`;
    try {
      expect(await store.available()).toBe(true);
      expect(await store.get()).toBeUndefined();
      await store.set(first);
      expect(await store.get()).toBe(first);
      await store.set(second);
      expect(await store.get()).toBe(second);
    } finally {
      await store.remove();
    }
    expect(await store.get()).toBeUndefined();
  });
});
