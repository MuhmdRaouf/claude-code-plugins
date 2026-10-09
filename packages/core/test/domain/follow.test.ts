import { describe, expect, it } from "vitest";
import { FOLLOW, nextPollMs, watchJob } from "../../src/domain/follow.ts";
import type { JobState } from "../../src/domain/job.ts";

describe("watchJob", () => {
  it("a job in review or decided has landed, whether or not a driver is alive", () => {
    for (const state of ["awaiting_review", "accepted", "discarded"] as const) {
      expect(watchJob(state, false, 0)).toBe("landed");
      expect(watchJob(state, true, FOLLOW.unclaimedGraceMs)).toBe("landed");
    }
  });

  it("an active job with a live driver is still being worked", () => {
    for (const state of ["queued", "running", "verifying"] as const) {
      expect(watchJob(state, true, FOLLOW.unclaimedGraceMs * 10)).toBe("active");
    }
  });

  it("running or verifying without a live driver is stale at once (the board's stale)", () => {
    const states: readonly JobState[] = ["running", "verifying"];
    for (const state of states) expect(watchJob(state, false, 0)).toBe("stale");
  });

  it("queued without a driver waits for one to claim it, then turns stale after the grace period", () => {
    expect(watchJob("queued", false, 0)).toBe("active");
    expect(watchJob("queued", false, FOLLOW.unclaimedGraceMs - 1)).toBe("active");
    expect(watchJob("queued", false, FOLLOW.unclaimedGraceMs)).toBe("stale");
  });
});

describe("nextPollMs", () => {
  it("starts at 1 s and doubles up to 5 s, then stays there", () => {
    expect(FOLLOW.firstPollMs).toBe(1000);
    expect(FOLLOW.unclaimedGraceMs).toBe(30_000);
    const seen: number[] = [FOLLOW.firstPollMs];
    for (let i = 0; i < 5; i += 1) seen.push(nextPollMs(seen.at(-1) ?? 0));

    expect(seen).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });
});
