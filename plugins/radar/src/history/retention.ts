/**
 * History retention: the dashboard's `historyRetentionDays` setting turned into a cutoff, and a prune on
 * an hour beat (plus once at startup) so a long-running server keeps the file inside the window the user
 * chose. 0 means keep everything. A failed prune is logged nowhere and retried on the next beat: serving
 * never depends on it.
 */
import { readSettings } from "../server/settings.ts";
import type { History } from "./history.ts";

export const DAY_MS = 86_400_000;
export const PRUNE_INTERVAL_MS = 60 * 60_000;

/** The oldest last_at a tree may carry and survive, or null when retention is off (0 = forever). */
export function retentionCutoff(retentionDays: number, now: number): number | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return now - retentionDays * DAY_MS;
}

/** Delete every tree whose newest activity is older than the current setting allows; returns the count. */
export function pruneOnce(history: History, env: NodeJS.ProcessEnv, now: number = Date.now()): number {
  const cutoff = retentionCutoff(readSettings(env).historyRetentionDays, now);
  return cutoff === null ? 0 : history.prune(cutoff);
}

export type PruneSchedule = { stop(): void };

export type PruneOptions = { intervalMs?: number; now?: () => number };

/** Prune once now, then every interval; the timer never keeps the process alive. */
export function schedulePrunes(
  history: History,
  env: NodeJS.ProcessEnv,
  options: PruneOptions = {},
): PruneSchedule {
  const now = options.now ?? Date.now;
  const run = (): void => {
    try {
      pruneOnce(history, env, now());
    } catch {
      // the next beat tries again; the dashboard keeps serving either way
    }
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? PRUNE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
