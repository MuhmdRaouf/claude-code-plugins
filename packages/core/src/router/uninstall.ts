// Uninstall restores everything. Claude Code has no uninstall or disable hook, so the router — which outlives the
// plugin — watches for it: every 10 s it reads Claude Code's own bookkeeping, and after two consecutive "gone"
// answers (an update rewrites these very files, so one is not enough) it undoes what the ledger says setup did and the
// front retires: it keeps passing Claude requests through for the sessions that still hold its URL, and once those
// sessions are gone (or 7 days have passed) it removes its own files and exits. Disabling cleans up the same way, but
// keeps the ledger as `ledger.disabled.json` so re-enabling re-applies setup without a command.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../domain/json.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { FrontWatch } from "./front.ts";
import { type Ledger, readLedger, removeLedger, writeLedger } from "./ledger.ts";

/** present: installed and enabled in some scope; disabled: installed but turned off everywhere it is installed;
 *  absent: not installed (or its data dir, and with it the marker, is gone); unknown: the files cannot be read. */
export type Presence = "present" | "disabled" | "absent" | "unknown";

/** Reads a file's text, undefined when it cannot be read. */
type ReadText = (path: string) => string | undefined;

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const JsonObject = z.record(z.string(), z.unknown());

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  return text === undefined ? undefined : parseJson(text, JsonObject);
}

/** The settings files that hold a scope's `enabledPlugins`. */
function scopeFiles(configDir: string, install: Record<string, unknown>): readonly string[] {
  const project = typeof install.projectPath === "string" ? install.projectPath : undefined;
  if (install.scope === "project" && project !== undefined)
    return [join(project, ".claude", "settings.json")];
  if (install.scope === "local" && project !== undefined)
    return [join(project, ".claude", "settings.local.json")];
  return [join(configDir, "settings.json")];
}

/** Whether one scope's settings leave the plugin on. A plugin with no `enabledPlugins` entry follows its
 *  `defaultEnabled`, which defaults to true and which these plugins never set (Claude Code docs: settings-reference
 *  "enabledPlugins: A plugin with no entry at any scope falls back to its defaultEnabled value"; manifest-reference
 *  "defaultEnabled … Defaults to true"). An unreadable file says nothing, so it counts as the default too. */
function enabledIn(files: readonly string[], key: string, read: ReadText): boolean {
  for (const file of files) {
    const enabled = parseObject(read(file))?.enabledPlugins;
    if (
      typeof enabled === "object" &&
      enabled !== null &&
      (enabled as Record<string, unknown>)[key] === false
    )
      return false;
  }
  return true;
}

/** Whether `<name>-plugin-cc@<marketplace>` is still installed and enabled, from installed_plugins.json, the scopes'
 *  enabledPlugins and the `installed` marker in the plugin's data dir. */
export function pluginPresence(
  name: string,
  configDir: string,
  marker: string | undefined,
  read: ReadText = readText,
): Presence {
  const installed = parseObject(read(join(configDir, "plugins", "installed_plugins.json")));
  if (installed === undefined) return "unknown";
  const plugins = parseObject(JSON.stringify(installed.plugins ?? installed)) ?? {};
  const keys = Object.keys(plugins).filter((key) => key.startsWith(`${name}-plugin-cc@`));
  if (keys.length === 0) return "absent";
  if (marker !== undefined && read(marker) === undefined) return "absent";
  return keys.some((key) =>
    installsOf(plugins[key]).some((install) => enabledIn(scopeFiles(configDir, install), key, read)),
  )
    ? "present"
    : "disabled";
}

/** One plugin key's installs, each as a record (a malformed one counts as a user-scope install). */
function installsOf(value: unknown): readonly Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : [{}];
  return list.map((install) =>
    typeof install === "object" && install !== null ? (install as Record<string, unknown>) : {},
  );
}

/** What the watch does once the plugin is gone; production wires the settings, registry, keystore and jobs. */
interface UninstallActions {
  /** Step 1: take this plugin's entries out of settings.json and put the base URL back. */
  undo(ledger: Ledger): Promise<void>;
  /** Step 3, when the retired front exits: everything else this plugin left outside its own directory. */
  remove(ledger: Ledger, disabled: boolean): Promise<void>;
  presence(ledger: Ledger): Presence;
}

interface UninstallWatchOptions {
  readonly stateRoot: string;
  readonly actions: UninstallActions;
  readonly everyMs?: number;
}

/** The front's uninstall watch (see the header). Nothing happens without a ledger: a router setup never recorded has
 *  nothing to undo. */
export function createUninstallWatch(options: UninstallWatchOptions): FrontWatch {
  let known: Ledger | undefined;
  let gone = 0;
  let undone: Presence | undefined;
  /** Counts consecutive gone answers; the second one undoes the settings and sets the ledger aside. */
  const watchPresence = async (ledger: Ledger): Promise<void> => {
    const presence = options.actions.presence(ledger);
    gone = presence === "absent" || presence === "disabled" ? gone + 1 : 0;
    if (gone < 2) return;
    await options.actions.undo(ledger);
    undone = presence;
    if (presence === "disabled") writeLedger(stateLayout(options.stateRoot).disabledLedger, ledger);
    removeLedger(stateLayout(options.stateRoot).ledger);
  };
  return {
    everyMs: options.everyMs ?? 10_000,
    async tick() {
      if (undone !== undefined) return "retire";
      // The ledger is kept in memory: Claude Code deletes the plugin's data dir (often the state root) on uninstall.
      known = readLedger(stateLayout(options.stateRoot).ledger) ?? known;
      if (known === undefined) return "stay";
      await watchPresence(known);
      return undone === undefined ? "stay" : "retire";
    },
    async cleanup() {
      // Nothing to remove unless this watch undid the setup, or when setup ran again since (a new ledger on disk).
      if (known === undefined || undone === undefined) return;
      if (readLedger(stateLayout(options.stateRoot).ledger) !== undefined) return;
      await options.actions.remove(known, undone === "disabled");
    },
  };
}

/** A job the cleanup must leave alone, and where its work sits. */
export interface LeftBehind {
  readonly id: string;
  readonly worktree?: string;
}

/** Writes `<state>/LEFT-BEHIND.md` naming the undecided jobs and their worktrees, so nothing of value is lost silently.
 *  Nothing is written when there are none. */
export function writeLeftBehind(stateRoot: string, name: string, jobs: readonly LeftBehind[]): void {
  if (jobs.length === 0) return;
  const lines = [
    `# Left behind by the ${name} plugin`,
    "",
    "The plugin was removed while these jobs were still waiting for a decision. Their work is still on disk:",
    "",
    ...jobs.map((job) => `- ${job.id}${job.worktree === undefined ? "" : `: ${job.worktree}`}`),
    "",
  ];
  writeFileSync(stateLayout(stateRoot).leftBehind, lines.join("\n"), { mode: 0o600 });
}

/** The router files under the state root: the copies, the pid files, the lock. */
export function removeRouterFiles(stateRoot: string): void {
  for (const path of [
    stateLayout(stateRoot).routerDir,
    stateLayout(stateRoot).routerPid,
    stateLayout(stateRoot).routerRetired,
    stateLayout(stateRoot).routerLock,
  ])
    rmSync(path, { recursive: true, force: true });
}
