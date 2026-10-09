/**
 * An engine process never outlives its job: the plugin bridges a job to the engine, so it also reaps what the engine leaves. The engine runs in its own process
 * group, apart from the driver's, so killing a driver does not reach it. While it runs, its group leader's pid sits in
 * the job directory (`engine.pid`); whoever ends a job without its driver's help — stop and discard of a job whose
 * driver is gone or was killed, and the cleanup every command runs for drivers that died — terminates that group.
 */
import type { Job } from "../domain/job.ts";
import type { Deps } from "./deps.ts";

/** Terminates the job's engine process group, if one is recorded, and forgets it. */
export async function reapEngine(deps: Deps, jobId: string): Promise<void> {
  const paths = deps.store.paths(jobId);
  const pid = deps.files.enginePid(paths);
  if (pid === undefined) return;
  if (deps.process.isAlive(pid)) await deps.process.terminateGroup(pid, deps.config.stopGraceMs);
  deps.files.clearEnginePid(paths);
}

/** The cleanup pass: an engine whose driver is gone has nobody left to stop it, so it is reaped here. */
export async function reapOrphanEngines(deps: Deps, jobs: readonly Job[]): Promise<void> {
  for (const job of jobs) {
    const paths = deps.store.paths(job.id);
    if (deps.files.enginePid(paths) === undefined) continue;
    const driver = await deps.files.driverPid(paths);
    if (driver !== undefined && deps.process.isAlive(driver)) continue;
    await reapEngine(deps, job.id);
  }
}
