import type { Attempt, AttemptKind, Job } from "../domain/job.ts";
import { autoFixPrompt, initialPrompt, selfContainedPrompt } from "../domain/prompt.ts";
import { ok, type Result } from "../domain/result.ts";
import type { Deps } from "./deps.ts";
import type { AppError } from "./errors.ts";
import { move } from "./persist.ts";

/** Fix attempts continue the worker's own session; the others start a fresh one. */
export function resumesSession(attempt: Attempt): boolean {
  return attempt.kind === "auto_fix" || attempt.kind === "review_fix";
}

/** The attempt that has not run yet (or is running): the last one, while it has no outcome. */
export function pendingAttempt(job: Job): Attempt | undefined {
  const last = job.attempts.at(-1);
  return last?.outcome === undefined ? last : undefined;
}

export function withLastAttempt(job: Job, attempt: Attempt): Job {
  return { ...job, attempts: [...job.attempts.slice(0, -1), attempt] };
}

function append(job: Job, attempt: Attempt): Job {
  return { ...job, attempts: [...job.attempts, attempt] };
}

/** queued → running with the attempt to run: the pending one (a review_fix the reviewer queued) or the first. */
export function startJob(deps: Deps, job: Job): Result<Job, AppError> {
  const moved = move(job, { type: "slot_acquired" });
  if (!moved.ok) return moved;
  const pending = pendingAttempt(moved.value);
  return ok(
    pending === undefined
      ? append(
          moved.value,
          newAttempt(
            deps,
            moved.value,
            "initial",
            initialPrompt(job.brief, job.workspace.artifactsDir, deps.provider),
          ),
        )
      : withLastAttempt(moved.value, { ...pending, startedAt: deps.clock.iso() }),
  );
}

/** verifying → running with the next attempt of `kind` appended. */
export function retryJob(deps: Deps, job: Job, kind: "auto_fix" | "infra_retry"): Result<Job, AppError> {
  const moved = move(job, { type: "retry", kind });
  if (!moved.ok) return moved;
  return ok(append(moved.value, retryAttempt(deps, moved.value, kind)));
}

function retryAttempt(deps: Deps, job: Job, kind: "auto_fix" | "infra_retry"): Attempt {
  const last = job.attempts.at(-1);
  if (kind === "auto_fix" && last !== undefined) {
    return {
      ...newAttempt(deps, job, kind, autoFixPrompt(job.brief, last, deps.config.prompt)),
      sessionId: last.sessionId,
    };
  }
  return newAttempt(deps, job, kind, freshSessionPrompt(deps, job, job.attempts));
}

/**
 * The prompt for a new session after `history`: the initial prompt while nothing but initial runs happened, else the
 * brief made self-contained, asked to carry out the last real instruction (a fix or the reviewer's feedback) again.
 */
function freshSessionPrompt(deps: Deps, job: Job, history: readonly Attempt[]): string {
  const instruction = history.findLast((attempt) => resumesSession(attempt))?.prompt;
  return instruction === undefined
    ? initialPrompt(job.brief, job.workspace.artifactsDir, deps.provider)
    : selfContainedPrompt(job.brief, history, instruction, job.workspace.artifactsDir, deps.provider);
}

function newAttempt(deps: Deps, job: Job, kind: AttemptKind, prompt: string): Attempt {
  return {
    n: job.attempts.length + 1,
    kind,
    prompt,
    sessionId: deps.ids.sessionId(),
    startedAt: deps.clock.iso(),
  };
}

/**
 * queued/running/verifying → awaiting_review with verdict stopped. The attempt in flight (or the one that never got to
 * start) keeps what it has and is closed as stopped; a job that never had an attempt gets its first, closed at once.
 */
export function stopJob(deps: Deps, job: Job): Result<Job, AppError> {
  const moved = move(job, { type: "stopped" });
  if (!moved.ok) return moved;
  const last = moved.value.attempts.at(-1);
  const open = last?.verdict === undefined ? last : undefined;
  const closing =
    open ??
    newAttempt(
      deps,
      moved.value,
      "initial",
      initialPrompt(job.brief, job.workspace.artifactsDir, deps.provider),
    );
  const closed: Attempt = {
    ...closing,
    endedAt: closing.endedAt ?? deps.clock.iso(),
    outcome: closing.outcome ?? { kind: "stopped" },
    verdict: "stopped",
  };
  return ok(open === undefined ? append(moved.value, closed) : withLastAttempt(moved.value, closed));
}
