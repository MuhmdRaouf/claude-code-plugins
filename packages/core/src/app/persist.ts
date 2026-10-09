import type { Job } from "../domain/job.ts";
import { type JobEvent, nextState } from "../domain/lifecycle.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Deps } from "./deps.ts";
import type { AppError } from "./errors.ts";

/** One state change of a job, computed from the job as stored. */
type Step = (job: Job) => Result<Job, AppError>;

/** The job moved through the lifecycle by `event`; everything else unchanged. */
export function move(job: Job, event: JobEvent): Result<Job, AppError> {
  const to = nextState(job.state, event);
  return to.ok ? ok({ ...job, state: to.value }) : err({ kind: "lifecycle", error: to.error });
}

/**
 * Applies `step` to `job` and writes the result (optimistic version). On a version conflict the stored job is re-read
 * and the step re-applied once, but only while it is still in the state `job` was in: someone else moved it on.
 */
export async function persist(deps: Deps, job: Job, step: Step): Promise<Result<Job, AppError>> {
  const first = await write(deps, job, step);
  if (first.ok || first.error.kind !== "store" || first.error.error.kind !== "version_conflict") return first;
  const current = await deps.store.get(job.id);
  if (!current.ok) return err({ kind: "store", error: current.error });
  if (current.value.state !== job.state) {
    return err({ kind: "wrong_state", id: job.id, state: current.value.state, allowed: [job.state] });
  }
  return write(deps, current.value, step);
}

async function write(deps: Deps, job: Job, step: Step): Promise<Result<Job, AppError>> {
  const next = step(job);
  if (!next.ok) return next;
  const stored = await deps.store.update({ ...next.value, updatedAt: deps.clock.iso() });
  return stored.ok ? stored : err({ kind: "store", error: stored.error });
}
