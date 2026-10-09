import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileKeyStore,
  keyFilePath,
  removeKeyLine,
  replaceSystemRunner,
  spawnRunner,
  writableKeyStore,
} from "../../../src/adapters/keystore/index.ts";
import { FakeRunner, TEST_KEY } from "../../support/fake-keystore.ts";
import { REFERENCE_PROVIDER } from "../../support/provider.ts";
import { tempDir } from "../../support/tmp.ts";

const OTHER = "zt-OTHER.key_9876543210fedcba";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("the key file store", () => {
  it("writes NAME=<key> as 0600 in a 0700 directory, keeping other lines and replacing an old key line", async () => {
    const dir = join(tempDir(), "conf");
    const file = join(dir, "env");
    const store = fileKeyStore(REFERENCE_PROVIDER, file);
    await store.set(OTHER);
    expect(readFileSync(file, "utf8")).toBe(`ZAI_API_KEY=${OTHER}\n`);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    writeFileSync(file, `# mine\nZAI_MAX_CONCURRENCY=4\nexport ZAI_API_KEY="${OTHER}"\n\n`, { mode: 0o600 });
    await store.set(TEST_KEY);
    expect(readFileSync(file, "utf8")).toBe(`# mine\nZAI_MAX_CONCURRENCY=4\nZAI_API_KEY=${TEST_KEY}\n`);
    expect(await store.get()).toBe(TEST_KEY);
    expect(await store.available()).toBe(true);
    expect(store.kind).toBe("file");
    expect(store.label).toBe(file);
    await expect(store.set("not a key")).rejects.toThrow(/16-512/);
  });

  it("get is undefined for a missing file, a file without the line, or a loose file", async () => {
    const dir = tempDir();
    const file = join(dir, "env");
    const store = fileKeyStore(REFERENCE_PROVIDER, file);
    expect(await store.get()).toBeUndefined();
    writeFileSync(file, "OTHER=1\n", { mode: 0o600 });
    expect(await store.get()).toBeUndefined();
    writeFileSync(join(dir, "loose"), `ZAI_API_KEY=${TEST_KEY}\n`, { mode: 0o644 });
    expect(await fileKeyStore(REFERENCE_PROVIDER, join(dir, "loose")).get()).toBeUndefined();
  });

  it("removeKeyLine drops only the matching line, deletes a file left empty, and reports what it did", async () => {
    const dir = tempDir();
    const file = join(dir, "env");
    writeFileSync(file, `# keep\nZAI_API_KEY=${TEST_KEY}\nZAI_MAX_CONCURRENCY=4\n`, { mode: 0o600 });
    expect(await removeKeyLine(REFERENCE_PROVIDER, file, OTHER)).toBe(false);
    expect(await removeKeyLine(REFERENCE_PROVIDER, file, TEST_KEY)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("# keep\nZAI_MAX_CONCURRENCY=4\n");
    expect(mode(file)).toBe(0o600);

    writeFileSync(file, `ZAI_API_KEY='${TEST_KEY}'\n\n`, { mode: 0o600 });
    expect(await removeKeyLine(REFERENCE_PROVIDER, file, TEST_KEY)).toBe(true);
    expect(() => statSync(file)).toThrow(/ENOENT/);
    expect(await removeKeyLine(REFERENCE_PROVIDER, file, TEST_KEY)).toBe(false);

    writeFileSync(file, `ZAI_API_KEY=${TEST_KEY}\nX=1\n`, { mode: 0o600 });
    await fileKeyStore(REFERENCE_PROVIDER, file).remove();
    expect(readFileSync(file, "utf8")).toBe("X=1\n");
  });

  it("keyFilePath expands ~ from the env's HOME", () => {
    expect(keyFilePath(REFERENCE_PROVIDER, { HOME: "/h" })).toBe("/h/.config/zai-plugin-cc/env");
    expect(keyFilePath(REFERENCE_PROVIDER, { HOME: "/h" }, "/abs/env")).toBe("/abs/env");
  });
});

describe("writableKeyStore", () => {
  it("the platform store when it answers, else the key file", async () => {
    const home = tempDir();
    const runner = new FakeRunner();
    const options = { platform: "darwin" as const, runner: runner.run, accountHome: home };
    expect((await writableKeyStore(REFERENCE_PROVIDER, { HOME: home }, options)).kind).toBe("macos");
    runner.answer = () => ({ code: 1, stdout: "", stderr: "" });
    const fallback = await writableKeyStore(REFERENCE_PROVIDER, { HOME: home }, options);
    expect(fallback.label).toBe(join(home, ".config/zai-plugin-cc/env"));
    const sandbox = await writableKeyStore(REFERENCE_PROVIDER, { HOME: tempDir() }, options);
    expect(sandbox.kind).toBe("file");
  });

  it("under test, the default runner reaches no real tool", async () => {
    const home = tempDir();
    const store = await writableKeyStore(REFERENCE_PROVIDER, { HOME: home }, { accountHome: home });
    expect(store.kind).toBe("file");
    const previous = replaceSystemRunner(spawnRunner);
    expect(replaceSystemRunner(previous)).toBe(spawnRunner);
  });
});

describe("spawnRunner", () => {
  it("passes stdin, collects stdout and stderr and the exit code, and never puts stdin in argv", async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.length+'');process.stderr.write('e');process.exit(3)})";
    const result = await spawnRunner(process.execPath, ["-e", script], TEST_KEY);
    expect(result).toEqual({ code: 3, stdout: String(TEST_KEY.length), stderr: "e" });
    expect(await spawnRunner(process.execPath, ["-e", "process.stdout.write('x')"])).toEqual({
      code: 0,
      stdout: "x",
      stderr: "",
    });
  });

  it("a missing tool is `missing`; a tool that ignores stdin does not break the runner", async () => {
    expect(await spawnRunner(join(tempDir(), "no-such-tool"), [], TEST_KEY)).toEqual({
      code: null,
      stdout: "",
      stderr: "",
      missing: true,
    });
    const quick = await spawnRunner(process.execPath, ["-e", "process.exit(0)"], "x".repeat(1 << 20));
    expect(quick.code).toBe(0);
  });
});
