// The OS secret store for a provider's key: picks the platform's store, falls back to the key file where there is
// none, and runs the platform tools through a Runner (the real one spawns them without a shell; tests pass fakes).
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import type { Provider } from "../../domain/provider.ts";
import type { KeyStore } from "../../ports/keys.ts";
import { runTool } from "../process/tool.ts";
import { expandHome, fileKeyStore } from "./file.ts";
import { linuxKeyStore } from "./linux.ts";
import { macosKeyStore } from "./macos.ts";
import { keyIdentity, type Runner } from "./port.ts";
import { windowsKeyStore } from "./windows.ts";

export { fileKeyStore, readKeyFile, removeKeyLine } from "./file.ts";
export { InvalidKeyError, isValidKey, keyIdentity, type Runner, type RunResult } from "./port.ts";

/** A tool that hangs (a keychain waiting on an unlock prompt nobody answers) is killed after this long. */
const TOOL_TIMEOUT_MS = 60_000;

/** Spawns `cmd` directly (no shell), writes `stdin` and closes it, and collects stdout and stderr. A tool that cannot
 *  start resolves `missing`; nothing rejects, and no field carries stdin. */
export const spawnRunner: Runner = async (cmd, args, stdin) => {
  const run = await runTool(cmd, args, {
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs: TOOL_TIMEOUT_MS,
  });
  return run.kind === "missing"
    ? { code: null, stdout: "", stderr: "", missing: true }
    : { code: run.code, stdout: run.stdout.toString("utf8"), stderr: run.stderr.toString("utf8") };
};

let systemRunner: Runner = spawnRunner;

/** The runner every default store uses. Test setup replaces it once, so no test can reach a real OS store; the
 *  previous runner comes back so a test can restore it. */
export function replaceSystemRunner(runner: Runner): Runner {
  const previous = systemRunner;
  systemRunner = runner;
  return previous;
}

export interface PlatformOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: Runner;
  /** The login account's home; the OS store belongs to it. Default: the account database's entry. */
  readonly accountHome?: string;
}

function accountHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

/**
 * The platform's secret store for the provider, or undefined where there is none. A process whose HOME is not the
 * login account's home (a sandbox, a test harness) is a different profile: it gets no OS store, only its key file.
 */
export function platformKeyStore(
  provider: Pick<Provider, "name" | "display">,
  env: Readonly<Record<string, string | undefined>>,
  options: PlatformOptions = {},
): KeyStore | undefined {
  const home = options.accountHome ?? accountHome();
  if (env.HOME !== undefined && resolve(env.HOME) !== resolve(home)) return undefined;
  const id = keyIdentity(provider);
  const run = options.runner ?? systemRunner;
  switch (options.platform ?? process.platform) {
    case "darwin":
      return macosKeyStore(id, run);
    case "linux":
      return linuxKeyStore(id, run);
    case "win32":
      return windowsKeyStore(id, run);
    default:
      return undefined;
  }
}

/** Where setup and the auth page put a key: the platform store when it answers, else the provider's key file. */
export async function writableKeyStore(
  provider: Pick<Provider, "name" | "display" | "keyEnv" | "keyFile">,
  env: Readonly<Record<string, string | undefined>>,
  options: PlatformOptions = {},
): Promise<KeyStore> {
  const platform = platformKeyStore(provider, env, options);
  if (platform !== undefined && (await platform.available())) return platform;
  return fileKeyStore(provider, keyFilePath(provider, env));
}

/** The provider's key file with `~` expanded from the env's HOME. */
export function keyFilePath(
  provider: Pick<Provider, "keyFile">,
  env: Readonly<Record<string, string | undefined>>,
  path: string = provider.keyFile,
): string {
  return expandHome(path, env.HOME ?? homedir());
}
