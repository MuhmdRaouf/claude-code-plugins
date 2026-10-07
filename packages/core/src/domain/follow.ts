import type { JobState } from "./job.ts";

/** How a follower (`run --wait`, `wait`) polls a job that a detached driver works. */
export const FOLLOW = {
  firstPollMs: 1000,
  maxPollMs: 5000,
  /** A queued job nobody has locked this long has lost its driver (it died before claiming the job). */
  unclaimedGraceMs: 30_000,
} as const;

/** landed: in review or decided, the follower reports it; active: keep polling; stale: no driver will finish it. */
type Watch = "landed" | "active" | "stale";

const LANDED: ReadonlySet<JobState> = new Set<JobState>(["awaiting_review", "accepted", "discarded"]);

/** `unclaimedMs`: how long the follower has seen the job without a live driver (0 when it has one). */
export function watchJob(state: JobState, live: boolean, unclaimedMs: number): Watch {
  if (LANDED.has(state)) return "landed";
  if (live) return "active";
  if (state !== "queued") return "stale";
  return unclaimedMs < FOLLOW.unclaimedGraceMs ? "active" : "stale";
}

/** Doubling backoff, capped. */
export function nextPollMs(current: number): number {
  return Math.min(current * 2, FOLLOW.maxPollMs);
}
