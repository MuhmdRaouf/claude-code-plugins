/**
 * Claude Code's own session registry: while an interactive session runs, Claude Code keeps one
 * `<config dir>/sessions/<pid>.json` describing it (session id, name, busy/idle status). That registry —
 * not a SessionEnd hook — is what decides which sessions are live: a session radar never saw end can
 * still be dead, and only a live pid proves an open terminal. The `*.key` files beside the session
 * files hold secrets and are never read. The pid liveness check is injected so tests can fake it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistrySession } from "../shared/model.ts";
import { claudeConfigDir } from "../shared/paths.ts";

/** How often the registry is rescanned: a session's live state never lags more than this. */
export const REGISTRY_RESCAN_MS = 5_000;

/** Does this pid belong to a living process? Injected so tests decide who is alive. */
export type PidAlive = (pid: number) => boolean;

/** process.kill(pid, 0): arriving means alive, EPERM means alive but owned by another user, rest is gone. */
export const pidAlive: PidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Where Claude Code keeps the per-session registry files (the same config dir as projects/). */
export function registryDir(env: NodeJS.ProcessEnv): string {
  return join(claudeConfigDir(env), "sessions");
}

/** The string a registry file carries under `key`, or null. */
function stringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** One registry file's text as a session entry, or null when it is not one (malformed, missing ids). */
export function registrySessionOf(text: string): RegistrySession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const sessionId = stringOf(record, "sessionId");
  const pid = record.pid;
  if (sessionId === null || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = record.startedAt;
  return {
    pid,
    sessionId,
    name: stringOf(record, "name"),
    nameSource: stringOf(record, "nameSource"),
    status: stringOf(record, "status"),
    cwd: stringOf(record, "cwd"),
    startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null,
  };
}

/**
 * Every live session in the registry: each `*.json` parsed, malformed files skipped, and only entries
 * whose pid is still alive kept. Never reads the `*.key` files beside them.
 */
export function readRegistry(env: NodeJS.ProcessEnv, alive: PidAlive = pidAlive): RegistrySession[] {
  const dir = registryDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no registry (or an unreadable one): nothing is live, and no session file is invented
  }
  const entries: RegistrySession[] = [];
  for (const name of names) {
    if (name.endsWith(".key") || !name.endsWith(".json")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // one unreadable file never stops the rest
    }
    const entry = registrySessionOf(text);
    if (entry !== null && alive(entry.pid)) entries.push(entry);
  }
  return entries;
}
