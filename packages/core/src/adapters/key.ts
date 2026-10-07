import type { Provider } from "../domain/provider.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { WorkerError } from "../ports/index.ts";
import type { KeyStore, ProviderKey } from "../ports/keys.ts";
import { keyFilePath, platformKeyStore, readKeyFile } from "./keystore/index.ts";

/** The key-reading slice of a provider: which env vars may hold the key, the key file, the store's names. */
type KeyProvider = Pick<Provider, "name" | "display" | "slash" | "keyEnv" | "keyFile">;

/** The loader's result as a status line sees it: the key's source, or the loader's error. */
export function keySource(loaded: Result<ProviderKey, WorkerError>): Result<string, WorkerError> {
  return loaded.ok ? ok(loaded.value.source) : loaded;
}

/**
 * The provider's key, the one lookup every reader shares (setup, the router service, job workers): env (first of
 * keyEnv that is set), else the OS secret store, else the key file (mode 0600 or stricter), else no_key. The key is
 * returned, never logged. `store` defaults to the platform's; undefined means none.
 */
export async function loadKey(
  provider: KeyProvider,
  env: Readonly<Record<string, string | undefined>>,
  path: string = provider.keyFile,
  store: KeyStore | undefined = platformKeyStore(provider, env),
): Promise<Result<ProviderKey, WorkerError>> {
  for (const name of provider.keyEnv) {
    const fromEnv = env[name]?.trim();
    if (fromEnv) return ok({ value: fromEnv, source: name });
  }
  const stored = await storedKey(store);
  if (stored !== undefined) return ok({ value: stored, source: store?.label ?? "" });
  const file = keyFilePath(provider, env, path);
  const read = await readKeyFile(provider, file);
  if (!read.ok) return read;
  return read.value ? ok({ value: read.value, source: file }) : err(noKey(provider));
}

/** A store that cannot be read (locked, no session bus) is a store without the key: the file still gets its turn. */
async function storedKey(store: KeyStore | undefined): Promise<string | undefined> {
  try {
    return await store?.get();
  } catch {
    return undefined;
  }
}

function noKey(provider: KeyProvider): WorkerError {
  const names = provider.keyEnv.join(" or ");
  return {
    kind: "no_key",
    message: `no ${provider.display} key: export ${names}, or run ${provider.slash}setup to enter it once and keep it in the OS keystore`,
  };
}
