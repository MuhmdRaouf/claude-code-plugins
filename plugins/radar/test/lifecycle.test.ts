// The server outlives the plugin that started it, so it watches Claude Code's plugin registry and
// cleans up after itself (src/lifecycle/removal.ts): unreadable files never act, two consecutive
// readings that agree do, an uninstall takes the state dir and a disable keeps it.

import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pluginPresence,
  REMOVAL_INTERVAL_MS,
  removalIntervalMs,
  removeStateTree,
  watchRemoval,
} from "../src/lifecycle/removal.ts";
import { startApp } from "../src/server/app.ts";
import { createFlightTracker } from "../src/server/http.ts";
import { ensureStateDirs, serverInfoPath, stateDir } from "../src/shared/paths.ts";
import { makeEnv, waitFor, writeText } from "./helpers.ts";

const KEY = "radar@muhmdraouf";
const ENTRY = [{ scope: "user", installPath: "/x", version: "1" }];

/** The registry exactly as Claude Code writes it: the map under "plugins", entries as lists. */
function install(config: string, plugins: Record<string, unknown> = { [KEY]: ENTRY }): void {
  writeText(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

function uninstalledRegistry(config: string): void {
  install(config, { "other@market": ENTRY }); // others remain, ours is gone
}

function userSettings(config: string, enabledPlugins: Record<string, boolean>): void {
  writeText(join(config, "settings.json"), JSON.stringify({ enabledPlugins }));
}

/** A project dir whose `.claude/settings.json` / `settings.local.json` say what it says. */
function project(name: string, files: Record<string, Record<string, boolean>>): string {
  const dir = mkdtempSync(join(tmpdir(), `radar-${name}-`));
  for (const [file, enabledPlugins] of Object.entries(files)) {
    writeText(join(dir, ".claude", file), JSON.stringify({ enabledPlugins }));
  }
  return dir;
}

describe("pluginPresence", () => {
  it("reads unknown while the registry is missing, half-written, or not the shape Claude Code writes", () => {
    const { env, config } = makeEnv();
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("unknown"); // not there yet
    writeText(join(config, "plugins", "installed_plugins.json"), "{half-written");
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("unknown"); // torn write
    install(config, { [KEY]: "not a list" });
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("unknown"); // foreign shape
  });

  it("reads uninstalled when no key names the plugin, under any marketplace", () => {
    const { env, config } = makeEnv();
    install(config);
    uninstalledRegistry(config);
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("uninstalled");
    install(config, {}); // nothing installed at all
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("uninstalled");
    install(config, { "radar@fork": ENTRY });
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("present"); // a fork counts
  });

  it("lets the user scope switch the plugin off, and a known project switch it back on", () => {
    const { env, config } = makeEnv();
    install(config);
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("present"); // no settings at all
    writeText(join(config, "settings.json"), "{oops");
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("unknown"); // unreadable
    userSettings(config, { [KEY]: true });
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("present");
    userSettings(config, { [KEY]: false });
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [] })).toBe("disabled");
    const quiet = project("quiet", { "settings.json": { [KEY]: false } });
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [quiet] })).toBe("disabled");
    const enabling = project("enabling", { "settings.json": { [KEY]: true } });
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [quiet, enabling] })).toBe("present");
    const local = project("local", { "settings.local.json": { [KEY]: true } });
    expect(pluginPresence({ env, plugin: "radar", projectDirs: () => [local] })).toBe("present");
  });
});

describe("watchRemoval", () => {
  it("acts once, after two consecutive checks agree; present or unknown in between resets", async () => {
    const { env, config } = makeEnv();
    install(config);
    const removed: string[] = [];
    const watch = watchRemoval({
      env,
      plugin: "radar",
      projectDirs: () => [],
      intervalMs: 3_600_000,
      onRemove: (kind) => {
        removed.push(kind);
      },
    });
    await watch.tick(); // present
    expect(removed).toEqual([]);
    writeText(join(config, "plugins", "installed_plugins.json"), "{torn"); // unknown, resets
    await watch.tick();
    uninstalledRegistry(config); // first sighting
    await watch.tick();
    expect(removed).toEqual([]);
    writeText(join(config, "plugins", "installed_plugins.json"), "{torn"); // unknown again, resets
    await watch.tick();
    uninstalledRegistry(config);
    await watch.tick(); // first sighting after the reset
    await watch.tick(); // agrees — acts
    expect(removed).toEqual(["uninstalled"]);
    await watch.tick(); // the watch is done
    expect(removed).toEqual(["uninstalled"]);
  });

  it("does not add a disable and an uninstall up: two of a kind act, mixed readings do not", async () => {
    const { env, config } = makeEnv();
    install(config);
    userSettings(config, { [KEY]: false });
    const removed: string[] = [];
    const watch = watchRemoval({
      env,
      plugin: "radar",
      projectDirs: () => [],
      intervalMs: 3_600_000,
      onRemove: (kind) => {
        removed.push(kind);
      },
    });
    await watch.tick(); // disabled, once
    uninstalledRegistry(config); // the story changes
    await watch.tick(); // disagrees with the last sighting: start over
    expect(removed).toEqual([]);
    await watch.tick(); // twice the same
    expect(removed).toEqual(["uninstalled"]);
    watch.stop();
  });
});

describe("removeStateTree", () => {
  it("takes the whole state dir with it", () => {
    const { env, state } = makeEnv();
    expect(ensureStateDirs(env)).toBe(true);
    writeText(join(state, "spool", "today.jsonl"), "{}\n");
    expect(removeStateTree(env)).toBe(true);
    expect(existsSync(state)).toBe(false);
  });

  it("never deletes a directory without radar's marker, whatever RADAR_HOME names", () => {
    const { env, home } = makeEnv();
    const foreign = join(home, "projects");
    writeText(join(foreign, "spool", "today.jsonl"), "{}\n");
    writeText(join(foreign, "thesis.md"), "years of work\n");
    const pointed = { ...env, RADAR_HOME: foreign };
    expect(ensureStateDirs(pointed)).toBe(true); // used as a state dir, but it holds the user's files: no marker
    expect(removeStateTree(pointed)).toBe(false);
    expect(existsSync(join(foreign, "thesis.md"))).toBe(true);
  });

  it("reports a failure without throwing", () => {
    const home = mkdtempSync(join(tmpdir(), "radar-guard-"));
    const env = { HOME: home, RADAR_HOME: join(home, "guard", "state") };
    expect(ensureStateDirs(env)).toBe(true);
    writeText(join(home, "guard", "state", "spool", "today.jsonl"), "{}\n");
    chmodSync(join(home, "guard"), 0o500); // nothing may be unlinked below it
    try {
      expect(removeStateTree(env)).toBe(false);
    } finally {
      chmodSync(join(home, "guard"), 0o700);
    }
  });
});

describe("removalIntervalMs", () => {
  it("takes the override, then the env, then the default", () => {
    const { env } = makeEnv();
    expect(removalIntervalMs(env, 25)).toBe(25);
    expect(removalIntervalMs(env)).toBe(REMOVAL_INTERVAL_MS);
    expect(removalIntervalMs({ ...env, RADAR_REMOVAL_MS: "250" })).toBe(250);
    expect(removalIntervalMs({ ...env, RADAR_REMOVAL_MS: "" })).toBe(REMOVAL_INTERVAL_MS);
    expect(removalIntervalMs({ ...env, RADAR_REMOVAL_MS: "soon" })).toBe(REMOVAL_INTERVAL_MS);
    expect(removalIntervalMs({ ...env, RADAR_REMOVAL_MS: "0" })).toBe(REMOVAL_INTERVAL_MS);
  });
});

describe("createFlightTracker", () => {
  it("is idle at once with nothing counted, and wakes when the last counted response closes", async () => {
    const flights = createFlightTracker();
    await expect(flights.whenIdle(1_000)).resolves.toBeUndefined();
    const first = new EventEmitter() as unknown as ServerResponse;
    const second = new EventEmitter() as unknown as ServerResponse;
    flights.track(first);
    flights.track(second);
    let done = false;
    void flights.whenIdle(1_000).then(() => {
      done = true;
    });
    first.emit("close");
    await new Promise((sleep) => setTimeout(sleep, 20));
    expect(done).toBe(false); // one still out
    second.emit("close");
    await new Promise((sleep) => setTimeout(sleep, 20));
    expect(done).toBe(true);
  });

  it("gives up after the timeout rather than waiting forever", async () => {
    const flights = createFlightTracker();
    flights.track(new EventEmitter() as unknown as ServerResponse);
    const before = Date.now();
    await expect(flights.whenIdle(25)).resolves.toBeUndefined();
    expect(Date.now() - before).toBeGreaterThanOrEqual(20); // the timeout, not a close, ended it
  });
});

/** True when the port refuses the connection — the socket is gone. */
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/health", method: "GET" }, () =>
      resolve(false),
    );
    req.on("error", () => resolve(true));
    req.end();
  });
}

describe("the app removes itself", () => {
  it("stops, deletes its state dir and exits 0 when two checks agree the plugin is uninstalled", async () => {
    const { env, config, state } = makeEnv();
    install(config);
    const codes: number[] = [];
    const app = await startApp({
      env,
      version: "test",
      sinceMs: 3_600_000,
      intervalMs: 3_600_000,
      removalIntervalMs: 15,
      exit: (code) => codes.push(code),
    });
    try {
      expect(app.store.sessionList()).toEqual([]); // up and serving
      writeText(join(state, "spool", "today.jsonl"), "{}\n"); // something to take with us
      uninstalledRegistry(config);
      await waitFor("exit after removal", 5_000, () => (codes.length > 0 ? codes : null));
      expect(codes).toEqual([0]);
      expect(existsSync(stateDir(env))).toBe(false); // the whole state dir went
      expect(existsSync(serverInfoPath(env))).toBe(false);
      expect(await refused(app.port)).toBe(true); // not accepting anything
    } finally {
      await app.stop(); // already stopped: an idempotent second stop
    }
  });

  it("stops and exits 0 on disable, but keeps the state dir for the reinstall", async () => {
    const { env, config, state } = makeEnv();
    install(config);
    const codes: number[] = [];
    const app = await startApp({
      env,
      version: "test",
      sinceMs: 3_600_000,
      intervalMs: 3_600_000,
      removalIntervalMs: 15,
      exit: (code) => codes.push(code),
    });
    try {
      const spool = writeText(join(state, "spool", "today.jsonl"), "{}\n"); // the history that stays
      userSettings(config, { [KEY]: false });
      await waitFor("exit after disable", 5_000, () => (codes.length > 0 ? codes : null));
      expect(codes).toEqual([0]);
      expect(existsSync(spool)).toBe(true); // the state dir stayed…
      expect(existsSync(serverInfoPath(env))).toBe(false); // …while the server's own file went
      expect(await refused(app.port)).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it("keeps serving through a torn registry and a torn settings file", async () => {
    const { env, config } = makeEnv();
    install(config);
    const codes: number[] = [];
    const app = await startApp({
      env,
      version: "test",
      sinceMs: 3_600_000,
      intervalMs: 3_600_000,
      removalIntervalMs: 15,
      exit: (code) => codes.push(code),
    });
    try {
      writeText(join(config, "plugins", "installed_plugins.json"), "{torn");
      writeText(join(config, "settings.json"), "{torn");
      await new Promise((sleep) => setTimeout(sleep, 120)); // several checks, all unknown
      expect(codes).toEqual([]);
      install(config); // back to installed and enabled
      await new Promise((sleep) => setTimeout(sleep, 120)); // still installed: nothing happens
      expect(codes).toEqual([]);
      expect(await refused(app.port)).toBe(false); // still serving
    } finally {
      await app.stop();
    }
  });
});
