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
  type SettingsUndo,
  settingsBackupPath,
  undoProviderSettings,
} from "../../src/adapters/claude-settings.ts";
import type { BaseUrlPlan } from "../../src/domain/plugin-routers.ts";
import { planBaseUrl, planBaseUrlRemoval } from "../../src/domain/plugin-routers.ts";
import { mergeSettingsUndo } from "../../src/router/ledger.ts";
import { ACME_PROVIDER, REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";
import { sleep } from "../support/wait.ts";

const ROUTER = "http://127.0.0.1:18787";
const KIMI_ROUTER = "http://127.0.0.1:18788";
const ACME_ROUTER = "http://127.0.0.1:18800";

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
  it("creates the file (and its directory) when missing, with the two models (behaving as their Claude models) and the base URL", async () => {
    const path = settingsPath();

    expect(await appliedLines(path)).toEqual([
      "added GLM 5.3 (glm-5.3) to /model",
      "added GLM 5.3 Flash (glm-5.3-flash) to /model",
      "set GLM 5.3 default effort to xhigh",
      "set GLM 5.3 Flash default effort to xhigh",
      `pointed ANTHROPIC_BASE_URL at ${ROUTER}`,
      "turned on MCP tool search",
    ]);
    expect(read(path)).toEqual({
      modelPicker: {
        options: [
          { model: "glm-5.3", label: "GLM 5.3", behavesAs: "claude-opus-5-5" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash", behavesAs: "claude-opus-5-5" },
        ],
      },
      env: { ANTHROPIC_BASE_URL: ROUTER, ENABLE_TOOL_SEARCH: "true" },
      modelSettings: {
        "glm-5.3": { effortLevel: "xhigh" },
        "glm-5.3-flash": { effortLevel: "xhigh" },
      },
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
    expect(Object.keys(settings)).toEqual([
      "before",
      "modelPicker",
      "availableModels",
      "env",
      "after",
      "modelSettings",
    ]);
    expect(settings.modelSettings).toEqual({
      "glm-5.3": { effortLevel: "xhigh" },
      "glm-5.3-flash": { effortLevel: "xhigh" },
    });
    expect(settings.availableModels).toEqual(["claude-sonnet-4", "glm-5.3", "glm-5.3-flash"]);
    expect(settings.modelPicker).toEqual({
      other: true,
      options: [
        { model: "claude-opus-4", label: "Opus" },
        { model: "glm-5.3", label: "GLM 5.3", behavesAs: "claude-opus-5-5" },
        { model: "glm-5.3-flash", label: "GLM 5.3 Flash", behavesAs: "claude-opus-5-5" },
      ],
    });
    expect(settings.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: "redacted",
      ANTHROPIC_BASE_URL: ROUTER,
      ENABLE_TOOL_SEARCH: "true",
    });
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
    expect((await appliedLines(moved)).at(-2)).toContain("kimi");
    expect(read(moved).env).toEqual({ ANTHROPIC_BASE_URL: ROUTER, ENABLE_TOOL_SEARCH: "true" });

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

    const toolSearch = settingsPath();
    write(toolSearch, { env: { ENABLE_TOOL_SEARCH: 7 } });
    expect(await applyProviderSettings(toolSearch, REFERENCE_PROVIDER, ROUTER)).toEqual({
      ok: false,
      error: expect.stringContaining("ENABLE_TOOL_SEARCH must be a string"),
    });
  });

  it("brings a row shaped like setup's own up to the catalog's behavesAs, and leaves a row the user made their own untouched", async () => {
    const path = settingsPath();
    write(path, {
      modelPicker: {
        options: [
          { model: "glm-5.3", label: "GLM 5.3" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash", note: "mine" },
        ],
      },
      env: { ANTHROPIC_BASE_URL: ROUTER },
    });

    await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER);

    expect(read(path).modelPicker).toEqual({
      options: [
        { model: "glm-5.3", label: "GLM 5.3", behavesAs: "claude-opus-5-5" },
        { model: "glm-5.3-flash", label: "GLM 5.3 Flash", note: "mine" },
      ],
    });

    const plain = settingsPath();
    await applyProviderSettings(plain, ACME_PROVIDER, ACME_ROUTER);
    expect(read(plain).modelPicker).toEqual({
      options: [
        { model: "big-model-9", label: "Big Model 9" },
        { model: "small-model-9", label: "Small Model 9" },
      ],
    });
  });

  it("sets ENABLE_TOOL_SEARCH when it points the base URL at the router, but never over a value the user set", async () => {
    const kept = settingsPath();
    write(kept, { env: { ANTHROPIC_BASE_URL: KIMI_ROUTER, ENABLE_TOOL_SEARCH: "false" } });
    let delta: SettingsDelta | undefined;
    await applyProviderSettings(kept, REFERENCE_PROVIDER, ROUTER, {
      record: (recorded) => {
        delta = recorded;
      },
    });
    expect(read(kept).env).toEqual({ ANTHROPIC_BASE_URL: ROUTER, ENABLE_TOOL_SEARCH: "false" });
    expect(delta?.createdToolSearch).toBe(false);
  });
});

describe("removeProviderSettings", () => {
  it("takes exactly this provider's entries out; an emptied list stays an empty array", async () => {
    const path = settingsPath();
    write(path, {
      modelPicker: {
        options: [
          { model: "kimi-k3", label: "Kimi K3" },
          { model: "glm-5.3", label: "GLM 5.3", behavesAs: "claude-opus-5-5" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash", behavesAs: "claude-opus-5-5" },
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
      createdToolSearch: true,
      effortsAdded: { "glm-5.3": "xhigh", "glm-5.3-flash": "xhigh" },
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
        createdToolSearch: false,
        effortsAdded: {},
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
        createdToolSearch: false,
        effortsAdded: {},
      },
      ROUTER,
      [],
    );
    expect(read(path)).toEqual({ availableModels: ["sonnet"], modelPicker: { options: "odd" } });
  });

  it("takes ENABLE_TOOL_SEARCH and the behaving-as rows back out when setup added them, and keeps a value the user set", async () => {
    const path = settingsPath();
    let delta: SettingsDelta | undefined;
    await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER, {
      record: (recorded) => {
        delta = recorded;
      },
    });
    expect(read(path).modelPicker).toMatchObject({
      options: expect.arrayContaining([expect.objectContaining({ behavesAs: "claude-opus-5-5" })]),
    });
    const undone = await undoProviderSettings(path, "zai", delta as SettingsDelta, ROUTER, []);
    expect(undone).toMatchObject({
      ok: true,
      value: expect.arrayContaining(["removed ENABLE_TOOL_SEARCH"]),
    });
    expect(read(path)).toEqual({});

    const user = settingsPath();
    write(user, { env: { ANTHROPIC_BASE_URL: KIMI_ROUTER, ENABLE_TOOL_SEARCH: "false" } });
    let userDelta: SettingsDelta | undefined;
    await applyProviderSettings(user, REFERENCE_PROVIDER, ROUTER, {
      record: (recorded) => {
        userDelta = recorded;
      },
    });
    expect(read(user).env).toEqual({ ANTHROPIC_BASE_URL: ROUTER, ENABLE_TOOL_SEARCH: "false" });
    await undoProviderSettings(user, "zai", userDelta as SettingsDelta, ROUTER, []);
    expect(read(user).env).toEqual({ ENABLE_TOOL_SEARCH: "false" });
  });
});

describe("the modelSettings effort levels", () => {
  /** An apply with its delta captured. */
  const applied = async (
    path: string,
    ownOptions: readonly string[] = [],
  ): Promise<{ readonly lines: readonly string[]; readonly delta: SettingsDelta | undefined }> => {
    let delta: SettingsDelta | undefined;
    const result = await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER, {
      ownOptions,
      record: (recorded) => {
        delta = recorded;
      },
    });
    if (!result.ok) throw new Error(result.error);
    return { lines: result.value, delta };
  };

  it("never overwrites an effort level the user set, on apply or undo", async () => {
    const path = settingsPath();
    write(path, {
      modelSettings: {
        "glm-5.3": { effortLevel: "low" },
        "glm-5.3-flash": { effortLevel: "medium" },
      },
    });

    const { lines, delta } = await applied(path);

    expect(lines).not.toContain("set GLM 5.3 default effort to xhigh");
    expect(lines).not.toContain("set GLM 5.3 Flash default effort to xhigh");
    expect(delta?.effortsAdded).toEqual({});
    const undone = await undoProviderSettings(path, "zai", delta as SettingsDelta, ROUTER, []);
    expect(undone).toMatchObject({ ok: true });
    expect(read(path).modelSettings).toEqual({
      "glm-5.3": { effortLevel: "low" },
      "glm-5.3-flash": { effortLevel: "medium" },
    });
  });

  it("undo takes setup's levels out, an emptied entry with them, and leaves what the user added to the same entries", async () => {
    const path = settingsPath();
    const { delta } = await applied(path);
    // The user hangs their own keys off setup's entries and adds an entry of their own.
    const edited = read(path) as {
      modelSettings: Record<string, Record<string, unknown>>;
    };
    write(path, {
      ...edited,
      modelSettings: {
        ...edited.modelSettings,
        "glm-5.3": { ...edited.modelSettings["glm-5.3"], note: "mine" },
        mine: { effortLevel: "high" },
      },
    });

    const undone = await undoProviderSettings(path, "zai", delta as SettingsDelta, ROUTER, []);
    expect(undone).toMatchObject({
      ok: true,
      value: expect.arrayContaining(["took glm-5.3 and glm-5.3-flash out of modelSettings"]),
    });
    expect(read(path).modelSettings).toEqual({
      "glm-5.3": { note: "mine" },
      mine: { effortLevel: "high" },
    });
  });

  it("is idempotent: a rerun reports no effort changes and rewrites nothing", async () => {
    const path = settingsPath();
    await applied(path);
    const after = readFileSync(path, "utf8");

    expect((await applied(path)).lines).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(after);
  });
});

describe("the upgrade of an older setup's settings", () => {
  /** The settings an older setup leaves: its rows without `behavesAs`, its base URL without tool search. */
  const oldSettings = (): Record<string, unknown> => ({
    modelPicker: {
      options: [
        { model: "glm-5.3", label: "GLM 5.3" },
        { model: "glm-5.3-flash", label: "GLM 5.3 Flash" },
      ],
    },
    env: { ANTHROPIC_BASE_URL: ROUTER },
  });
  /** That setup's ledger: it owns the rows and the containers, and it never recorded tool search. */
  const oldUndo = (): SettingsUndo => ({
    baseUrlBefore: null,
    optionsAdded: ["glm-5.3", "glm-5.3-flash"],
    availableAppended: [],
    createdModelPicker: true,
    createdOptions: true,
    createdEnv: true,
    createdToolSearch: false,
    effortsAdded: {},
  });
  /** The apply as the setup flow runs it, with the old ledger's ids and its delta captured. */
  const upgrade = async (
    path: string,
  ): Promise<{ readonly lines: readonly string[]; readonly delta: SettingsDelta | undefined }> => {
    let delta: SettingsDelta | undefined;
    const applied = await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER, {
      ownOptions: oldUndo().optionsAdded,
      record: (recorded) => {
        delta = recorded;
      },
    });
    if (!applied.ok) throw new Error(applied.error);
    return { lines: applied.value, delta };
  };

  it("adds behavesAs to the rows it added before and tool search on the already-set base URL, and records both", async () => {
    const path = settingsPath();
    write(path, oldSettings());

    const { lines, delta } = await upgrade(path);

    expect(lines).toEqual([
      "set behavesAs on the GLM 5.3 (glm-5.3) row in /model",
      "set behavesAs on the GLM 5.3 Flash (glm-5.3-flash) row in /model",
      "set GLM 5.3 default effort to xhigh",
      "set GLM 5.3 Flash default effort to xhigh",
      "turned on MCP tool search",
    ]);
    expect(read(path)).toEqual({
      modelPicker: {
        options: [
          { model: "glm-5.3", label: "GLM 5.3", behavesAs: "claude-opus-5-5" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash", behavesAs: "claude-opus-5-5" },
        ],
      },
      env: { ANTHROPIC_BASE_URL: ROUTER, ENABLE_TOOL_SEARCH: "true" },
      modelSettings: {
        "glm-5.3": { effortLevel: "xhigh" },
        "glm-5.3-flash": { effortLevel: "xhigh" },
      },
    });
    expect(delta).toMatchObject({
      optionsAdded: [],
      createdToolSearch: true,
      effortsAdded: { "glm-5.3": "xhigh", "glm-5.3-flash": "xhigh" },
    });
  });

  it("leaves a row the user wrote themselves, and the user's own tool-search value", async () => {
    const path = settingsPath();
    write(path, {
      modelPicker: {
        options: [
          { model: "glm-5.3", label: "GLM 5.3", note: "mine" },
          { model: "glm-5.3-flash", label: "Flash, mine" },
        ],
      },
      env: { ANTHROPIC_BASE_URL: ROUTER, ENABLE_TOOL_SEARCH: "false" },
      modelSettings: {
        "glm-5.3": { effortLevel: "low" },
        "glm-5.3-flash": { effortLevel: "medium" },
      },
    });

    let delta: SettingsDelta | undefined;
    const applied = await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER, {
      ownOptions: [],
      record: (recorded) => {
        delta = recorded;
      },
    });
    if (!applied.ok) throw new Error(applied.error);

    expect(applied.value).toEqual(["updated the GLM 5.3 Flash (glm-5.3-flash) label in /model"]);
    expect(read(path)).toEqual({
      modelPicker: {
        options: [
          { model: "glm-5.3", label: "GLM 5.3", note: "mine" },
          { model: "glm-5.3-flash", label: "GLM 5.3 Flash" },
        ],
      },
      env: { ANTHROPIC_BASE_URL: ROUTER, ENABLE_TOOL_SEARCH: "false" },
      modelSettings: {
        "glm-5.3": { effortLevel: "low" },
        "glm-5.3-flash": { effortLevel: "medium" },
      },
    });
    expect(delta).toMatchObject({ optionsAdded: [], createdToolSearch: false, effortsAdded: {} });
  });

  it("is idempotent: the run after the upgrade reports no changes and rewrites nothing", async () => {
    const path = settingsPath();
    write(path, oldSettings());
    await upgrade(path);
    const upgraded = readFileSync(path, "utf8");

    expect((await upgrade(path)).lines).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(upgraded);
  });

  it("undoes the upgrade through the merged ledger, back to an empty file", async () => {
    const path = settingsPath();
    write(path, oldSettings());
    const { delta } = await upgrade(path);
    const undo = mergeSettingsUndo(oldUndo(), delta);

    const undone = await undoProviderSettings(path, "zai", undo, ROUTER, []);
    expect(undone).toMatchObject({
      ok: true,
      value: expect.arrayContaining(["removed ENABLE_TOOL_SEARCH"]),
    });
    expect(read(path)).toEqual({});
  });
});
