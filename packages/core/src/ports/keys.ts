// The provider key as the core sees it: where a loaded key came from, the store it lives in at rest, and setup's way to
// get one in. Adapters implement these (adapters/key.ts, adapters/keystore/, auth-page/entry.ts).
import type { Result } from "../domain/result.ts";

/** A loaded key and where it came from, so status lines can name the source without ever showing the key. */
export interface ProviderKey {
  readonly value: string;
  /** The env var that held the key, the store ("macOS Keychain", "Secret Service", "Windows DPAPI"), or the file. */
  readonly source: string;
}

/** Where the provider key lives at rest: the OS secret store, or the 0600 key file when there is none. */
export interface KeyStore {
  readonly kind: "macos" | "linux" | "windows" | "file";
  /** How setup and status lines name the store: "macOS Keychain", "Secret Service", "Windows DPAPI", or a path. */
  readonly label: string;
  available(): Promise<boolean>;
  get(): Promise<string | undefined>;
  /** Rejects an invalid key before any tool runs; throws (without the key) when the store refuses it. */
  set(key: string): Promise<void>;
  remove(): Promise<void>;
}

/** What the provider says to one minimal request with a key. accepted: it answered. limited: it knows the key but
 *  refuses work for now (a rate limit, or an account out of balance): the key is good, the user hears why it will
 *  not work yet. refused: the key itself is wrong. unknown: no answer worth trusting (network, 5xx). */
export type KeyVerdict = "accepted" | "limited" | "refused" | "unknown";

/** Setup's way to get a key in without the chat: the OS store and the one-time page. */
export interface KeyEntry {
  /** The store a key goes to: the OS secret store, or the key file where there is none. */
  store(): Promise<KeyStore>;
  /** One minimal provider request with `key`. */
  check(key: string): Promise<KeyVerdict>;
  /** Starts the one-time page detached and opens it in the browser; ok carries its URL. */
  openPage(): Promise<Result<string, string>>;
  /** Whether the page at `url` still serves: false once it saved a key, timed out, ran out of tries or was closed. */
  pageOpen(url: string): Promise<boolean>;
  /** Removes the key file's line holding `value` (the file too when nothing else is left); whether one went. */
  removeFromFile(value: string): Promise<boolean>;
}
