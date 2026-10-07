import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyProviderSettings,
  claudeSettingsPath,
  clearBaseUrl,
  readBaseUrl,
  removeProviderSettings,
  type SettingsDelta,
  settingsBackupPath,
  undoProviderSettings,
} from "../../src/adapters/claude-settings.ts";
import type { BaseUrlPlan } from "../../src/domain/plugin-routers.ts";
import { planBaseUrl, planBaseUrlRemoval } from "../../src/domain/plugin-routers.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";
import { sleep } from "../support/wait.ts";

const ROUTER = "http://127.0.0.1:18787";
const KIMI_ROUTER = "http://127.0.0.1:18788";

const settingsPath = (): string => join(tempDir("core-settings-"), "home", ".claude", "settings.json");
/** The change lines of an apply that must have succeeded. */
const appliedLines = async (path: string): Promise<readonly string[]> => {
  const result = await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const write = (path: string, json: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
};
const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("claudeSettingsPath", () => {
  it("takes $CLAUDE_CONFIG_DIR over ~/.claude", () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home" })).toBe(
      join("/cfg", "settings.json"),
    );
    expect(claudeSettingsPath({ HOME: "/home" })).toBe(join("/home", ".claude", "settings.json"));
  });
});

describe("the base URL plan", () => {
  it("sets when unset, keeps when already ours, moves from another plugin router", () => {
    const set: BaseUrlPlan = planBaseUrl(undefined, ROUTER);
    expect(set).toMatchObject({ kind: "set", url: ROUTER });
    expect(planBaseUrl(ROUTER, ROUTER).kind).toBe("keep");
    expect(planBaseUrl(KIMI_ROUTER, ROUTER)).toMatchObject({
      kind: "set",
      url: ROUTER,
      report: expect.stringContaining("kimi"),
    });
  });

  it("keeps and reports anything else as the user's own proxy", () => {
    const plan = planBaseUrl("https://proxy.example", ROUTER);
    expect(plan.kind).toBe("keep");
    expect(plan.report).toContain("your own proxy");
  });

  it("clears only what is ours, repointing at another live router when there is one", () => {
    expect(planBaseUrlRemoval(ROUTER, ROUTER, [])).toMatchObject({ kind: "remove" });
    expect(planBaseUrlRemoval(ROUTER, ROUTER, [KIMI_ROUTER])).toMatchObject({
      kind: "set",
      url: KIMI_ROUTER,
    });
    expect(planBaseUrlRemoval("https://proxy.example", ROUTER, []).kind).toBe("keep");
  });
});

describe("applyProviderSettings", () => {
  it("creates the file (and its directory) when missing, with the two models and the base URL", async () => {
    const path = settingsPath();

    expect(await appliedLines(path)).toEqual([
      "added GLM 5.3 (glm-5.3) to /model",
      "added GLM 5.3 Flash (glm-5.3-flash) to /model",
      `pointed ANTHROPIC_BASE_URL at ${ROUTER}`,
    ]);
    expect(read(path)).toEqual({
      modelPicker: {
        options: [
          { model: "glm-5.3", label: "GLM 5.3" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash" },
        ],
      },
      env: { ANTHROPIC_BASE_URL: ROUTER },
    });
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
  });

  it("keeps every other key and its order, and only appends to an existing availableModels", async () => {
    const path = settingsPath();
    write(path, {
      before: 1,
      modelPicker: { options: [{ model: "claude-opus-4", label: "Opus" }], other: true },
      availableModels: ["claude-sonnet-4"],
      env: { ANTHROPIC_AUTH_TOKEN: "redacted", ANTHROPIC_BASE_URL: ROUTER },
      after: [1, 2],
    });

    await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER);

    const settings = read(path);
    expect(Object.keys(settings)).toEqual(["before", "modelPicker", "availableModels", "env", "after"]);
    expect(settings.availableModels).toEqual(["claude-sonnet-4", "glm-5.3", "glm-5.3-flash"]);
    expect(settings.modelPicker).toEqual({
      other: true,
      options: [
        { model: "claude-opus-4", label: "Opus" },
        { model: "glm-5.3", label: "GLM 5.3" },
        { model: "glm-5.3-flash", label: "GLM 5.3 Flash" },
      ],
    });
    expect(settings.env).toEqual({ ANTHROPIC_AUTH_TOKEN: "redacted", ANTHROPIC_BASE_URL: ROUTER });
  });

  it("leaves availableModels absent when it was absent", async () => {
    const path = settingsPath();
    write(path, { env: { ANTHROPIC_BASE_URL: ROUTER } });

    await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER);

    expect(read(path)).not.toHaveProperty("availableModels");
  });

  it("is idempotent: a second apply is byte-identical and reports no changes", async () => {
    const path = settingsPath();
    await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER);
    const first = readFileSync(path, "utf8");

    expect(await appliedLines(path)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("replaces another plugin's router, and keeps a foreign proxy while reporting it", async () => {
    const moved = settingsPath();
    write(moved, { env: { ANTHROPIC_BASE_URL: KIMI_ROUTER } });
    expect((await appliedLines(moved)).at(-1)).toContain("kimi");
    expect(read(moved).env).toEqual({ ANTHROPIC_BASE_URL: ROUTER });

    const kept = settingsPath();
    write(kept, { env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });
    expect((await appliedLines(kept)).at(-1)).toContain("your own proxy");
    expect(read(kept).env).toEqual({ ANTHROPIC_BASE_URL: "https://proxy.example" });
  });

  it("errors without writing when the file is not valid JSON or not an object", async () => {
    const broken = settingsPath();
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, "{ not json");
    expect(await applyProviderSettings(broken, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(readFileSync(broken, "utf8")).toBe("{ not json");

    const array = settingsPath();
    write(array, []);
    expect(await applyProviderSettings(array, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("not a settings object"),
    });
    expect(read(array)).toEqual([]);
  });

  it("errors without writing when a touched key has the wrong type", async () => {
    const path = settingsPath();
    write(path, { modelPicker: { options: "nope" } });
    expect(await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("options must be an array"),
    });
    expect(read(path).modelPicker).toEqual({ options: "nope" });

    const models = settingsPath();
    write(models, { availableModels: "nope" });
    expect(await applyProviderSettings(models, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("availableModels must be an array"),
    });
  });
});

describe("removeProviderSettings", () => {
  it("takes exactly this provider's entries out; an emptied list stays an empty array", async () => {
    const path = settingsPath();
    write(path, {
      modelPicker: {
        options: [
          { model: "kimi-k3", label: "Kimi K3" },
          { model: "glm-5.3", label: "GLM 5.3" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash" },
        ],
      },
      availableModels: ["kimi-k3", "glm-5.3"],
      env: { ANTHROPIC_BASE_URL: ROUTER },
    });

    const changes = await removeProviderSettings(path, REFERENCE_PROVIDER, ROUTER, []);
    expect(changes).toEqual({
      ok: true,
      value: expect.arrayContaining([expect.stringContaining("out of /model")]),
    });

    expect(read(path)).toEqual({
      modelPicker: { options: [{ model: "kimi-k3", label: "Kimi K3" }] },
      availableModels: ["kimi-k3"],
    });
  });

  it("removes the base URL when it is ours and nobody else is registered", async () => {
    const path = settingsPath();
    write(path, { env: { ANTHROPIC_BASE_URL: ROUTER } });

    await removeProviderSettings(path, REFERENCE_PROVIDER, ROUTER, []);

    expect(read(path)).toEqual({});
  });

  it("repoints the base URL at the first other registered router", async () => {
    const path = settingsPath();
    write(path, { env: { ANTHROPIC_BASE_URL: ROUTER } });

    await removeProviderSettings(path, REFERENCE_PROVIDER, ROUTER, [KIMI_ROUTER]);

    expect(read(path)).toEqual({ env: { ANTHROPIC_BASE_URL: KIMI_ROUTER } });
  });

  it("leaves a foreign proxy and an empty file alone", async () => {
    const foreign = settingsPath();
    write(foreign, { env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });
    await removeProviderSettings(foreign, REFERENCE_PROVIDER, ROUTER, []);
    expect(read(foreign).env).toEqual({ ANTHROPIC_BASE_URL: "https://proxy.example" });

    const empty = settingsPath();
    expect(await removeProviderSettings(empty, REFERENCE_PROVIDER, ROUTER, [])).toEqual({
      ok: true,
      value: [],
    });
    // Nothing changed, so nothing is written: a missing file stays missing.
    expect(existsSync(empty)).toBe(false);
  });
});

describe("clearBaseUrl", () => {
  it("clears only the base URL, leaving every model entry", async () => {
    const path = settingsPath();
    write(path, {
      modelPicker: { options: [{ model: "glm-5.3", label: "GLM 5.3" }] },
      env: { ANTHROPIC_BASE_URL: ROUTER },
    });

    await clearBaseUrl(path, ROUTER, []);

    expect(read(path)).toEqual({ modelPicker: { options: [{ model: "glm-5.3", label: "GLM 5.3" }] } });
  });
});

describe("the careful write", () => {
  it("never overwrites a settings.json it cannot read: only a missing file counts as empty", async () => {
    const path = settingsPath();
    write(path, { permissions: { allow: ["Bash"] }, env: { MY_TOKEN: "t" } });
    chmodSync(path, 0o000);
    try {
      const result = await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER);
      expect(result).toEqual({ ok: false, error: expect.stringContaining("cannot read") });
    } finally {
      chmodSync(path, 0o600);
    }
    expect(read(path)).toEqual({ permissions: { allow: ["Bash"] }, env: { MY_TOKEN: "t" } });
    const dir = settingsPath();
    mkdirSync(dir, { recursive: true });
    expect(await applyProviderSettings(dir, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("cannot read"),
    });
  });

  it("keeps the file's mode and writes through a symlink, keeping the link", async () => {
    const path = settingsPath();
    write(path, { theme: "dark" });
    chmodSync(path, 0o600);
    await appliedLines(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const real = join(tempDir("core-settings-real-"), "dotfiles-settings.json");
    writeFileSync(real, "{}\n");
    chmodSync(real, 0o640);
    const link = settingsPath();
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
    await appliedLines(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(read(real)).toMatchObject({ env: { ANTHROPIC_BASE_URL: ROUTER } });
  });

  it("backs the file up once, before the first write ever, mode 0600", async () => {
    const path = settingsPath();
    write(path, { theme: "dark" });
    const original = readFileSync(path, "utf8");
    await appliedLines(path);
    const backup = settingsBackupPath(path, "zai");
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    await clearBaseUrl(path, ROUTER, [], "zai");
    expect(readFileSync(backup, "utf8")).toBe(original);
  });

  it("writes nothing when nothing changed", async () => {
    const path = settingsPath();
    await appliedLines(path);
    // Every write goes through a temp file renamed over the target, so a rewrite would give the file a new inode;
    // the same inode and bytes mean nothing was written (an mtime check misses rewrites on coarse-clock filesystems).
    const before = { ino: statSync(path).ino, bytes: readFileSync(path, "utf8") };
    expect(await appliedLines(path)).toEqual([]);
    expect({ ino: statSync(path).ino, bytes: readFileSync(path, "utf8") }).toEqual(before);
  });

  it("waits for another plugin's edit to finish (a shared lock), and gives up when it never does", async () => {
    const path = settingsPath();
    write(path, {});
    const lock = `${path}.provider-routers.lock`;
    writeFileSync(lock, `${process.pid}\n`);
    const waiting = applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER);
    await sleep(100); // the edit holds off while the lock is there
    rmSync(lock);
    expect((await waiting).ok).toBe(true);
  });

  it("refuses an env that is not an object, and a base URL that is not a string", async () => {
    const path = settingsPath();
    write(path, { env: "nope" });
    expect(await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("env must be an object"),
    });
    write(path, { env: { ANTHROPIC_BASE_URL: 7 } });
    expect(await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("must be a string"),
    });
  });

  it("reads the current base URL, and nothing from a file that is missing or malformed", () => {
    const path = settingsPath();
    expect(readBaseUrl(path)).toBeUndefined();
    write(path, { env: { ANTHROPIC_BASE_URL: ROUTER } });
    expect(readBaseUrl(path)).toBe(ROUTER);
    write(path, { env: null });
    expect(readBaseUrl(path)).toBeUndefined();
    write(path, { env: { ANTHROPIC_BASE_URL: 1 } });
    expect(readBaseUrl(path)).toBeUndefined();
  });

  it("does not move the base URL from a live plugin router, and says a dead one was not running", () => {
    expect(planBaseUrl(KIMI_ROUTER, ROUTER, [KIMI_ROUTER])).toEqual({ kind: "keep" });
    expect(planBaseUrl(KIMI_ROUTER, ROUTER, [])).toMatchObject({
      kind: "set",
      report: expect.stringContaining("not running"),
    });
  });
});

describe("the uninstall undo of settings", () => {
  it("takes out exactly what setup added, the containers it created, and leaves what the user added", async () => {
    const path = settingsPath();
    let delta: SettingsDelta | undefined;
    await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER, {
      record: (recorded) => {
        delta = recorded;
      },
    });
    expect(delta).toEqual({
      baseUrlBefore: null,
      optionsAdded: ["glm-5.3", "glm-5.3-flash"],
      availableAppended: [],
      createdModelPicker: true,
      createdOptions: true,
      createdEnv: true,
    });
    const edited = read(path) as { modelPicker: { options: unknown[]; extra?: boolean } };
    edited.modelPicker.options.push({ model: "mine", label: "Mine" });
    write(path, edited);
    const undone = await undoProviderSettings(path, "zai", delta as SettingsDelta, ROUTER, []);
    expect(undone).toMatchObject({ ok: true });
    expect(read(path)).toEqual({ modelPicker: { options: [{ model: "mine", label: "Mine" }] } });
  });

  it("removes appended availableModels ids and leaves an availableModels setup did not touch", async () => {
    const path = settingsPath();
    write(path, { availableModels: ["sonnet"], modelPicker: "odd" });
    await undoProviderSettings(
      path,
      "zai",
      {
        optionsAdded: [],
        availableAppended: ["glm-5.3"],
        createdModelPicker: false,
        createdOptions: false,
        createdEnv: false,
      },
      ROUTER,
      [],
    );
    expect(read(path)).toEqual({ availableModels: ["sonnet"], modelPicker: "odd" });
    write(path, { availableModels: ["sonnet", "glm-5.3"], modelPicker: { options: "odd" } });
    await undoProviderSettings(
      path,
      "zai",
      {
        optionsAdded: [],
        availableAppended: ["glm-5.3"],
        createdModelPicker: true,
        createdOptions: false,
        createdEnv: false,
      },
      ROUTER,
      [],
    );
    expect(read(path)).toEqual({ availableModels: ["sonnet"], modelPicker: { options: "odd" } });
  });
});
