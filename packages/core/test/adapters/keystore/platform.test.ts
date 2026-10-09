import { describe, expect, it } from "vitest";
import {
  InvalidKeyError,
  isValidKey,
  keyIdentity,
  platformKeyStore,
  type RunResult,
} from "../../../src/adapters/keystore/index.ts";
import { linuxKeyStore } from "../../../src/adapters/keystore/linux.ts";
import { macosKeyStore, SECURITY } from "../../../src/adapters/keystore/macos.ts";
import { POWERSHELL, POWERSHELL_ARGS, windowsKeyStore } from "../../../src/adapters/keystore/windows.ts";
import { FakeRunner, TEST_KEY } from "../../support/fake-keystore.ts";
import { REFERENCE_PROVIDER } from "../../support/provider.ts";

const ID = keyIdentity(REFERENCE_PROVIDER);
const OK: RunResult = { code: 0, stdout: "", stderr: "" };

/** The key must be in stdin and in no argv element of any call. */
function expectKeyOnlyOnStdin(runner: FakeRunner): void {
  for (const arg of runner.argv) expect(arg).not.toContain(TEST_KEY);
  expect(runner.calls.some((call) => call.stdin?.includes(TEST_KEY))).toBe(true);
}

describe("key shape", () => {
  it("accepts 16-512 chars of [A-Za-z0-9._-] and nothing else", () => {
    expect(isValidKey(TEST_KEY)).toBe(true);
    expect(isValidKey("a".repeat(16))).toBe(true);
    expect(isValidKey("a".repeat(512))).toBe(true);
    for (const bad of [
      "a".repeat(15),
      "a".repeat(513),
      `${"a".repeat(16)}"`,
      `${"a".repeat(16)} x`,
      `${"a".repeat(16)}\n`,
    ])
      expect(isValidKey(bad)).toBe(false);
  });

  it("names the service <name>-plugin-cc and the account api-key; an odd name is refused", () => {
    expect(ID).toEqual({ service: "zai-plugin-cc", account: "api-key", display: "Z.ai GLM" });
    expect(() => keyIdentity({ name: 'x" -w', display: "X" })).toThrow(/unsupported key service/);
  });
});

describe("macOS Keychain", () => {
  it("stores through `security -i` with the command line on stdin, then reads it back", async () => {
    const runner = new FakeRunner();
    runner.answer = (call) =>
      call.args[0] === "find-generic-password" ? { ...OK, stdout: `${TEST_KEY}\n` } : OK;
    await macosKeyStore(ID, runner.run).set(TEST_KEY);
    expect(runner.calls[0]).toEqual({
      cmd: SECURITY,
      args: ["-i"],
      stdin: `add-generic-password -U -s "zai-plugin-cc" -a "api-key" -w "${TEST_KEY}"\n`,
    });
    expect(runner.calls[1]).toEqual({
      cmd: SECURITY,
      args: ["find-generic-password", "-s", "zai-plugin-cc", "-a", "api-key", "-w"],
      stdin: undefined,
    });
    expectKeyOnlyOnStdin(runner);
  });

  it("a write the read-back does not confirm fails without naming the key", async () => {
    const runner = new FakeRunner();
    runner.answer = (call) =>
      call.args[0] === "find-generic-password" ? { code: 44, stdout: "", stderr: "" } : OK;
    const failure = await macosKeyStore(ID, runner.run)
      .set(TEST_KEY)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toBe("could not store the key in macOS Keychain (exit 44)");
    runner.answer = () => ({ code: 1, stdout: "", stderr: `bad ${TEST_KEY}` });
    const exit = await macosKeyStore(ID, runner.run)
      .set(TEST_KEY)
      .catch((error: unknown) => error);
    expect((exit as Error).message).toBe("could not store the key in macOS Keychain (exit 1)");
  });

  it("get trims the newline; not found is undefined; remove deletes through stdin; available probes", async () => {
    const runner = new FakeRunner();
    const store = macosKeyStore(ID, runner.run);
    runner.answer = () => ({ ...OK, stdout: `${TEST_KEY}\n` });
    expect(await store.get()).toBe(TEST_KEY);
    runner.answer = () => ({ code: 44, stdout: "", stderr: "not found" });
    expect(await store.get()).toBeUndefined();
    runner.answer = () => OK;
    expect(await store.get()).toBeUndefined();
    await store.remove();
    expect(runner.calls.at(-1)).toEqual({
      cmd: SECURITY,
      args: ["-i"],
      stdin: 'delete-generic-password -s "zai-plugin-cc" -a "api-key"\n',
    });
    expect(await store.available()).toBe(true);
    expect(runner.calls.at(-1)?.args).toEqual(["default-keychain"]);
    runner.answer = () => ({ code: null, stdout: "", stderr: "", missing: true });
    expect(await store.available()).toBe(false);
    await expect(store.remove()).rejects.toThrow(
      "could not remove the key in macOS Keychain (tool not found)",
    );
    expect(store.label).toBe("macOS Keychain");
  });
});

describe("Secret Service", () => {
  it("stores with the key on stdin only (no trailing newline), labelled with the provider", async () => {
    const runner = new FakeRunner();
    await linuxKeyStore(ID, runner.run).set(TEST_KEY);
    expect(runner.calls).toEqual([
      {
        cmd: "secret-tool",
        args: ["store", "--label=Z.ai GLM API key", "service", "zai-plugin-cc", "account", "api-key"],
        stdin: TEST_KEY,
      },
    ]);
    expectKeyOnlyOnStdin(runner);
    runner.answer = () => ({ code: 1, stdout: "", stderr: "" });
    await expect(linuxKeyStore(ID, runner.run).set(TEST_KEY)).rejects.toThrow(
      "could not store the key in Secret Service (exit 1)",
    );
  });

  it("lookup and clear by service and account", async () => {
    const runner = new FakeRunner();
    const store = linuxKeyStore(ID, runner.run);
    runner.answer = () => ({ ...OK, stdout: TEST_KEY });
    expect(await store.get()).toBe(TEST_KEY);
    expect(runner.calls[0]?.args).toEqual(["lookup", "service", "zai-plugin-cc", "account", "api-key"]);
    runner.answer = () => ({ code: 1, stdout: "", stderr: "" });
    expect(await store.get()).toBeUndefined();
    await store.remove();
    expect(runner.calls.at(-1)?.args).toEqual(["clear", "service", "zai-plugin-cc", "account", "api-key"]);
    runner.answer = () => ({ code: null, stdout: "", stderr: "", missing: true });
    await expect(store.remove()).rejects.toThrow(/tool not found/);
  });

  it("is unavailable when secret-tool is missing or the bus has no secret service", async () => {
    const runner = new FakeRunner();
    const store = linuxKeyStore(ID, runner.run);
    const cases: [RunResult, boolean][] = [
      [{ code: 0, stdout: TEST_KEY, stderr: "" }, true],
      [{ code: 1, stdout: "", stderr: "" }, true],
      [{ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }, false],
      [{ code: 1, stdout: "", stderr: "The name org.freedesktop.secrets was not provided" }, false],
      [{ code: null, stdout: "", stderr: "", missing: true }, false],
    ];
    for (const [result, available] of cases) {
      runner.answer = () => result;
      expect(await store.available()).toBe(available);
    }
  });
});

describe("Windows DPAPI", () => {
  it("runs PowerShell from stdin; the set script reads the key from the next stdin line", async () => {
    const runner = new FakeRunner();
    await windowsKeyStore(ID, runner.run).set(TEST_KEY);
    const [call] = runner.calls;
    expect(call?.cmd).toBe(POWERSHELL);
    expect(call?.args).toEqual([...POWERSHELL_ARGS]);
    const [script, key, rest] = (call?.stdin ?? "").split("\n");
    expect(script).toContain("[Console]::In.ReadLine()");
    expect(script).toContain("ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString");
    expect(script).toContain("$env:APPDATA 'zai-plugin-cc'");
    expect(script).toContain("'key.dpapi'");
    expect(script).not.toContain(TEST_KEY);
    expect(key).toBe(TEST_KEY);
    expect(rest).toBe("");
    expectKeyOnlyOnStdin(runner);
  });

  it("get decrypts to stdout, a missing file is undefined, remove deletes, available probes", async () => {
    const runner = new FakeRunner();
    const store = windowsKeyStore(ID, runner.run);
    runner.answer = () => ({ ...OK, stdout: TEST_KEY });
    expect(await store.get()).toBe(TEST_KEY);
    expect(runner.calls[0]?.stdin).toContain("SecureStringToBSTR");
    runner.answer = () => ({ code: 3, stdout: "", stderr: "" });
    expect(await store.get()).toBeUndefined();
    await expect(store.set(TEST_KEY)).rejects.toThrow("could not store the key in Windows DPAPI (exit 3)");
    await expect(store.remove()).rejects.toThrow("could not remove the key in Windows DPAPI (exit 3)");
    runner.answer = () => OK;
    await store.remove();
    expect(runner.calls.at(-1)?.stdin).toContain("Remove-Item");
    expect(await store.available()).toBe(true);
    runner.answer = () => ({ code: null, stdout: "", stderr: "", missing: true });
    expect(await store.available()).toBe(false);
  });
});

describe("every platform store", () => {
  const stores = [
    ["macos", macosKeyStore],
    ["linux", linuxKeyStore],
    ["windows", windowsKeyStore],
  ] as const;
  for (const [name, create] of stores) {
    it(`${name}: an invalid key is rejected before any command runs`, async () => {
      const runner = new FakeRunner();
      const store = create(ID, runner.run);
      for (const bad of ["short", `${"a".repeat(20)}" ; rm -rf ~`, `${"a".repeat(20)}\nsecond line`]) {
        const failure = await store.set(bad).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(InvalidKeyError);
        expect((failure as Error).message).not.toContain(bad);
      }
      expect(runner.calls).toEqual([]);
    });
  }
});

describe("platformKeyStore", () => {
  const home = "/Users/someone";
  it("picks the platform's store, none elsewhere", () => {
    const runner = new FakeRunner();
    const pick = (platform: NodeJS.Platform) =>
      platformKeyStore(
        REFERENCE_PROVIDER,
        { HOME: home },
        { platform, runner: runner.run, accountHome: home },
      )?.kind;
    expect(pick("darwin")).toBe("macos");
    expect(pick("linux")).toBe("linux");
    expect(pick("win32")).toBe("windows");
    expect(pick("freebsd")).toBeUndefined();
    expect(runner.calls).toEqual([]);
  });

  it("a HOME that is not the account's home (a sandbox) gets no OS store", () => {
    const options = { platform: "darwin" as const, accountHome: home };
    expect(platformKeyStore(REFERENCE_PROVIDER, { HOME: "/tmp/sandbox" }, options)).toBeUndefined();
    expect(platformKeyStore(REFERENCE_PROVIDER, { HOME: `${home}/` }, options)?.kind).toBe("macos");
    expect(platformKeyStore(REFERENCE_PROVIDER, {}, options)?.kind).toBe("macos");
  });
});
