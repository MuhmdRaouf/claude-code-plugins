/**
 * A real headless Chromium driven over the DevTools protocol, with no dependency: Node's WebSocket and a spawned
 * browser. Used where only a real browser shows the behaviour (the Origin header a form POST carries). Finds the
 * browser in $KEYPAGE_CHROME, then in Playwright's cache; tests skip when there is none.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SHELLS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
  ],
  linux: ["chrome-headless-shell-linux64/chrome-headless-shell"],
  win32: ["chrome-headless-shell-win64/chrome-headless-shell.exe"],
};

function playwrightCache(env: NodeJS.ProcessEnv): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return join(homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? homedir(), "ms-playwright");
  return join(homedir(), ".cache/ms-playwright");
}

/** A headless Chromium binary, or undefined when this machine has none. */
export function findHeadlessChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.KEYPAGE_CHROME) return existsSync(env.KEYPAGE_CHROME) ? env.KEYPAGE_CHROME : undefined;
  const cache = playwrightCache(env);
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const build of builds)
    for (const shell of SHELLS[process.platform] ?? []) {
      const bin = join(cache, build, shell);
      if (existsSync(bin)) return bin;
    }
  return undefined;
}

type Params = Record<string, unknown>;
interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Params;
  readonly result?: Params;
  readonly error?: { readonly message: string };
  readonly sessionId?: string;
}

/** One tab: navigate, run script, type, screenshot. */
export interface Tab {
  send(method: string, params?: Params): Promise<Params>;
  /** Navigates and resolves once the new page has loaded. */
  goto(url: string): Promise<void>;
  /** The value of a page expression (awaited when it is a promise). */
  evaluate<T>(expression: string): Promise<T>;
  /** Runs `action` and resolves once the navigation it starts has loaded. */
  navigation(action: () => Promise<unknown>): Promise<void>;
  /** Types `text` into the focused element as keyboard input. */
  type(text: string): Promise<void>;
  screenshot(): Promise<Buffer>;
}

export interface Browser {
  tab(options?: { readonly width?: number; readonly height?: number }): Promise<Tab>;
  close(): Promise<void>;
}

const START_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 15_000;

export async function launchBrowser(bin: string): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "keypage-chrome-"));
  const child: ChildProcess = spawn(
    bin,
    [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("the browser did not start in time")), START_TIMEOUT_MS);
    child.on("error", fail);
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
  });

  const socket = new WebSocket(endpoint);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("cannot reach the browser")), { once: true });
  });
  let next = 0;
  const pending = new Map<number, { done(value: Params): void; fail(error: Error): void }>();
  const listeners = new Set<(message: Message) => void>();
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.fail(new Error(message.error.message));
      else waiter?.done(message.result ?? {});
    } else for (const listener of listeners) listener(message);
  });
  const send = (method: string, params: Params = {}, sessionId?: string): Promise<Params> =>
    new Promise((done, fail) => {
      next += 1;
      pending.set(next, { done, fail });
      socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function tab(options: { readonly width?: number; readonly height?: number } = {}): Promise<Tab> {
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    const call = (method: string, params?: Params) => send(method, params, sessionId);
    await call("Page.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: options.width ?? 1024,
      height: options.height ?? 800,
      deviceScaleFactor: 2,
      mobile: (options.width ?? 1024) < 600,
    });
    const loaded = (): Promise<void> =>
      new Promise((done, fail) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          fail(new Error("the page did not load in time"));
        }, LOAD_TIMEOUT_MS);
        const listener = (message: Message) => {
          if (message.sessionId === sessionId && message.method === "Page.loadEventFired") {
            clearTimeout(timer);
            listeners.delete(listener);
            done();
          }
        };
        listeners.add(listener);
      });
    const navigation = async (action: () => Promise<unknown>) => {
      const load = loaded();
      await action();
      await load;
    };
    const evaluate = async <T>(expression: string): Promise<T> => {
      const reply = (await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as { result: { value: T }; exceptionDetails?: { text: string } };
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
      return reply.result.value;
    };
    return {
      send: call,
      goto: (url) => navigation(() => call("Page.navigate", { url })),
      evaluate,
      navigation,
      type: async (text) => {
        await call("Input.insertText", { text });
      },
      screenshot: async () => {
        const { data } = (await call("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
        })) as { data: string };
        return Buffer.from(data, "base64");
      },
    };
  }

  return {
    tab,
    async close() {
      await send("Browser.close").catch(() => undefined);
      socket.close();
      if (child.exitCode === null)
        await new Promise((done) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            done(undefined);
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            done(undefined);
          });
        });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
