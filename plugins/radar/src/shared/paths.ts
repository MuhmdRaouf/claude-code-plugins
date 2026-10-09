import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsStateDir, migrateStateDir } from "./state-migrate.ts";

/** Everything radar writes lives under one state dir (0700), files 0600; RADAR_HOME overrides it. */
export function stateDir(env: NodeJS.ProcessEnv): string {
  if (env.RADAR_HOME !== undefined) return env.RADAR_HOME;
  migrateStateDir("radar", env);
  return agentsStateDir(env, "radar");
}

export function spoolDir(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "spool");
}

export function serverInfoPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "server.json");
}

export function hookErrorLog(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "hook-errors.log");
}

/** The persistent history database: past sessions, their subagents and jobs, and each request's text. */
export function historyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "history.db");
}

/** Claude Code transcripts live under $CLAUDE_CONFIG_DIR/projects (default ~/.claude/projects). */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
}

export function zaiStateDir(env: NodeJS.ProcessEnv): string {
  return providerStateDir(env, "zai");
}

/** A provider plugin's state dir: $<NAME>_STATE_DIR, else ~/.agents/<name> — where its jobs live. */
export function providerStateDir(env: NodeJS.ProcessEnv, name: string): string {
  const override = env[`${name.toUpperCase()}_STATE_DIR`];
  if (override !== undefined) return override;
  migrateStateDir(name, env);
  return agentsStateDir(env, name);
}

/**
 * The marker that says "this directory is radar's own state dir". Only a directory carrying it may ever be
 * deleted recursively (lifecycle/removal.ts): RADAR_HOME can name anything, $HOME included.
 */
export const STATE_MARKER = ".radar-state";

/** Everything radar itself puts in its state dir; a dir holding only these (and dotfiles) is ours. */
const OWN_ENTRIES = new Set([
  "spool",
  "server.json",
  "hook-errors.log",
  "autostart",
  "port",
  "ledger",
  "budgets.json",
  "budget-status.json",
  "settings.json",
  "dismissed.json",
  "notified.json",
  "history.db",
  "history.db-wal",
  "history.db-shm",
]);

export function stateMarkerPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), STATE_MARKER);
}

/**
 * Mark the state dir as ours when we just created it, or when it holds nothing but radar's own files. A
 * pre-existing directory with anything else in it is never marked.
 */
function markStateDir(env: NodeJS.ProcessEnv, created: boolean): void {
  const marker = stateMarkerPath(env);
  if (existsSync(marker)) return;
  if (!created && !readdirSync(stateDir(env)).every((name) => OWN_ENTRIES.has(name))) return;
  writeFileSync(marker, "radar state dir: removed with the plugin\n", { mode: 0o600 });
}

/** The port the dashboard last listened on: kept across stops and reboots, so its address does not move. */
export function portPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "port");
}

/** The saved port, or null (none yet, or unreadable). */
export function savedPort(env: NodeJS.ProcessEnv): number | null {
  try {
    const port = Number(readFileSync(portPath(env), "utf8").trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** Remember the port the dashboard listens on; never throws (only a convenience). */
export function savePort(env: NodeJS.ProcessEnv, port: number): void {
  try {
    if (ensureStateDirs(env)) writeFileSync(portPath(env), `${port}\n`, { mode: 0o600 });
  } catch {
    // the next start draws a port again
  }
}

/** Present once `start` ran and until `stop`: the SessionStart hook brings the dashboard back after a reboot. */
export function autostartPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "autostart");
}

/**
 * Should a SessionStart hook start the server? RADAR_AUTOSTART decides when it is set (1 yes, anything else
 * no); otherwise yes once the user started the dashboard with `start` and has not stopped it since, so nothing
 * needs configuring after the first `/radar:start`.
 */
export function wantsAutostart(env: NodeJS.ProcessEnv): boolean {
  if (env.RADAR_AUTOSTART !== undefined) return env.RADAR_AUTOSTART === "1";
  return existsSync(autostartPath(env));
}

/** Remember (start) or forget (stop) that the dashboard should come back with the next session; never throws. */
export function rememberAutostart(env: NodeJS.ProcessEnv, on: boolean): void {
  try {
    if (!on) rmSync(autostartPath(env), { force: true });
    else if (ensureStateDirs(env))
      writeFileSync(autostartPath(env), "start the dashboard with the next session\n", { mode: 0o600 });
  } catch {
    // only a convenience: the dashboard still runs now
  }
}

/** Create the state dir (and the spool dir) with 0700, root included; never throws for read-only use. */
export function ensureStateDirs(env: NodeJS.ProcessEnv): boolean {
  try {
    const created = mkdirSync(stateDir(env), { recursive: true, mode: 0o700 }) !== undefined;
    markStateDir(env, created);
    mkdirSync(spoolDir(env), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The plugin's public dir. From the bundle (<plugin>/dist/radar.js) it is the sibling <plugin>/public/,
 * wherever the plugin is installed (Claude Code copies only plugin/ into its cache); from the sources
 * (src/shared/paths.ts, tests) it is plugin/public/ two levels up.
 */
export function publicDir(env: NodeJS.ProcessEnv, from: string = import.meta.url): string {
  if (env.RADAR_PUBLIC_DIR !== undefined) return env.RADAR_PUBLIC_DIR;
  const bundled = fileURLToPath(new URL("../public/", from));
  return existsSync(join(bundled, "index.html"))
    ? bundled
    : fileURLToPath(new URL("../../plugin/public/", from));
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
