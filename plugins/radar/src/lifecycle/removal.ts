/**
 * Claude Code has no uninstall hook, and this server outlives the plugin that started it: the
 * process keeps serving after `/plugin uninstall` removes the plugin's files. So the server
 * watches the registry Claude Code keeps and cleans up after itself.
 *
 * Two files under `${CLAUDE_CONFIG_DIR:-~/.claude}` tell whether the plugin is still wanted:
 *  - `plugins/installed_plugins.json` — every install, keyed `<plugin>@<marketplace>` and valued
 *    `[{scope, installPath, version}]` (the map sits under `"plugins"`).
 *  - `settings.json` — `enabledPlugins` maps the same keys to true/false. `false` in user scope
 *    disables, unless a known project re-enables it (`.claude/settings.json` or
 *    `.claude/settings.local.json` there saying `true`).
 *
 * A file that is missing, unreadable, half-written or not the documented shape reads as
 * "unknown", and unknown never acts — nor does "present". Only two consecutive checks that agree
 * on "uninstalled" or "disabled" run the callback, once.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir, stateDir, stateMarkerPath } from "../shared/paths.ts";

export type Presence = "present" | "disabled" | "uninstalled" | "unknown";

/** What the callback learns: the registry key is gone, or the plugin is switched off. */
export type RemovalKind = "uninstalled" | "disabled";

/** How often the registry is re-read; `RADAR_REMOVAL_MS` overrides, for tests. */
export const REMOVAL_INTERVAL_MS = 10_000;

type JsonFile = { state: "missing" } | { state: "unreadable" } | { state: "ok"; value: unknown };

/** ENOENT is a fact (nothing is there to read); every other failure, and a body that is not JSON, is not. */
function readJson(path: string): JsonFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "unreadable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `<plugin>@<marketplace>` keys the registry lists, or null when the file is not the registry
 * Claude Code writes (every entry a list — a shape change is a foreign file, not an uninstall).
 */
function registryKeys(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const table = isRecord(value.plugins) ? value.plugins : value;
  if (!Object.values(table).every((entry) => Array.isArray(entry))) return null;
  return Object.keys(table);
}

/** `huddle@muhmdraouf` → `huddle`; a key without `@` is not a plugin@marketplace key. */
function pluginNameOf(key: string): string | null {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : null;
}

/** The settings' `enabledPlugins` map, or null when the settings carry no such map. */
function enabledPluginsOf(settings: Record<string, unknown>): Record<string, unknown> | null {
  const map = settings.enabledPlugins;
  return isRecord(map) ? map : null;
}

/** Whether any known project's settings (project or local scope) turn the plugin back on. */
function projectsEnable(projectDirs: string[], keys: string[]): boolean {
  for (const dir of projectDirs) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = readJson(join(dir, ".claude", name));
      if (file.state !== "ok" || !isRecord(file.value)) continue;
      const enabled = enabledPluginsOf(file.value);
      if (enabled !== null && keys.some((key) => enabled[key] === true)) return true;
    }
  }
  return false;
}

export type PresenceOptions = {
  env: NodeJS.ProcessEnv;
  /** This plugin's own name — the part before `@` in its registry key. */
  plugin: string;
  /** Projects whose settings may re-enable a plugin the user scope disabled, read live per check. */
  projectDirs(): string[];
};

/** One reading of the registry: present, disabled, uninstalled — or unknown, which never acts. */
export function pluginPresence(options: PresenceOptions): Presence {
  const config = claudeConfigDir(options.env);
  const registry = readJson(join(config, "plugins", "installed_plugins.json"));
  if (registry.state !== "ok") return "unknown";
  const allKeys = registryKeys(registry.value);
  if (allKeys === null) return "unknown"; // a shape change is a foreign file, not an uninstall
  // any marketplace counts: a fork installed from its own marketplace must not look uninstalled
  const keys = allKeys.filter((key) => pluginNameOf(key) === options.plugin);
  if (keys.length === 0) return "uninstalled";
  const user = readJson(join(config, "settings.json"));
  if (user.state === "missing") return "present"; // no settings at all: nothing disables anything
  if (user.state !== "ok" || !isRecord(user.value)) return "unknown";
  const enabled = enabledPluginsOf(user.value);
  if (enabled === null || keys.some((key) => enabled[key] !== false)) return "present";
  return projectsEnable(options.projectDirs(), keys) ? "present" : "disabled";
}

export type WatchOptions = {
  env: NodeJS.ProcessEnv;
  plugin: string;
  projectDirs(): string[];
  /** Check interval; tests shorten it (the default is REMOVAL_INTERVAL_MS). */
  intervalMs?: number;
  /** Runs once, after two consecutive checks agreed on the same verdict. */
  onRemove(kind: RemovalKind): void | Promise<void>;
};

export type RemovalWatch = { tick(): Promise<void>; stop(): void };

/** Poll the registry on an interval; `tick` is the same check, for tests, on demand. */
export function watchRemoval(options: WatchOptions): RemovalWatch {
  let verdict: RemovalKind | null = null;
  let timer: NodeJS.Timeout | null = null;
  let fired = false;
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = async (): Promise<void> => {
    const found = pluginPresence(options);
    if (found !== "uninstalled" && found !== "disabled") {
      verdict = null; // present, or files that cannot tell: back to square one
      return;
    }
    if (fired || verdict !== found) {
      verdict = found; // one sighting is not enough; the next check must agree
      return;
    }
    fired = true;
    stop();
    await options.onRemove(found);
  };
  timer = setInterval(() => void tick(), options.intervalMs ?? REMOVAL_INTERVAL_MS);
  timer.unref();
  return { tick, stop };
}

/** The check interval: an explicit override wins, then `RADAR_REMOVAL_MS`, then the default. */
export function removalIntervalMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override;
  const raw = env.RADAR_REMOVAL_MS;
  if (raw === undefined || raw === "") return REMOVAL_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : REMOVAL_INTERVAL_MS;
}

/**
 * Take the whole state dir — spool, logs, server.json — the "uninstalled" case only, and only when the dir carries
 * radar's marker: RADAR_HOME may name any directory, and an unmarked one is never deleted.
 */
export function removeStateTree(env: NodeJS.ProcessEnv): boolean {
  try {
    if (!existsSync(stateMarkerPath(env))) return false;
    rmSync(stateDir(env), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
