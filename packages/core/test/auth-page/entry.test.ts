import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DetachedOptions, startDetached } from "../../src/adapters/process/detached.ts";
import { createKeyEntry, launchPage, openInBrowser } from "../../src/auth-page/entry.ts";
import { err, ok } from "../../src/domain/result.ts";
import { FakeRunner, TEST_KEY } from "../support/fake-keystore.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const URL_LINE = "http://127.0.0.1:40123/abc_DEF-123";

/** A stand-in bundle: prints `output`, then lingers a moment (as auth-serve would serve on). */
function bundle(output: string, lingerMs = 300): string {
  const file = join(tempDir(), "fake-bundle.mjs");
  writeFileSync(
    file,
    `if (process.argv[2] !== "auth-serve") process.exit(9);\nprocess.stdout.write(${JSON.stringify(output)});\nsetTimeout(() => {}, ${lingerMs});\n`,
  );
  return file;
}

describe("launchPage", () => {
  it("resolves the URL auth-serve prints first, leaving the server running detached", async () => {
    expect(await launchPage(bundle(`${URL_LINE}\n`), {})).toEqual(ok(URL_LINE));
  });

  it("anything but a 127.0.0.1 page URL, or an early exit, is an error", async () => {
    expect(await launchPage(bundle("http://evil.example/x\n"), {})).toEqual(
      err("the key page printed no URL"),
    );
    expect(await launchPage(bundle("", 0), {})).toEqual(err("the key page exited before it started"));
  });
});

describe("createKeyEntry", () => {
  it("opens the launched page in the browser, and only a launched one", async () => {
    const opened: string[] = [];
    const home = tempDir();
    const entry = createKeyEntry({
      provider: REFERENCE_PROVIDER,
      env: { HOME: home },
      bundlePath: "/plugin/dist/zai.js",
      launch: async (bundlePath) =>
        bundlePath === "/plugin/dist/zai.js" ? ok(URL_LINE) : err("wrong bundle"),
      openUrl: (url) => opened.push(url),
    });
    expect(await entry.openPage()).toEqual(ok(URL_LINE));
    expect(opened).toEqual([URL_LINE]);
    const failing = createKeyEntry({
      provider: REFERENCE_PROVIDER,
      env: { HOME: home },
      bundlePath: "/x",
      launch: async () => err("cannot start the key page"),
      openUrl: (url) => opened.push(url),
    });
    expect(await failing.openPage()).toEqual(err("cannot start the key page"));
    expect(opened).toEqual([URL_LINE]);
  });

  it("stores through the platform store, checks through fetch, and retires the file line", async () => {
    const home = tempDir();
    const runner = new FakeRunner();
    const statuses: number[] = [];
    const entry = createKeyEntry({
      provider: REFERENCE_PROVIDER,
      env: { HOME: home },
      bundlePath: "/x",
      platform: "linux",
      runner: runner.run,
      accountHome: home,
      fetchImpl: async () => {
        statuses.push(401);
        return new Response(null, { status: 401 });
      },
    });
    const store = await entry.store();
    expect(store.label).toBe("Secret Service");
    expect(await entry.check(TEST_KEY)).toBe("refused");
    expect(statuses).toEqual([401]);

    const file = join(home, ".config/zai-plugin-cc/env");
    const sandboxed = createKeyEntry({ provider: REFERENCE_PROVIDER, env: { HOME: home }, bundlePath: "/x" });
    await (await sandboxed.store()).set(TEST_KEY);
    writeFileSync(file, `X=1\nZAI_API_KEY=${TEST_KEY}\n`, { mode: 0o600 });
    expect(await entry.removeFromFile(TEST_KEY)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("X=1\n");
  });
});

describe("openInBrowser", () => {
  it("open on macOS, xdg-open on Linux, cmd /c start on Windows (verbatim); a failure is swallowed", () => {
    const started: { cmd: string; args: readonly string[]; options: DetachedOptions | undefined }[] = [];
    const fake: typeof startDetached = (cmd, args, options) => {
      started.push({ cmd, args, options });
      return { pid: 1, exited: () => false, kill: () => undefined };
    };
    openInBrowser(URL_LINE, "darwin", fake);
    openInBrowser(URL_LINE, "linux", fake);
    openInBrowser(URL_LINE, "win32", fake);
    expect(started.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ["open", URL_LINE],
      ["xdg-open", URL_LINE],
      ["cmd", "/c", "start", '""', URL_LINE],
    ]);
    expect(started.map(({ options }) => options?.verbatim)).toEqual([false, false, true]);
    const throwing: typeof startDetached = () => {
      throw new Error("no opener");
    };
    expect(() => openInBrowser(URL_LINE, "linux", throwing)).not.toThrow();
  });
});
