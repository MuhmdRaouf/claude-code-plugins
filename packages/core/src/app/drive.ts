import type { Job } from "../domain/job.ts";
import { type AfterVerification, afterVerification } from "../domain/lifecycle.ts";
import { err, type Result } from "../domain/result.ts";
import { deriveVerdict } from "../domain/verify.ts";
import { pendingAttempt, retryJob, startJob, stopJob, withLastAttempt } from "./attempts.ts";
import type { Deps } from "./deps.ts";
import { runAttempt } from "./drive-run.ts";
import { repositoryFingerprint, verifyAttempt } from "./drive-verify.ts";
import { depsForJob } from "./engine-select.ts";
import type { AppError } from "./errors.ts";
import { move, persist } from "./persist.ts";
import { type StopWatch, watchStop } from "./stop-watch.ts";

/**
 * Drive one job from `queued` (or a review-returned job) to `awaiting_review`:
 * lock the job → acquire a slot (semaphore capacity from the limiter) → run an attempt → verify → decide via
 * afterVerification (auto_fix / infra_retry loop back without releasing the lock; await_review ends) → release.
 * Per attempt: build the prompt (initial | autoFix | reviewFix | selfContained when resume fails), start the worker with
 * a new or resumed session, fold the stream (progress persisted at most every 2 s, every 429 api_retry reported to the
 * limiter), finalize, then verification: gates (only when the worker completed), change set + scope check, report check,
 * verdict. Every step persists the job (optimistic version) so `board`/`show` see live state. A stop request (job's
 * stop flag file or AbortSignal) terminates the worker and records verdict `stopped`.
 */
export async function drive(base: Deps, jobId: string, signal?: AbortSignal): Promise<Result<Job, AppError>> {
  const found = await base.store.find(jobId);
  if (!found.ok) return err({ kind: "store", error: found.error });
  // From here on the worker is the job's engine; nothing below knows which one it is.
  const deps = depsForJob(base, found.value);
  const id = found.value.id;
  if (found.value.state !== "queued") return notQueued(found.value);
  const lock = await deps.store.lock(id, process.pid);
  if (!lock.ok) return err({ kind: "store", error: lock.error });
  const paths = deps.store.paths(id);
  const stop = watchStop(deps, paths, signal);
  try {
    const driven = await driveLocked(deps, id, stop);
    // A stop request is consumed by the run that honoured it, whether the watcher or the decision point saw it.
    if (stop.signal.aborted || (await deps.files.stopRequested(paths))) await deps.files.clearStop(paths);
    return driven;
  } finally {
    stop.close();
    // A dispose failure is reported but never replaces the run's result, and the lock is released either way.
    try {
      await deps.worker.dispose();
    } catch (error) {
      deps.out.error(
        `${deps.provider.name}: job ${id} finished, but its worker could not be disposed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await lock.value();
  }
}

function notQueued(job: Job): Result<never, AppError> {
  return err({ kind: "wrong_state", id: job.id, state: job.state, allowed: ["queued"] });
}

async function driveLocked(deps: Deps, id: string, stop: StopWatch): Promise<Result<Job, AppError>> {
  // Re-read under the lock: the job may have moved since it was found.
  const current = await deps.store.get(id);
  if (!current.ok) return err({ kind: "store", error: current.error });
  if (current.value.state !== "queued") return notQueued(current.value);
  let release: () => Promise<void>;
  try {
    release = await deps.semaphore.acquire(
      { jobId: id, pid: process.pid, priority: current.value.brief.priority ?? "normal" },
      stop.signal,
    );
  } catch (error) {
    if (!stop.signal.aborted) throw error;
    return persist(deps, current.value, (job) => stopJob(deps, job));
  }
  try {
    return await runToReview(deps, current.value, stop);
  } finally {
    await release();
  }
}

async function runToReview(deps: Deps, queued: Job, stop: StopWatch): Promise<Result<Job, AppError>> {
  let running = await persist(deps, queued, (job) => startJob(deps, job));
  for (;;) {
    if (!running.ok) return running;
    const step = await runOnce(deps, running.value, stop);
    if (step.done) return step.result;
    running = step.result;
  }
}

type Step = { readonly done: boolean; readonly result: Result<Job, AppError> };

/** One attempt: run, verify, then either land the job in awaiting_review (done) or queue the next attempt. */
async function runOnce(deps: Deps, job: Job, stop: StopWatch): Promise<Step> {
  const pending = pendingAttempt(job);
  if (pending === undefined) return { done: true, result: notQueued(job) };
  const before = await repositoryFingerprint(deps, job);
  if (!before.ok) return { done: true, result: before };
  const ran = await runAttempt(deps, job, pending, stop);
  // A rate limit that killed the attempt lowers the cap on its own; the folded retries only add to the quorum.
  // An empty balance answered with a 429 (Z.ai's 1113) is no sign of load: the cap stays.
  if (ran.outcome?.kind === "api_error" && ran.outcome.status === 429 && ran.outcome.quota !== true) {
    await deps.limiter.rateLimited(deps.clock.now(), { endedAttempt: true });
  }
  const exited = await persist(deps, job, (stored) =>
    move(withLastAttempt(stored, ran.attempt), { type: "worker_exited" }),
  );
  if (!exited.ok) return { done: true, result: exited };
  const verification = await verifyAttempt(deps, exited.value, ran.attempt, before.value);
  if (!verification.ok) return { done: true, result: verification };
  const verdict = deriveVerdict({ outcome: ran.outcome, ...verification.value });
  const verified = { ...ran.attempt, verification: verification.value, verdict };
  // The watcher polls the stop file once a second; ask the file too, so a stop requested any time before this decision
  // lands the verdict instead of starting a retry.
  const stopped = stop.signal.aborted || (await deps.files.stopRequested(deps.store.paths(job.id)));
  const next: AfterVerification =
    ran.failure !== undefined || stopped
      ? { kind: "await_review" }
      : afterVerification(withLastAttempt(exited.value, verified), verdict);
  if (next.kind !== "await_review") {
    const retried = await persist(deps, exited.value, (stored) =>
      retryJob(deps, withLastAttempt(stored, verified), next.kind),
    );
    return { done: !retried.ok, result: retried };
  }
  const landed = await persist(deps, exited.value, (stored) =>
    move(withLastAttempt(stored, verified), { type: "verified" }),
  );
  return { done: true, result: landed.ok && ran.failure !== undefined ? err(ran.failure) : landed };
}
