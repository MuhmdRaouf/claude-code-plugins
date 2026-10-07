// What setup needs to get a key in without the chat: the store to fill, a key check, the one-time page (started
// detached, then opened in the browser), and the key file's line to retire after a migration.
import { spawn } from "node:child_process";
import {
  keyFilePath,
  type PlatformOptions,
  removeKeyLine,
  writableKeyStore,
} from "../adapters/keystore/index.ts";
import { startDetached } from "../adapters/process/detached.ts";
import type { Provider } from "../domain/provider.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { KeyEntry } from "../ports/keys.ts";
import { checkKey } from "./check.ts";

/** Starts `node <bundle> auth-serve` detached and resolves its first stdout line, the URL. */
type PageLauncher = (
  bundlePath: string,
  env: Readonly<Record<string, string | undefined>>,
) => Promise<Result<string, string>>;
/** Opens a URL in the user's browser, detached; a failure only leaves the printed URL. */
type UrlOpener = (url: string) => void;

interface KeyEntryOptions extends PlatformOptions {
  readonly provider: Provider;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bundlePath: string;
  readonly launch?: PageLauncher;
  readonly openUrl?: UrlOpener;
  readonly fetchImpl?: typeof fetch;
}

const LAUNCH_TIMEOUT_MS = 15_000;

export function createKeyEntry(options: KeyEntryOptions): KeyEntry {
  const { provider, env } = options;
  const launch = options.launch ?? launchPage;
  const openUrl =
    options.openUrl ?? ((url: string) => openInBrowser(url, options.platform ?? process.platform));
  return {
    store: () => writableKeyStore(provider, env, options),
    check: (key) => checkKey(provider, key, options.fetchImpl),
    async openPage() {
      const launched = await launch(options.bundlePath, env);
      if (launched.ok) openUrl(launched.value);
      return launched;
    },
    removeFromFile: (value) => removeKeyLine(provider, keyFilePath(provider, env), value),
  };
}

/** The page's URL is the first line `auth-serve` prints; the server then runs on its own, outliving setup. */
export const launchPage: PageLauncher = (bundlePath, env) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [bundlePath, "auth-serve"], {
      detached: true,
      env: { ...env },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let text = "";
    const finish = (result: Result<string, string>) => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.unref();
      done(result);
    };
    const timer = setTimeout(() => finish(err("the key page did not start in time")), LAUNCH_TIMEOUT_MS);
    child.on("error", () => finish(err("cannot start the key page")));
    child.on("exit", () => finish(err("the key page exited before it started")));
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      const line = text.split("\n")[0] ?? "";
      if (text.includes("\n") && /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/.test(line.trim()))
        finish(ok(line.trim()));
      else if (text.includes("\n")) finish(err("the key page printed no URL"));
    });
  });

/** `open` on macOS, `xdg-open` on Linux, `cmd /c start ""` on Windows; detached, output ignored, errors swallowed. */
export function openInBrowser(url: string, platform: NodeJS.Platform, start = startDetached): void {
  const opener: readonly [string, readonly string[]] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  try {
    // Verbatim on Windows, so cmd sees `start "" <url>` and not escaped quotes; the URL holds no cmd metacharacters.
    start(opener[0], opener[1], { verbatim: platform === "win32" });
  } catch {
    // No opener: the printed URL is the way in.
  }
}
