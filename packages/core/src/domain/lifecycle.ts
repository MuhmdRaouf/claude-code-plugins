import type { Brief } from "./brief.ts";
import type { AttemptKind, Job, JobState, Verdict } from "./job.ts";
import { err, ok, type Result } from "./result.ts";

export type JobEvent =
  | { readonly type: "slot_acquired" }
  | { readonly type: "worker_exited" }
  | { readonly type: "verified" }
  | { readonly type: "retry"; readonly kind: Extract<AttemptKind, "auto_fix" | "infra_retry"> }
  | { readonly type: "returned"; readonly feedback: string }
  | { readonly type: "accepted" }
  | { readonly type: "discarded" }
  | { readonly type: "stopped" };

export interface LifecycleError {
  readonly kind: "illegal_transition";
  readonly from: JobState;
  readonly event: JobEvent["type"];
}

/** The state machine. Total over (state × event): every pair either moves or is an explicit illegal_transition. */
export function nextState(from: JobState, event: JobEvent): Result<JobState, LifecycleError> {
  const to = TRANSITIONS[from][event.type];
  return to === undefined ? err({ kind: "illegal_transition", from, event: event.type }) : ok(to);
}

type TransitionTable = Readonly<Record<JobState, Partial<Readonly<Record<JobEvent["type"], JobState>>>>>;

const TRANSITIONS: TransitionTable = {
  queued: { slot_acquired: "running", discarded: "discarded", stopped: "awaiting_review" },
  running: { worker_exited: "verifying", discarded: "discarded", stopped: "awaiting_review" },
  verifying: {
    verified: "awaiting_review",
    retry: "running",
    discarded: "discarded",
    stopped: "awaiting_review",
  },
  awaiting_review: { returned: "queued", accepted: "accepted", discarded: "discarded" },
  accepted: {},
  discarded: {},
};

export type AfterVerification =
  | { readonly kind: "auto_fix" }
  | { readonly kind: "infra_retry" }
  | { readonly kind: "await_review" };

/**
 * What the driver does once an attempt is verified. pass → await_review. gate_fail/scope_violation/report_invalid →
 * auto_fix while fix attempts used < brief.retries.fix. worker_error/timeout → infra_retry while infra attempts used <
 * brief.retries.infra. quota and stopped → await_review. Budget counts only attempts of the matching kind since the last
 * review_fix (a reviewer's return grants a fresh budget).
 */
export function afterVerification(job: Job, verdict: Verdict): AfterVerification {
  const retry = RETRY_FOR[verdict];
  if (retry === null) return { kind: "await_review" };
  const budget = job.brief.retries[retry.budget];
  return attemptsUsed(job, retry.kind) < budget ? { kind: retry.kind } : { kind: "await_review" };
}

type RetryKind = Extract<AttemptKind, "auto_fix" | "infra_retry">;
type RetryPolicy = { readonly kind: RetryKind; readonly budget: keyof Brief["retries"] } | null;

const AUTO_FIX: RetryPolicy = { kind: "auto_fix", budget: "fix" };
const INFRA_RETRY: RetryPolicy = { kind: "infra_retry", budget: "infra" };

const RETRY_FOR: Readonly<Record<Verdict, RetryPolicy>> = {
  pass: null,
  gate_fail: AUTO_FIX,
  scope_violation: AUTO_FIX,
  report_invalid: AUTO_FIX,
  worker_error: INFRA_RETRY,
  // Out of balance or quota: every retry would fail the same way until the user tops up.
  quota: null,
  timeout: INFRA_RETRY,
  stopped: null,
};

/** A reviewer's return grants a fresh budget, so only attempts after the last review_fix count. */
function attemptsUsed(job: Job, kind: RetryKind): number {
  const lastReturn = job.attempts.findLastIndex((attempt) => attempt.kind === "review_fix");
  return job.attempts.slice(lastReturn + 1).filter((attempt) => attempt.kind === kind).length;
}

export const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(["accepted", "discarded"]);
