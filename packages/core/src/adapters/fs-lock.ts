import { randomUUID } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parsePid } from "../domain/pid.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { errnoCode } from "./fs-errors.ts";

export type Release = () => Promise<void>;
export type IsAlive = (pid: number) => boolean;
interface Held {
  readonly holderPid: number;
}

/** How often tryLock re-reads a lock it found stale before reporting it held. */
const RECLAIM_ATTEMPTS = 5;

/** Creates path containing text, atomically: the file appears complete or not at all, and only if it did not exist
 *  (link(2) fails with EEXIST), so a reader never sees it half-written. */
export async function createExclusive(path: string, text: string): Promise<boolean> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { flag: "wx" });
  try {
    await link(tmp, path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** createExclusive holding `pid`: a lock file a reader never sees without its holder. */
export function createHolding(path: string, pid: number): Promise<boolean> {
  return createExclusive(path, `${pid}\n`);
}

/** undefined: no lock file. null: unreadable content (never written by us, so nobody holds it). */
export async function readHolder(path: string): Promise<number | null | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return parsePid(text) ?? null;
}

function isStale(holder: number | null, isAlive: IsAlive): boolean {
  return holder === null || !isAlive(holder);
}

/**
 * Deletes path if it is still held by `stale`. Deleting is a check-then-act, so reclaimers serialise on a guard file:
 * without it, a reclaimer that read the stale pid could delete the fresh lock another reclaimer created meanwhile.
 * A guard left by a reclaimer that died is cleared for the next round.
 */
async function reclaim(path: string, stale: number | null, pid: number, isAlive: IsAlive): Promise<void> {
  const guard = `${path}.reclaim`;
  if (!(await createHolding(guard, pid))) {
    const guardHolder = await readHolder(guard);
    if (guardHolder !== undefined && isStale(guardHolder, isAlive)) await rm(guard, { force: true });
    return;
  }
  try {
    if ((await readHolder(path)) === stale) await rm(path, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
}

/** Releases only our own lock, so a late or repeated release never frees someone else's. */
export async function release(path: string, pid: number): Promise<void> {
  if ((await readHolder(path)) === pid) await rm(path, { force: true });
}

/** One attempt at an exclusive lock file holding `pid`; a lock whose holder is dead is reclaimed. */
export async function tryLock(path: string, pid: number, isAlive: IsAlive): Promise<Result<Release, Held>> {
  for (let attempt = 1; attempt <= RECLAIM_ATTEMPTS; attempt++) {
    if (await createHolding(path, pid)) return ok(() => release(path, pid));
    const holder = await readHolder(path);
    if (holder === undefined) continue;
    if (holder !== null && isAlive(holder)) return err({ holderPid: holder });
    await reclaim(path, holder, pid, isAlive);
    await delay(attempt);
  }
  return err({ holderPid: (await readHolder(path)) ?? 0 });
}

/** tryLock, retried with a short jittered pause until timeoutMs: for locks that are only ever held briefly. */
export async function waitLock(
  path: string,
  pid: number,
  isAlive: IsAlive,
  timeoutMs: number,
): Promise<Result<Release, Held>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await tryLock(path, pid, isAlive);
    if (lock.ok || Date.now() >= deadline) return lock;
    await delay(2 + Math.random() * 8);
  }
}
