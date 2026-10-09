import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKey } from "../../src/adapters/key.ts";
import { err, ok } from "../../src/domain/result.ts";
import { MemoryKeyStore, TEST_KEY } from "../support/fake-keystore.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER } from "../support/provider.ts";

const OTHER_KEY = "zt-FILE.key_0123456789abcdef";

/** Every test reads and writes under a temp dir; the real HOME and its key files are never touched. */
async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "core-key-"));
}

async function keyFile(content: string, mode = 0o600): Promise<string> {
  const file = join(await newDir(), "env");
  await writeFile(file, content);
  await chmod(file, mode);
  return file;
}

describe("loadKey", () => {
  it("env wins over the file, and the source names the env var", async () => {
    const file = await keyFile("ZAI_API_KEY=from-file\n");
    const fromEnv = await loadKey(REFERENCE_PROVIDER, { ZAI_API_KEY: "from-env" }, file);
    expect(fromEnv).toEqual(ok({ value: "from-env", source: "ZAI_API_KEY" }));
  });

  it("the first of the provider's key env names that is set wins", async () => {
    const provider = { ...ACME_PROVIDER, keyEnv: ["ACME_API_KEY", "ACME_LEGACY_KEY"] };
    const nowhere = join(await newDir(), "missing");
    const primary = await loadKey(provider, { ACME_API_KEY: "new", ACME_LEGACY_KEY: "old" }, nowhere);
    const legacy = await loadKey(provider, { ACME_LEGACY_KEY: "old" }, nowhere);
    expect(primary).toEqual(ok({ value: "new", source: "ACME_API_KEY" }));
    expect(legacy).toEqual(ok({ value: "old", source: "ACME_LEGACY_KEY" }));
  });

  it("reads the file: any key env name, optional export and quotes, comments ignored", async () => {
    const variants = [
      ['ZAI_API_KEY="double-quoted"\n', "double-quoted"],
      ["ZAI_API_KEY='single-quoted'\n", "single-quoted"],
      ["export ZAI_API_KEY=bare\n", "bare"],
      ["# comment\nOTHER=1\nZAI_API_KEY=last\n", "last"],
    ] as const;
    for (const [content, key] of variants) {
      const loaded = await loadKey(REFERENCE_PROVIDER, {}, await keyFile(content));
      expect(loaded).toEqual(ok({ value: key, source: expect.any(String) }));
    }
  });

  it("a key file looser than 0600 is refused, whatever it holds", async () => {
    const worldReadable = await loadKey(REFERENCE_PROVIDER, {}, await keyFile("ZAI_API_KEY=x", 0o644));
    const groupReadable = await loadKey(REFERENCE_PROVIDER, {}, await keyFile("ZAI_API_KEY=x", 0o640));
    const ownerOnly = await loadKey(REFERENCE_PROVIDER, {}, await keyFile("ZAI_API_KEY=x", 0o400));

    expect(worldReadable).toEqual(
      err({
        kind: "insecure_key_file",
        label: "Z.ai GLM key file",
        path: expect.any(String),
        mode: "0644",
      }),
    );
    expect(groupReadable).toMatchObject({ ok: false, error: { kind: "insecure_key_file", mode: "0640" } });
    expect(ownerOnly).toMatchObject({ ok: true, value: { value: "x" } });
  });

  it("no env and no usable file → no_key with a setup hint naming the provider", async () => {
    const dir = await newDir();
    const missing = join(dir, "missing");
    const noLine = await keyFile("OTHER=1\n");

    expect(await loadKey(REFERENCE_PROVIDER, {}, missing)).toEqual(
      err({
        kind: "no_key",
        message:
          "no Z.ai GLM key: export ZAI_API_KEY, or run /zai:setup to enter it once and keep it in the OS keystore",
      }),
    );
    expect(await loadKey(REFERENCE_PROVIDER, { ZAI_API_KEY: " " }, noLine)).toMatchObject({
      ok: false,
      error: { kind: "no_key" },
    });
  });

  it("expands a leading ~ from HOME (the default key file is one)", async () => {
    const dir = await newDir();
    await writeFile(join(dir, "env"), "ACME_API_KEY=tilde\n");
    await chmod(join(dir, "env"), 0o600);
    expect(REFERENCE_PROVIDER.keyFile.startsWith("~/")).toBe(true);

    const found = await loadKey(ACME_PROVIDER, { HOME: dir }, "~/env");
    const missing = await loadKey(ACME_PROVIDER, { HOME: dir }, "~/missing");

    expect(found).toEqual(ok({ value: "tilde", source: join(dir, "env") }));
    expect(missing).toMatchObject({ ok: false, error: { kind: "no_key" } });
  });
});

describe("loadKey with a key store", () => {
  it("looks up env, then the store, then the file; the source names where the key was", async () => {
    const file = await keyFile(`ZAI_API_KEY=${OTHER_KEY}\n`);
    const store = new MemoryKeyStore("macos", "macOS Keychain", TEST_KEY);
    expect(await loadKey(REFERENCE_PROVIDER, { ZAI_API_KEY: "from-env" }, file, store)).toEqual(
      ok({ value: "from-env", source: "ZAI_API_KEY" }),
    );
    expect(await loadKey(REFERENCE_PROVIDER, {}, file, store)).toEqual(
      ok({ value: TEST_KEY, source: "macOS Keychain" }),
    );
    store.value = undefined;
    expect(await loadKey(REFERENCE_PROVIDER, {}, file, store)).toEqual(
      ok({ value: OTHER_KEY, source: file }),
    );
    expect(await loadKey(REFERENCE_PROVIDER, {}, file, undefined)).toEqual(
      ok({ value: OTHER_KEY, source: file }),
    );
  });

  it("a store that fails to answer is skipped, never fatal", async () => {
    const file = await keyFile(`ZAI_API_KEY=${OTHER_KEY}\n`);
    const store = new MemoryKeyStore();
    store.get = async () => {
      throw new Error("locked");
    };
    expect(await loadKey(REFERENCE_PROVIDER, {}, file, store)).toEqual(
      ok({ value: OTHER_KEY, source: file }),
    );
  });

  it("an unreadable key file is an error naming the file", async () => {
    const dir = await newDir();
    expect(await loadKey(REFERENCE_PROVIDER, {}, dir, undefined)).toMatchObject({
      ok: false,
      error: {
        kind: "no_key",
        message: expect.stringContaining(`cannot read Z.ai GLM key file ${dir} (EISDIR)`),
      },
    });
  });
});
