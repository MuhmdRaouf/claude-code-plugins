import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProviderSettings,
  type SettingsDelta,
  settingsBackupPath,
  undoProviderSettings,
} from "../../src/adapters/claude-settings.ts";
import { stateLayout } from "../../src/domain/state-layout.ts";
import { startEmergency } from "../../src/router/emergency.ts";
import { type Ledger, mergeSettingsUndo, readLedger, writeLedger } from "../../src/router/ledger.ts";
import { freePort } from "../../src/router/process.ts";
import {
  createUninstallWatch,
  type Presence,
  pluginPresence,
  removeRouterFiles,
  writeLeftBehind,
} from "../../src/router/uninstall.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const ROUTER = "http://127.0.0.1:18787";
const KIMI = "http://127.0.0.1:18788";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("plugin presence", () => {
  function config(): string {
    const dir = tempDir("router-presence-");
    mkdirSync(join(dir, "plugins"), { recursive: true });
    return dir;
  }
  const installed = (dir: string, plugins: unknown): void =>
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify(plugins));

  it("is unknown while installed_plugins.json is missing or half-written, absent once the plugin is gone", () => {
    const dir = config();
    expect(pluginPresence("zai", dir, undefined)).toBe("unknown");
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), '{"version": 2, "plug');
    expect(pluginPresence("zai", dir, undefined)).toBe("unknown");
    installed(dir, { version: 2, plugins: { "kimi-plugin-cc@m": [{ scope: "user" }] } });
    expect(pluginPresence("zai", dir, undefined)).toBe("absent");
  });

  it("is present when installed and not turned off, in the v2 and the flat shape", () => {
    const dir = config();
    installed(dir, { version: 2, plugins: { "zai-plugin-cc@muhmdraouf": [{ scope: "user" }] } });
    expect(pluginPresence("zai", dir, undefined)).toBe("present");
    installed(dir, { "zai-plugin-cc@muhmdraouf": "not a list" });
    expect(pluginPresence("zai", dir, undefined)).toBe("present");
  });

  it("is absent when the data dir's marker is gone (uninstall deletes it)", () => {
    const dir = config();
    installed(dir, { version: 2, plugins: { "zai-plugin-cc@m": [{ scope: "user" }] } });
    const marker = join(dir, "installed");
    expect(pluginPresence("zai", dir, marker)).toBe("absent");
    writeFileSync(marker, "x");
    expect(pluginPresence("zai", dir, marker)).toBe("present");
  });

  it("is disabled only when every scope it is installed in says false", () => {
    const dir = config();
    const project = tempDir("router-project-");
    mkdirSync(join(project, ".claude"), { recursive: true });
    installed(dir, {
      version: 2,
      plugins: {
        "zai-plugin-cc@m": [
          { scope: "user" },
          { scope: "project", projectPath: project },
          { scope: "local", projectPath: project },
          null,
        ],
      },
    });
    const off = { enabledPlugins: { "zai-plugin-cc@m": false } };
    writeFileSync(join(dir, "settings.json"), JSON.stringify(off));
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify(off));
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify(off));
    // The null entry counts as a user install, whose settings say false.
    expect(pluginPresence("zai", dir, undefined)).toBe("disabled");
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: {} }));
    expect(pluginPresence("zai", dir, undefined)).toBe("present");
  });
});

describe("the uninstall watch", () => {
  function ledger(root: string): Ledger {
    return {
      version: 1,
      plugin: "zai",
      routerUrl: ROUTER,
      settingsPath: join(root, "settings.json"),
      settings: mergeSettingsUndo(undefined, undefined),
      keystore: { created: false },
      routerFiles: [],
      stateRoot: root,
    };
  }

  function harness(answers: Presence[]) {
    const root = tempDir("router-watch-");
    const calls: string[] = [];
    const watch = createUninstallWatch({
      stateRoot: root,
      actions: {
        presence: () => answers.shift() ?? "present",
        undo: async () => {
          calls.push("undo");
        },
        remove: async (_ledger, disabled) => {
          calls.push(disabled ? "remove disabled" : "remove");
        },
      },
    });
    return { root, calls, watch };
  }

  it("does nothing without a ledger", async () => {
    const { watch, calls } = harness(["absent", "absent"]);
    expect(watch.everyMs).toBe(10_000);
    expect(await watch.tick()).toBe("stay");
    expect(await watch.tick()).toBe("stay");
    await watch.cleanup();
    expect(calls).toEqual([]);
  });

  it("needs two consecutive gone answers: an update window (unknown, then present) cleans nothing", async () => {
    const { root, watch, calls } = harness(["absent", "unknown", "absent", "present", "absent"]);
    writeLedger(stateLayout(root).ledger, ledger(root));
    for (let i = 0; i < 5; i++) expect(await watch.tick()).toBe("stay");
    await watch.cleanup();
    expect(calls).toEqual([]);
  });

  it("undoes after two gone answers and says retire; the cleanup removes the rest when the front exits", async () => {
    const { root, watch, calls } = harness(["absent", "absent"]);
    writeLedger(stateLayout(root).ledger, ledger(root));
    expect(await watch.tick()).toBe("stay");
    expect(await watch.tick()).toBe("retire");
    expect(calls).toEqual(["undo"]);
    expect(existsSync(stateLayout(root).ledger)).toBe(false);
    // The ledger lives on in memory: the plugin's data dir may be gone already.
    expect(await watch.tick()).toBe("retire");
    await watch.cleanup();
    expect(calls).toEqual(["undo", "remove"]);
  });

  it("disable keeps the ledger as ledger.disabled.json; setting up again before the exit cancels the cleanup", async () => {
    const { root, watch, calls } = harness(["disabled", "disabled"]);
    writeLedger(stateLayout(root).ledger, ledger(root));
    await watch.tick();
    expect(await watch.tick()).toBe("retire");
    expect(readLedger(stateLayout(root).disabledLedger)).toEqual(ledger(root));
    // Re-enabled: the hook re-applied setup, which wrote a new ledger.
    writeLedger(stateLayout(root).ledger, ledger(root));
    await watch.cleanup();
    expect(calls).toEqual(["undo"]);
  });

  it("tells a disabled cleanup from an uninstall", async () => {
    const { root, watch, calls } = harness(["disabled", "disabled"]);
    writeLedger(stateLayout(root).ledger, ledger(root));
    await watch.tick();
    await watch.tick();
    await watch.cleanup();
    expect(calls).toEqual(["undo", "remove disabled"]);
  });

  it("leaves a note for undecided jobs, and removes the router's own files", () => {
    const root = tempDir("router-watch-");
    writeLeftBehind(root, "zai", []);
    expect(existsSync(join(root, "LEFT-BEHIND.md"))).toBe(false);
    writeLeftBehind(root, "zai", [{ id: "j1", worktree: "/w/j1" }, { id: "j2" }]);
    expect(readFileSync(join(root, "LEFT-BEHIND.md"), "utf8")).toContain("- j1: /w/j1\n- j2\n");
    mkdirSync(join(root, "router"));
    writeFileSync(join(root, "router.pid"), "{}");
    writeFileSync(join(root, "router.retired"), "{}");
    removeRouterFiles(root);
    expect(existsSync(join(root, "router"))).toBe(false);
    expect(existsSync(join(root, "router.pid"))).toBe(false);
    expect(existsSync(join(root, "router.retired"))).toBe(false);
  });
});

describe("undoing the settings", () => {
  function settings(text: string): string {
    const dir = tempDir("router-undo-");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const path = join(dir, ".claude", "settings.json");
    writeFileSync(path, text);
    return path;
  }

  async function setUp(path: string, live: readonly string[] = []): Promise<SettingsDelta> {
    let delta: SettingsDelta | undefined;
    const applied = await applyProviderSettings(path, REFERENCE_PROVIDER, ROUTER, {
      livePluginUrls: live,
      record: (recorded) => {
        delta = recorded;
      },
    });
    expect(applied.ok).toBe(true);
    return delta as SettingsDelta;
  }

  it("setup then uninstall leaves settings.json byte-identical, even in the user's own formatting", async () => {
    const original = '{\n    "theme": "dark",\n    "permissions": { "allow": [] }\n}\n';
    const path = settings(original);
    const delta = await setUp(path);
    expect(readFileSync(settingsBackupPath(path, "zai"), "utf8")).toBe(original);
    const undone = await undoProviderSettings(path, "zai", mergeSettingsUndo(undefined, delta), ROUTER, []);
    expect(undone.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("reverts only this plugin's keys when the user edited another key in between", async () => {
    const path = settings(`${JSON.stringify({ theme: "dark", availableModels: ["sonnet"] }, null, 2)}\n`);
    const delta = await setUp(path);
    const edited = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    edited.theme = "light";
    writeFileSync(path, JSON.stringify(edited));
    await undoProviderSettings(path, "zai", mergeSettingsUndo(undefined, delta), ROUTER, []);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "light", availableModels: ["sonnet"] });
  });

  it("leaves a base URL the user changed meanwhile alone", async () => {
    const path = settings("{}\n");
    const delta = await setUp(path);
    const edited = JSON.parse(readFileSync(path, "utf8")) as { env: Record<string, string> };
    edited.env.ANTHROPIC_BASE_URL = "https://my-proxy.example";
    writeFileSync(path, JSON.stringify(edited));
    await undoProviderSettings(path, "zai", mergeSettingsUndo(undefined, delta), ROUTER, []);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      env: { ANTHROPIC_BASE_URL: "https://my-proxy.example" },
    });
  });

  it("repoints at the surviving plugin's router when two were set up and one is removed", async () => {
    const path = settings("{}\n");
    const delta = await setUp(path);
    await undoProviderSettings(path, "zai", mergeSettingsUndo(undefined, delta), ROUTER, [KIMI]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: KIMI } });
  });

  it("puts a previous base URL back unless it is a plugin router that is not running", async () => {
    const proxy = settings(`${JSON.stringify({ env: { ANTHROPIC_BASE_URL: KIMI } })}\n`);
    const delta = await setUp(proxy);
    expect(delta.baseUrlBefore).toBe(KIMI);
    await undoProviderSettings(proxy, "zai", mergeSettingsUndo(undefined, delta), ROUTER, []);
    // The kimi router it replaced is not running: nothing to point at.
    expect(JSON.parse(readFileSync(proxy, "utf8"))).toEqual({ env: {} });

    const live = settings(`${JSON.stringify({ env: { ANTHROPIC_BASE_URL: KIMI } })}\n`);
    const again = await setUp(live);
    await undoProviderSettings(live, "zai", mergeSettingsUndo(undefined, again), ROUTER, [KIMI]);
    expect(JSON.parse(readFileSync(live, "utf8"))).toEqual({ env: { ANTHROPIC_BASE_URL: KIMI } });
  });

  it("keeps a live plugin router's base URL at setup instead of moving it", async () => {
    const path = settings(`${JSON.stringify({ env: { ANTHROPIC_BASE_URL: KIMI } })}\n`);
    const delta = await setUp(path, [KIMI]);
    expect(delta.baseUrlBefore).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf8")).env).toEqual({ ANTHROPIC_BASE_URL: KIMI });
  });
});

describe("the emergency passthrough (in process)", () => {
  it("answers its health, pipes Claude to Anthropic, refuses provider models, and hands over with the token", async () => {
    const anthropic = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => res.end("anthropic bytes"));
    });
    await new Promise<void>((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
    closers.push(() => anthropic.close());
    const port = await freePort();
    let done = 0;
    const listener = await startEmergency({
      name: "acme",
      display: "Acme Models",
      healthPath: "/acme-router/health",
      claim: { ids: [], prefixes: ["big-"] },
      port,
      anthropic: new URL(`http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`),
      env: {},
      token: "secret",
      done: () => {
        done += 1;
      },
    });
    closers.push(() => listener.close());
    const base = `http://127.0.0.1:${port}`;
    expect(await (await fetch(`${base}/acme-router/health`)).json()).toEqual({
      ok: true,
      mode: "emergency",
      name: "acme",
      provider: "Acme Models",
    });
    const post = (body: string, path = "/v1/messages") => fetch(`${base}${path}`, { method: "POST", body });
    expect(await (await post('{"model":"claude-x"}')).text()).toBe("anthropic bytes");
    const refused = await post('{"model":"big-1"}');
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain("in emergency passthrough");
    const wrongHost = await new Promise<number>((resolve) =>
      http.get({ host: "127.0.0.1", port, path: "/x", headers: { host: "evil" }, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }),
    );
    expect(wrongHost).toBe(421);
    expect((await fetch(`${base}/acme-router/health/handover`, { method: "POST" })).status).toBe(403);
    const handed = await fetch(`${base}/acme-router/health/handover`, {
      method: "POST",
      headers: { "x-provider-router-token": "secret" },
    });
    expect(await handed.json()).toEqual({ ok: true });
    for (let i = 0; i < 100 && done === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBeGreaterThan(0);
  });
});
