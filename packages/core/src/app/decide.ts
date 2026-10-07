import type { Decision, Job, JobState } from "../domain/job.ts";
import type { JobEvent } from "../domain/lifecycle.ts";
import { reviewFixPrompt } from "../domain/prompt.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { stopJob } from "./attempts.ts";
import { type AcceptMode, land, removeWorkspace } from "./decide-land.ts";
import type { Deps } from "./deps.ts";
import { reapEngine } from "./engine-reap.ts";
import type { AppError } from "./errors.ts";
import { withDriverStopped, withJobLock } from "./exclusive.ts";
import { move, persist } from "./persist.ts";

const IN_REVIEW: readonly JobState[] = ["awaiting_review"];
const UNDECIDED: readonly JobState[] = ["queued", "running", "verifying", "awaiting_review"];
const STOPPABLE: readonly JobState[] = ["queued", "running", "verifying"];

/**
 * awaiting_review → accepted. edit: commit the change set on the job branch (message: title, report summary, and the
 * `Worked-by` trailer unless the repository sets `<provider>.trailer: none`), rebase onto the repo's branch tip when it
 * moved, regenerate the brief's generated files, verify the exact commit in a fresh detached checkout, then
 * fast-forward the repo's branch onto it (or apply to the working tree for no_commit); conflict or failed verification
 * → error, nothing applied, job unchanged. exec/readonly: nothing to land. Then remove the worktree. Accepting a
 * non-pass verdict is allowed only with force (the reviewer owns that call). The repository's commit hooks run unless
 * verify is false; a failing hook leaves the job awaiting review.
 */
export async function accept(
  deps: Deps,
  id: string,
  opts: { readonly mode: AcceptMode; readonly force: boolean; readonly verify: boolean },
): Promise<Result<Job, AppError>> {
  return decideOn(deps, id, IN_REVIEW, withJobLock, async (job) => {
    const verdict = job.attempts.at(-1)?.verdict ?? null;
    if (verdict !== "pass" && !opts.force) return err({ kind: "not_pass", id: job.id, verdict });
    const landed = await land(deps, job, opts);
    if (!landed.ok) return landed;
    const commit = landed.value;
    const accepted = await decided(
      deps,
      job,
      { type: "accepted" },
      {
        kind: "accepted",
        at: deps.clock.iso(),
        ...(commit === undefined ? {} : { commit }),
      },
    );
    if (accepted.ok) await removeWorkspace(deps, accepted.value);
    return accepted;
  });
}

/** awaiting_review → queued with a pending review_fix carrying the feedback (non-empty); the caller then drives it. */
export async function returnForFix(deps: Deps, id: string, feedback: string): Promise<Result<Job, AppError>> {
  const text = feedback.trim();
  if (text === "") return err({ kind: "empty_feedback" });
  return decideOn(deps, id, IN_REVIEW, withJobLock, async (job) => {
    const returned = await persist(deps, job, (stored) => {
      const moved = move(stored, { type: "returned", feedback: text });
      if (!moved.ok) return moved;
      const last = stored.attempts.at(-1);
      const prompt =
        last === undefined ? text : reviewFixPrompt(stored.brief, last, text, deps.config.prompt);
      const attempt = {
        n: stored.attempts.length + 1,
        kind: "review_fix" as const,
        feedback: text,
        prompt,
        sessionId: last?.sessionId ?? deps.ids.sessionId(),
        startedAt: deps.clock.iso(),
      };
      return ok({ ...moved.value, attempts: [...moved.value.attempts, attempt] });
    });
    // A stale request must not stop the run the reviewer just asked for.
    if (returned.ok) await deps.files.clearStop(deps.store.paths(job.id));
    return returned;
  });
}

/** Any non-terminal state → discarded: stop a running worker first, remove the worktree, keep logs. */
export async function discard(deps: Deps, id: string, reason?: string): Promise<Result<Job, AppError>> {
  return decideOn(deps, id, UNDECIDED, withDriverStopped, async (job) => {
    const discarded = await decided(
      deps,
      job,
      { type: "discarded" },
      {
        kind: "discarded",
        at: deps.clock.iso(),
        ...(reason === undefined ? {} : { reason }),
      },
    );
    if (discarded.ok) {
      await removeWorkspace(deps, discarded.value);
      await deps.files.clearStop(deps.store.paths(job.id));
    }
    return discarded;
  });
}

/** Request a stop: running/verifying/queued drivers end with verdict `stopped` and the job awaits review. A job with no
 *  live driver is stopped here and now. */
export async function stop(deps: Deps, id: string): Promise<Result<Job, AppError>> {
  const found = await located(deps, id, STOPPABLE);
  if (!found.ok) return found;
  const paths = deps.store.paths(found.value.id);
  await deps.files.requestStop(paths);
  const lock = await deps.store.lock(found.value.id, process.pid);
  if (!lock.ok) return lock.error.kind === "locked" ? found : err({ kind: "store", error: lock.error });
  try {
    // No live driver holds the job, so nobody else will stop its engine.
    await reapEngine(deps, found.value.id);
    const current = await located(deps, found.value.id, STOPPABLE);
    const stopped = current.ok ? await persist(deps, current.value, (job) => stopJob(deps, job)) : current;
    await deps.files.clearStop(paths);
    return stopped;
  } finally {
    await lock.value();
  }
}

type Locking = (
  deps: Deps,
  id: string,
  fn: () => Promise<Result<Job, AppError>>,
) => Promise<Result<Job, AppError>>;

/** Finds the job, takes its lock the given way, re-reads it under the lock and runs fn while it is in an allowed state. */
async function decideOn(
  deps: Deps,
  id: string,
  allowed: readonly JobState[],
  locking: Locking,
  fn: (job: Job) => Promise<Result<Job, AppError>>,
): Promise<Result<Job, AppError>> {
  const found = await located(deps, id, allowed);
  if (!found.ok) return found;
  return locking(deps, found.value.id, async () => {
    const current = await located(deps, found.value.id, allowed);
    return current.ok ? fn(current.value) : current;
  });
}

async function located(deps: Deps, id: string, allowed: readonly JobState[]): Promise<Result<Job, AppError>> {
  const found = await deps.store.find(id);
  if (!found.ok) return err({ kind: "store", error: found.error });
  const job = found.value;
  return allowed.includes(job.state)
    ? ok(job)
    : err({ kind: "wrong_state", id: job.id, state: job.state, allowed });
}

function decided(deps: Deps, job: Job, event: JobEvent, decision: Decision): Promise<Result<Job, AppError>> {
  return persist(deps, job, (stored) => {
    const moved = move(stored, event);
    return moved.ok ? ok({ ...moved.value, decision }) : moved;
  });
}
