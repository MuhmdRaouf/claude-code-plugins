import { err, type Result } from "../domain/result.ts";
import type { StoreError } from "../ports/index.ts";
import type { Deps } from "./deps.ts";
import { reapEngine } from "./engine-reap.ts";
import type { AppError } from "./errors.ts";

/** How long a driver gets to honour a stop request, on top of the worker's stop grace, before it is terminated. */
const DRIVER_STOP_MS = 15_000;
const LOCK_POLL_MS = 250;

type Lock = Result<() => Promise<void>, StoreError>;

/** Runs fn holding the job's driver lock, so no driver runs the job meanwhile. */
export async function withJobLock<T>(
  deps: Deps,
  id: string,
  fn: () => Promise<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  return holding(await deps.store.lock(id, process.pid), fn);
}

/** Like withJobLock, but a live driver is first asked to stop and given time to land the job; one that does not let go
 *  in time is terminated. */
export async function withDriverStopped<T>(
  deps: Deps,
  id: string,
  fn: () => Promise<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  let lock = await deps.store.lock(id, process.pid);
  if (!lock.ok && lock.error.kind === "locked") {
    await deps.files.requestStop(deps.store.paths(id));
    lock = await lockWithin(deps, id, deps.config.stopGraceMs + DRIVER_STOP_MS);
  }
  if (!lock.ok && lock.error.kind === "locked") {
    await deps.process.terminateGroup(lock.error.holderPid, deps.config.stopGraceMs);
    lock = await deps.store.lock(id, process.pid);
  }
  // The engine runs in its own process group: a driver that was killed (or had died) could not stop it.
  if (lock.ok) await reapEngine(deps, id);
  return holding(lock, fn);
}

async function lockWithin(deps: Deps, id: string, ms: number): Promise<Lock> {
  const deadline = deps.clock.now() + ms;
  for (;;) {
    await deps.clock.sleep(LOCK_POLL_MS);
    const lock = await deps.store.lock(id, process.pid);
    if (lock.ok || lock.error.kind !== "locked" || deps.clock.now() >= deadline) return lock;
  }
}

async function holding<T>(lock: Lock, fn: () => Promise<Result<T, AppError>>): Promise<Result<T, AppError>> {
  if (!lock.ok) return err({ kind: "store", error: lock.error });
  try {
    return await fn();
  } finally {
    await lock.value();
  }
}
