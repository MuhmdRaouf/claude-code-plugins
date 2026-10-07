import { FOLLOW, nextPollMs, watchJob } from "../domain/follow.ts";
import type { Job } from "../domain/job.ts";
import { ok, type Result } from "../domain/result.ts";
import type { Deps } from "./deps.ts";
import type { AppError } from "./errors.ts";
import { jobRow } from "./queries.ts";

/** landed: in review or decided; stale: no live driver will finish it; detached: the follower was asked to let go. */
type Followed =
  | { readonly kind: "landed"; readonly job: Job }
  | { readonly kind: "stale"; readonly job: Job }
  | { readonly kind: "detached"; readonly job: Job };

/**
 * Follow a job that a detached driver works, by polling the store (1 s doubling to 5 s), until it lands or goes stale.
 * Read-only: aborting `signal` only ends the follow; the job and its driver are never touched.
 */
export async function followJob(
  deps: Deps,
  id: string,
  signal: AbortSignal,
): Promise<Result<Followed, AppError>> {
  let pollMs: number = FOLLOW.firstPollMs;
  let unclaimedSince: number | undefined;
  for (;;) {
    const row = await jobRow(deps, id);
    if (!row.ok) return row;
    const { job, live } = row.value;
    unclaimedSince = live ? undefined : (unclaimedSince ?? deps.clock.now());
    const watch = watchJob(job.state, live, sinceMs(deps, unclaimedSince));
    if (watch !== "active") return ok({ kind: watch, job });
    if (signal.aborted || !(await slept(deps, pollMs, signal))) return ok({ kind: "detached", job });
    pollMs = nextPollMs(pollMs);
  }
}

function sinceMs(deps: Deps, since: number | undefined): number {
  return since === undefined ? 0 : deps.clock.now() - since;
}

/** False when the sleep ended because the follow was aborted. */
async function slept(deps: Deps, ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await deps.clock.sleep(ms, signal);
    return true;
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  }
}
