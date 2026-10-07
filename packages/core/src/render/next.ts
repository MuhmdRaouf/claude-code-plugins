import type { Job } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import { lastAttempt, outcomeText } from "./format.ts";

/**
 * The reviewer's next step for one job, chosen from its verdict and mode. It names the `/<p>:review` slash command
 * (there is no CLI on PATH), never `accept --force` first, never accept for a job that crashed or has nothing to merge,
 * and never "ask the worker to rebase": the worker may not commit or switch branches, so a conflict means discard and
 * run the brief again.
 */
export function nextStep(provider: Provider, job: Job): string {
  const review = `${provider.slash}review ${job.id}`;
  if (job.state === "accepted" || job.state === "discarded")
    return `nothing left to do: the job was ${job.state}.`;
  if (job.state !== "awaiting_review")
    return `it is ${job.state.replace("_", " ")}; ${provider.slash}board shows it until it awaits review.`;
  const last = lastAttempt(job);
  const changes = job.brief.mode === "edit";
  switch (last?.verdict) {
    case "pass":
      return changes
        ? `${review} to read the diff and accept it, or return it with feedback.`
        : `the answer is in the report (a ${job.brief.mode} job: nothing to merge); ${review} closes it or returns it with a follow-up.`;
    case "worker_error":
    case "timeout": {
      const why = last.outcome === undefined ? last.verdict.replace("_", " ") : outcomeText(last.outcome);
      return `the worker never finished (${why}): nothing to accept. Fix the cause, then ${review} to return it to try again, or discard it.`;
    }
    case "quota":
      return `${provider.display} says the account has no balance or quota left, so it was not retried: top up at ${provider.billingUrl}, then ${review} to return it to try again, or discard it.`;
    case "stopped":
      return `it was stopped before it finished: ${review} to return it with feedback, or discard it.`;
    case "gate_fail":
    case "scope_violation":
    case "report_invalid":
      return `${review} to return it with the failing output as feedback, or discard it.`;
    case undefined:
      return `${review} to return it to try again, or discard it.`;
  }
}

/** What to do after an accept hit a merge conflict: the worker cannot rebase, so the brief runs again. */
export function conflictStep(provider: Provider): string {
  return `nothing was applied. The worker cannot rebase (it never commits or switches branches): discard the job with ${provider.slash}review and run the brief again on the current branch, or merge the job's branch by hand.`;
}
