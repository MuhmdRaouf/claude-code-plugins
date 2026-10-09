// The one-time move of a machine-wide state dir from the XDG state home (~/.local/state) into ~/.agents, run whenever
// a default root is resolved for use: it costs one existsSync when there is nothing to move, and several processes
// running it at once stay safe because every entry moves by one atomic rename and an entry the new dir already has
// is never overwritten — it stays behind in the old dir.

import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where state lived before ~/.agents: $XDG_STATE_HOME/<name>, else ~/.local/state/<name>. */
export function legacyStateDir(env: Readonly<Record<string, string | undefined>>, name: string): string {
  return join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), name);
}

/** Where it lives now: ~/.agents/<name>. */
export function agentsStateDir(env: Readonly<Record<string, string | undefined>>, name: string): string {
  return join(env.HOME ?? homedir(), ".agents", name);
}

/** An error another migrator caused: its own rename won that entry, so ours losing it is not a failure. */
function lostRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY";
}

/** The error's own words, for the one log line a failed move costs. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether anything at all sits at `path` — a broken symlink counts, lstat never follows one. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The dir's top-level entries, or undefined when it cannot be read (another migrator removed it already). */
function entriesOf(dir: string): readonly string[] | undefined {
  try {
    return readdirSync(dir);
  } catch {
    return undefined;
  }
}

/**
 * Moves `name`'s state from legacyStateDir to agentsStateDir when the old dir exists: the new dir is created mode
 * 0700 and every top-level entry it lacks is renamed into it — never merged, never overwritten, symlinks moved as
 * the links they are. A concurrent migrator's ENOENT/EEXIST is ignored; any other failure leaves everything in
 * place for the next start to retry, at the cost of one line on the log. The old dir is removed only once nothing
 * is left in it; otherwise the log names what stayed behind. Never throws.
 */
export function migrateStateDir(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = console.error,
): void {
  const from = legacyStateDir(env, name);
  const to = agentsStateDir(env, name);
  if (from === to || !existsSync(from)) return;
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 });
  } catch (error) {
    log(`state migrate: cannot create ${to} (${messageOf(error)}); ${name}'s state stays in ${from}`);
    return;
  }
  if (moveEntries(name, from, to, log)) return; // the move failed: everything stays for the next start
  settleOldDir(from, to, log);
}

/** Renames every entry the new dir lacks; returns whether a failure that is not a lost race stopped the move. */
function moveEntries(name: string, from: string, to: string, log: (line: string) => void): boolean {
  for (const entry of entriesOf(from) ?? []) {
    if (occupied(join(to, entry))) continue; // the new dir's entry wins; this one stays in the old dir
    try {
      renameSync(join(from, entry), join(to, entry));
    } catch (error) {
      if (lostRace(error)) continue;
      log(
        `state migrate: cannot move ${join(from, entry)} (${messageOf(error)}); ${name}'s state stays in ${from}`,
      );
      return true;
    }
  }
  return false;
}

/** Removes the old dir once it is empty; otherwise one line names what stayed behind and why. */
function settleOldDir(from: string, to: string, log: (line: string) => void): void {
  const left = entriesOf(from);
  if (left === undefined) return; // another migrator removed the old dir as we finished
  if (left.length === 0) {
    try {
      rmdirSync(from);
    } catch {
      // another process removed or refilled it under us; the next start retries
    }
    return;
  }
  log(`state migrate: ${left.join(", ")} left in ${from} because ${to} already had entries of those names`);
}
