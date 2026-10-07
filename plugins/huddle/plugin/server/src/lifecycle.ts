// src/lifecycle.ts — the server outlives the plugin that started it: Claude Code has no uninstall
// hook, so a server started by `huddle up` (which sets HUDDLE_REMOVAL_WATCH) watches the plugin
// registry and stops itself when the huddle plugin is uninstalled or disabled. Two files under
// $CLAUDE_CONFIG_DIR (default ~/.claude) tell the story:
//   plugins/installed_plugins.json   {"version": 2, "plugins": {"<plugin>@<marketplace>": [{scope, installPath, version}]}}
//   settings.json                    {"enabledPlugins": {"<plugin>@<marketplace>": true | false}}
// The plugin is "uninstalled" when no key names it (any marketplace: a fork of this plugin must
// not look uninstalled), "disabled" when the user scope says false and no known project's
// settings (.claude/settings.json, .claude/settings.local.json) say true, "present" otherwise —
// and "unknown" while a file is missing or half-written. Unknown never acts, and only two
// consecutive checks that agree on the same verdict do (a torn write is never an uninstall).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Presence = "present" | "disabled" | "uninstalled" | "unknown";
export type Gone = "uninstalled" | "disabled";

// ENOENT is a fact (nothing there); any other read failure, or a body that is not JSON, is not
function readJson(path: string): { state: "missing" } | { state: "unreadable" } | { state: "ok"; value: unknown } {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" }; }
  try { return { state: "ok", value: JSON.parse(text) }; } catch { return { state: "unreadable" }; }
}
const record = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const enabledOf = (s: unknown): Record<string, any> | null => (record(s) && record(s.enabledPlugins) ? s.enabledPlugins : null);

export function presence(env: NodeJS.ProcessEnv, plugin: string, projects: string[]): Presence {
  const config = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
  const file = readJson(join(config, "plugins", "installed_plugins.json"));
  if (file.state !== "ok" || !record(file.value)) return "unknown";
  const table = record(file.value.plugins) ? file.value.plugins : file.value; // the map sits under "plugins", or is the whole file
  if (!Object.values(table).every(Array.isArray)) return "unknown"; // not the shape Claude Code writes
  const keys = Object.keys(table).filter(k => { const at = k.lastIndexOf("@"); return at > 0 && k.slice(0, at) === plugin; });
  if (!keys.length) return "uninstalled";
  const user = readJson(join(config, "settings.json"));
  if (user.state === "missing") return "present"; // no settings at all: nothing disables anything
  if (user.state !== "ok" || !record(user.value)) return "unknown";
  const userEnabled = enabledOf(user.value);
  if (!userEnabled || keys.some(k => userEnabled[k] !== false)) return "present";
  for (const p of projects) for (const f of [join(p, ".claude", "settings.json"), join(p, ".claude", "settings.local.json")]) {
    const s = readJson(f);
    if (s.state === "ok") { const e = enabledOf(s.value); if (e && keys.some(k => e[k] === true)) return "present"; }
  }
  return "disabled";
}

export type Watch = { tick(): Promise<void>; stop(): void };

// Check every ms (10 s; HUDDLE_REMOVAL_MS overrides, for tests) and call gone() once, only after
// two consecutive checks agreed; present and unknown reset the count. tick() is the same check on
// demand. gone() decides what "gone" means; this file only decides that it is time.
export function watchRemoval(o: { env: NodeJS.ProcessEnv; plugin: string; projects(): string[]; ms?: number; gone(kind: Gone): void | Promise<void> }): Watch {
  let seen: Gone | null = null, fired = false, timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const tick = async () => {
    const p = presence(o.env, o.plugin, o.projects());
    if (p !== "uninstalled" && p !== "disabled") { seen = null; return; }
    if (fired || seen !== p) { seen = p; return; } // one sighting is not enough; the next check must agree
    fired = true;
    stop();
    await o.gone(p);
  };
  const ms = typeof o.ms === "number" && o.ms > 0 ? o.ms : 10_000;
  timer = setInterval(() => { void tick(); }, ms);
  timer.unref?.();
  return { tick, stop };
}

// the run files leave with the server: the pid (its lock on the home), its log, the hooks' log and their state (what each session
// already saw, the asks a stop was blocked for); nothing a person wrote
export function removeRunFiles(home: string): void {
  for (const f of ["huddle.pid", "huddle.log", "hooks.log", "stop-raised.json"]) rmSync(join(home, f), { force: true });
  rmSync(join(home, "seen"), { recursive: true, force: true });
}

export const leftBehindPath = (home: string) => join(home, "LEFT-BEHIND.md");

// what the owner needs after the plugin is gone: the channels are their conversations, so they
// stay, with the note saying where they are and how to delete them
export function writeLeftBehind(home: string, dataDir: string): void {
  const channels = join(dataDir, "channels");
  mkdirSync(home, { recursive: true });
  writeFileSync(leftBehindPath(home),
`Huddle's server stopped itself: the huddle plugin was removed from Claude Code (or
disabled) at ${new Date().toISOString()}.

The channels are still here — each file is one channel's whole conversation:
  ${channels}

To delete them:
  rm -rf "${channels}"

Everything else in ${home} (a project's huddle.json, certificates, what each session
has read) is not the server's to delete. This note can go:
  rm "${leftBehindPath(home)}"
`);
}
