// Setup's key step: move a key file's key into the OS store, and when there is no key (or the provider refuses it)
// open the one-time page and wait for the store to fill. A key from the environment is the user's own: left alone.

import type { KeyEntry, KeyStore, ProviderKey } from "../../ports/keys.ts";
import type { Invocation } from "../command.ts";
import { EXIT, type ExitCode } from "../exit.ts";

export const ENTRY_WAIT_MS = 90_000;
const ENTRY_POLL_MS = 1000;

type Say = (text: string) => void;

function sayer(call: Invocation): Say {
  // Under --json stdout carries one JSON document: progress lines go to stderr.
  return call.flag("json") ? (text) => call.deps.out.error(text) : (text) => call.deps.out.line(text);
}

/** Undefined: go on with setup. An exit code: setup ends here (the page is open, nobody finished in time). */
export async function ensureKey(call: Invocation): Promise<ExitCode | undefined> {
  const { host, provider } = call.deps;
  const entry = host.keyEntry;
  if (entry === undefined) return undefined;
  const loaded = await host.loadKey();
  if (loaded.ok && provider.keyEnv.includes(loaded.value.source)) return undefined;
  if (!loaded.ok && loaded.error.kind !== "no_key") return undefined;
  const say = sayer(call);
  const store = await entry.store();
  if (!loaded.ok) return enterKey(call, entry, store, say, undefined);
  if (store.kind !== "file" && loaded.value.source !== store.label)
    await migrate(entry, store, loaded.value, say);
  const verdict = await entry.check(loaded.value.value);
  if (verdict === "limited")
    say(
      `key: ${provider.display} knows the key but is not taking requests with it yet (a rate limit, or no balance left: top up at ${provider.billingUrl})`,
    );
  if (verdict !== "refused") return undefined;
  say(`key: ${provider.display} refused the stored key; enter a new one.`);
  return enterKey(call, entry, store, say, loaded.value.value);
}

/** Opens the page and polls the store each second for up to 90 s for a key other than the refused one. */
async function enterKey(
  call: Invocation,
  entry: KeyEntry,
  store: KeyStore,
  say: Say,
  refused: string | undefined,
): Promise<ExitCode | undefined> {
  const { provider, clock } = call.deps;
  const opened = await entry.openPage();
  if (!opened.ok) {
    say(`key: cannot open the key page (${opened.error})`);
    return undefined;
  }
  say(`Enter your ${provider.display} key on this one-time page on this machine (never in the chat):`);
  say(`  ${opened.value}`);
  const deadline = clock.now() + ENTRY_WAIT_MS;
  while (clock.now() < deadline) {
    await clock.sleep(ENTRY_POLL_MS);
    const current = await store.get().catch(() => undefined);
    if (current !== undefined && current !== refused) {
      say(`key: saved in ${store.label}`);
      return undefined;
    }
  }
  say(`Finish in the browser, then run ${provider.slash}setup again.`);
  return EXIT.notReady;
}

/** File → store, confirmed by a read-back before the file's line goes. A failure keeps the file as it was. */
async function migrate(entry: KeyEntry, store: KeyStore, key: ProviderKey, say: Say): Promise<void> {
  try {
    await store.set(key.value);
    if ((await store.get()) !== key.value) throw new Error(`${store.label} did not return the key`);
  } catch (error) {
    say(`key: kept in ${key.source}: ${error instanceof Error ? error.message : "store failed"}`);
    return;
  }
  const removed = await entry.removeFromFile(key.value);
  say(`key: moved from ${key.source} to ${store.label}${removed ? "" : " (the file line was already gone)"}`);
}

/** `setup --remove`: the key leaves the store too. */
export async function removeStoredKey(call: Invocation): Promise<void> {
  const entry = call.deps.host.keyEntry;
  if (entry === undefined) return;
  const say = sayer(call);
  const store = await entry.store();
  try {
    await store.remove();
    say(`key: removed from ${store.label}`);
  } catch (error) {
    say(
      `key: FAILED to remove from ${store.label}: ${error instanceof Error ? error.message : "store failed"}`,
    );
  }
}
