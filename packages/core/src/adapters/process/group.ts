import { setTimeout as delay } from "node:timers/promises";
import { errnoCode } from "../fs-errors.ts";

/** Process and process-group signalling shared by the worker and ProcessControl. */

const POLL_MS = 25;
/** After SIGKILL only the kernel is left to act; this bounds the wait for a process stuck in an uninterruptible call. */
const KILL_SETTLE_MS = 2_000;

/** Signal 0 probes existence; EPERM means it exists but belongs to someone else. */
export function isAlive(pid: number): boolean {
  if (!namesOneProcess(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/** SIGTERM the group led by `pid` (spawned with `detached: true`), resolving once no member is left. */
export async function terminateGroup(pid: number, graceMs: number): Promise<void> {
  if (!isForeignGroupLeader(pid)) return;
  signalGroup(pid, "SIGTERM");
  if (await groupGoneWithin(pid, graceMs)) return;
  signalGroup(pid, "SIGKILL");
  await groupGoneWithin(pid, KILL_SETTLE_MS);
}

async function groupGoneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (signalGroup(pid, 0)) {
    if (performance.now() >= deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}

/** Signals the group `pid` leads (a no-op for 0, 1, negatives and our own pid); true when the group still had a
 *  member to signal. */
export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  if (!isForeignGroupLeader(pid)) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/** -1 would signal every process we own, and our own group would take this process down with it. */
function isForeignGroupLeader(pid: number): boolean {
  return namesOneProcess(pid) && pid !== 1 && pid !== process.pid;
}

/** kill() treats 0 and negatives as process groups (-1: every process we may signal), so only positive integers are
 *  safe to pass on. */
function namesOneProcess(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}
