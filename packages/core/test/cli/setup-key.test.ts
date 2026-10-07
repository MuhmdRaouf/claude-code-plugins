import { describe, expect, it } from "vitest";
import { ENTRY_WAIT_MS } from "../../src/cli/commands/setup-key.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { runCli } from "../../src/cli/run.ts";
import { err, ok, type Result } from "../../src/domain/result.ts";
import type { KeyEntry, KeyVerdict } from "../../src/ports/keys.ts";
import { MemoryKeyStore, TEST_KEY } from "../support/fake-keystore.ts";
import { type Fakes, fakeDeps } from "../support/fakes.ts";

const PAGE_URL = "http://127.0.0.1:40123/AAAAtokenAAAA";
const FILE = "/home/u/.config/zai-plugin-cc/env";
const OLD_KEY = "zt-OLD.key_0123456789abcdef";

/** A fake page: opening it schedules the user's paste `after` polls later; the host then loads what the store holds. */
class FakeEntry implements KeyEntry {
  readonly keys = new MemoryKeyStore();
  verdict: KeyVerdict = "accepted";
  opened = 0;
  checked: string[] = [];
  removedFromFile: string[] = [];
  launch: Result<string, string> = ok(PAGE_URL);
  /** Polls before the user's key lands; undefined: never. */
  after: number | undefined = 3;
  private polls = 0;
  constructor(private readonly fakes: Fakes) {
    const get = this.keys.get.bind(this.keys);
    this.keys.get = async () => {
      if (this.opened > 0 && this.after !== undefined) {
        this.polls += 1;
        if (this.polls === this.after) await this.keys.set(TEST_KEY);
      }
      const value = await get();
      if (value !== undefined) this.fakes.host.keyResult = ok({ value, source: this.keys.label });
      return value;
    };
  }
  async store() {
    return this.keys;
  }
  async check(key: string) {
    this.checked.push(key);
    return this.verdict;
  }
  async openPage() {
    this.opened += 1;
    return this.launch;
  }
  async removeFromFile(value: string) {
    this.removedFromFile.push(value);
    return true;
  }
}

function world(): { fakes: Fakes; entry: FakeEntry } {
  const fakes = fakeDeps();
  const entry = new FakeEntry(fakes);
  fakes.host.keyEntry = entry;
  fakes.host.keyResult = err({ kind: "no_key", message: "no Z.ai GLM key: export ZAI_API_KEY" });
  return { fakes, entry };
}

function transcript(fakes: Fakes): string {
  return [...fakes.out.lines, ...fakes.out.errors].join("\n");
}

describe("setup without a key", () => {
  it("prints the page URL, waits for the store to fill, then finishes setup", async () => {
    const { fakes, entry } = world();
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.ok);
    const text = fakes.out.text;
    expect(text).toContain(`  ${PAGE_URL}`);
    expect(text).toContain("never in the chat");
    expect(text).toContain("key: saved in macOS Keychain");
    expect(text).toContain("  key:      present (macOS Keychain)");
    expect(text).toMatch(/\nzai setup: ready\./);
    expect(entry.opened).toBe(1);
    expect(transcript(fakes)).not.toContain(TEST_KEY);
  });

  it("exits 6 after 90 s of polling when nothing arrives", async () => {
    const { fakes, entry } = world();
    entry.after = undefined;
    const start = fakes.clock.now();
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.notReady);
    expect(fakes.clock.now() - start).toBe(ENTRY_WAIT_MS);
    expect(fakes.out.lines.at(-1)).toBe("Finish in the browser, then run /zai:setup again.");
    expect(fakes.out.text).not.toContain("ready");
  });

  it("under --json the progress goes to stderr and stdout stays one JSON document", async () => {
    const { fakes } = world();
    expect(await runCli(["setup", "--json"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.errors.join("\n")).toContain(PAGE_URL);
    expect(JSON.parse(fakes.out.text)).toMatchObject({
      ready: true,
      key: { ok: true, value: "macOS Keychain" },
    });
  });

  it("a page that cannot start leaves setup to report the missing key", async () => {
    const { fakes, entry } = world();
    entry.launch = err("cannot start the key page");
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.notReady);
    expect(fakes.out.text).toContain("key: cannot open the key page (cannot start the key page)");
    expect(fakes.out.text).toContain("  key:      MISSING: no Z.ai GLM key");
  });
});

describe("setup with a key", () => {
  it("an env key is the user's own: no store, no check, no page", async () => {
    const { fakes, entry } = world();
    fakes.host.keyResult = ok({ value: TEST_KEY, source: "ZAI_API_KEY" });
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(entry.opened).toBe(0);
    expect(entry.checked).toEqual([]);
    expect(entry.keys.sets).toBe(0);
  });

  it("a key only in the file moves to the store, confirmed by a read-back, and its file line goes", async () => {
    const { fakes, entry } = world();
    entry.after = undefined;
    fakes.host.keyResult = ok({ value: OLD_KEY, source: FILE });
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(entry.keys.value).toBe(OLD_KEY);
    expect(entry.removedFromFile).toEqual([OLD_KEY]);
    expect(fakes.out.text).toContain(`key: moved from ${FILE} to macOS Keychain`);
    expect(entry.opened).toBe(0);
  });

  it("a store that will not take the key leaves the file alone", async () => {
    const { fakes, entry } = world();
    entry.after = undefined;
    entry.keys.failSet = true;
    fakes.host.keyResult = ok({ value: OLD_KEY, source: FILE });
    await runCli(["setup"], fakes.deps, "/repo");
    expect(entry.removedFromFile).toEqual([]);
    expect(fakes.out.text).toContain(
      `key: kept in ${FILE}: could not store the key in macOS Keychain (exit 1)`,
    );
  });

  it("a store that does not give the key back keeps the file; a file line already gone is said so", async () => {
    const { fakes, entry } = world();
    entry.after = undefined;
    entry.keys.get = async () => undefined;
    fakes.host.keyResult = ok({ value: OLD_KEY, source: FILE });
    await runCli(["setup"], fakes.deps, "/repo");
    expect(fakes.out.text).toContain(`key: kept in ${FILE}: macOS Keychain did not return the key`);
    expect(entry.removedFromFile).toEqual([]);

    const second = world();
    second.entry.after = undefined;
    second.entry.removeFromFile = async () => false;
    second.fakes.host.keyResult = ok({ value: OLD_KEY, source: FILE });
    await runCli(["setup"], second.fakes.deps, "/repo");
    expect(second.fakes.out.text).toContain(
      `key: moved from ${FILE} to macOS Keychain (the file line was already gone)`,
    );
  });

  it("no migration where the only store is the key file itself", async () => {
    const { fakes, entry } = world();
    const file = new MemoryKeyStore("file", FILE, OLD_KEY);
    entry.store = async () => file;
    fakes.host.keyResult = ok({ value: OLD_KEY, source: FILE });
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(file.sets).toBe(0);
    expect(entry.removedFromFile).toEqual([]);
  });

  it("a stored key the provider refuses opens the page and waits for a different key", async () => {
    const { fakes, entry } = world();
    entry.verdict = "refused";
    entry.keys.value = OLD_KEY;
    fakes.host.keyResult = ok({ value: OLD_KEY, source: "macOS Keychain" });
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.text).toContain("key: Z.ai GLM refused the stored key; enter a new one.");
    expect(entry.opened).toBe(1);
    expect(entry.keys.value).toBe(TEST_KEY);
    expect(transcript(fakes)).not.toContain(OLD_KEY);
  });

  it("a stored key the provider rate limits or has no balance for stays, and setup says why it will not work yet", async () => {
    const { fakes, entry } = world();
    entry.verdict = "limited";
    entry.keys.value = OLD_KEY;
    fakes.host.keyResult = ok({ value: OLD_KEY, source: "macOS Keychain" });
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.text).toContain(
      "key: Z.ai GLM knows the key but is not taking requests with it yet (a rate limit, or no balance left: top up at https://z.ai/manage-apikey/billing)",
    );
    expect(entry.opened).toBe(0);
    expect(entry.keys.value).toBe(OLD_KEY);
  });

  it("a key file looser than 0600 is reported, not replaced", async () => {
    const { fakes, entry } = world();
    fakes.host.keyResult = err({
      kind: "insecure_key_file",
      label: "Z.ai GLM key file",
      path: FILE,
      mode: "0644",
    });
    expect(await runCli(["setup"], fakes.deps, "/repo")).toBe(EXIT.notReady);
    expect(entry.opened).toBe(0);
  });
});

describe("setup --remove", () => {
  it("removes the key from the store", async () => {
    const { fakes, entry } = world();
    entry.keys.value = TEST_KEY;
    expect(await runCli(["setup", "--remove"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(entry.keys.removes).toBe(1);
    expect(fakes.out.text).toContain("key: removed from macOS Keychain");
  });

  it("a store that fails to remove says so and the rest of the removal still runs", async () => {
    const { fakes, entry } = world();
    entry.keys.remove = async () => {
      throw new Error("could not remove the key in macOS Keychain (tool not found)");
    };
    expect(await runCli(["setup", "--remove", "--json"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.errors.join("\n")).toContain("key: FAILED to remove from macOS Keychain");
    expect(JSON.parse(fakes.out.text)).toMatchObject({ removed: true });
  });

  it("without a key entry (a host that has none) setup behaves as before", async () => {
    const fakes = fakeDeps();
    expect(await runCli(["setup", "--remove"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.text).not.toContain("key:");
  });
});
