import { describe, expect, it } from "vitest";
import type { Attempt, AttemptKind, JobState } from "../../src/domain/job.ts";
import { afterVerification, type JobEvent, nextState, TERMINAL } from "../../src/domain/lifecycle.ts";
import { err, ok } from "../../src/domain/result.ts";
import { aBrief, aJob, anAttempt } from "../support/builders.ts";

const STATES: readonly JobState[] = [
  "queued",
  "running",
  "verifying",
  "awaiting_review",
  "accepted",
  "discarded",
];

const EVENTS: readonly JobEvent[] = [
  { type: "slot_acquired" },
  { type: "worker_exited" },
  { type: "verified" },
  { type: "retry", kind: "auto_fix" },
  { type: "retry", kind: "infra_retry" },
  { type: "returned", feedback: "Also update the docs." },
  { type: "accepted" },
  { type: "discarded" },
  { type: "stopped" },
];

/** The legal moves, written out independently of the implementation's table. */
const LEGAL: readonly (readonly [JobState, JobEvent["type"], JobState])[] = [
  ["queued", "slot_acquired", "running"],
  ["running", "worker_exited", "verifying"],
  ["verifying", "verified", "awaiting_review"],
  ["verifying", "retry", "running"],
  ["awaiting_review", "returned", "queued"],
  ["awaiting_review", "accepted", "accepted"],
  ["queued", "discarded", "discarded"],
  ["running", "discarded", "discarded"],
  ["verifying", "discarded", "discarded"],
  ["awaiting_review", "discarded", "discarded"],
  ["queued", "stopped", "awaiting_review"],
  ["running", "stopped", "awaiting_review"],
  ["verifying", "stopped", "awaiting_review"],
];

const isLegal = (from: JobState, event: JobEvent): boolean =>
  LEGAL.some(([state, type]) => state === from && type === event.type);

/** A job in `verifying` whose attempts have these kinds, in order (the last one is the attempt just verified). */
function jobWithAttempts(kinds: readonly AttemptKind[], retries = { fix: 1, infra: 2 }) {
  const attempts: Attempt[] = kinds.map((kind, i) => anAttempt({ n: i + 1, kind }));
  return aJob({ state: "verifying", brief: aBrief({ retries }), attempts });
}

const ILLEGAL_PAIRS = STATES.flatMap((from) =>
  EVENTS.filter((event) => !isLegal(from, event)).map((event) => ({ from, event })),
);

describe("nextState", () => {
  it("queued --slot_acquired--> running", () => {
    expect(nextState("queued", { type: "slot_acquired" })).toEqual(ok("running"));
  });

  it("running --worker_exited--> verifying", () => {
    expect(nextState("running", { type: "worker_exited" })).toEqual(ok("verifying"));
  });

  it("verifying --verified--> awaiting_review", () => {
    expect(nextState("verifying", { type: "verified" })).toEqual(ok("awaiting_review"));
  });

  it("verifying --retry(auto_fix|infra_retry)--> running", () => {
    expect(nextState("verifying", { type: "retry", kind: "auto_fix" })).toEqual(ok("running"));
    expect(nextState("verifying", { type: "retry", kind: "infra_retry" })).toEqual(ok("running"));
  });

  it("awaiting_review --returned--> queued", () => {
    expect(nextState("awaiting_review", { type: "returned", feedback: "Also update the docs." })).toEqual(
      ok("queued"),
    );
  });

  it("awaiting_review --accepted--> accepted", () => {
    expect(nextState("awaiting_review", { type: "accepted" })).toEqual(ok("accepted"));
  });

  it.each(["queued", "running", "verifying", "awaiting_review"] as const)(
    "queued|running|verifying|awaiting_review --discarded--> discarded",
    (from) => {
      expect(nextState(from, { type: "discarded" })).toEqual(ok("discarded"));
    },
  );

  it.each(["queued", "running", "verifying"] as const)(
    "queued|running|verifying --stopped--> awaiting_review",
    (from) => {
      expect(nextState(from, { type: "stopped" })).toEqual(ok("awaiting_review"));
    },
  );

  it.each(ILLEGAL_PAIRS)(
    "is total: every (state × event) pair not listed above is illegal_transition naming from and event (table-driven)",
    ({ from, event }) => {
      expect(nextState(from, event)).toEqual(err({ kind: "illegal_transition", from, event: event.type }));
    },
  );

  it("terminal states accept no event", () => {
    for (const from of TERMINAL) {
      for (const event of EVENTS) {
        expect(nextState(from, event)).toEqual(err({ kind: "illegal_transition", from, event: event.type }));
      }
    }
    expect([...TERMINAL].sort()).toEqual(["accepted", "discarded"]);
  });
});

describe("afterVerification", () => {
  it("pass → await_review", () => {
    const job = aJob({ state: "verifying", attempts: [anAttempt({ verdict: "pass" })] });
    expect(afterVerification(job, "pass")).toEqual({ kind: "await_review" });
  });

  it("quota → await_review with infra budget left: no retry succeeds before a top-up", () => {
    const job = jobWithAttempts(["initial"], { fix: 2, infra: 2 });
    expect(afterVerification(job, "quota")).toEqual({ kind: "await_review" });
  });

  it.each(["gate_fail", "scope_violation", "report_invalid"] as const)(
    "gate_fail, scope_violation, report_invalid → auto_fix while fix budget remains",
    (verdict) => {
      const job = jobWithAttempts(["initial", "auto_fix"], { fix: 2, infra: 2 });
      expect(afterVerification(job, verdict)).toEqual({ kind: "auto_fix" });
    },
  );

  it.each(["gate_fail", "scope_violation", "report_invalid"] as const)(
    "→ await_review once the fix budget is spent",
    (verdict) => {
      const job = jobWithAttempts(["initial", "auto_fix", "auto_fix"], { fix: 2, infra: 2 });
      expect(afterVerification(job, verdict)).toEqual({ kind: "await_review" });
    },
  );

  it.each(["worker_error", "timeout"] as const)(
    "worker_error and timeout → infra_retry while infra budget remains, then await_review",
    (verdict) => {
      const budget = { fix: 1, infra: 2 };
      expect(afterVerification(jobWithAttempts(["initial"], budget), verdict)).toEqual({
        kind: "infra_retry",
      });
      expect(afterVerification(jobWithAttempts(["initial", "infra_retry"], budget), verdict)).toEqual({
        kind: "infra_retry",
      });
      expect(
        afterVerification(jobWithAttempts(["initial", "infra_retry", "infra_retry"], budget), verdict),
      ).toEqual({ kind: "await_review" });
    },
  );

  it("stopped → await_review regardless of budget", () => {
    const job = jobWithAttempts(["initial"], { fix: 5, infra: 5 });
    expect(afterVerification(job, "stopped")).toEqual({ kind: "await_review" });
  });

  it("a review_fix attempt resets both budgets (only attempts after the last review_fix count)", () => {
    const budget = { fix: 1, infra: 1 };
    const spentThenReturned = jobWithAttempts(["initial", "auto_fix", "infra_retry", "review_fix"], budget);
    expect(afterVerification(spentThenReturned, "gate_fail")).toEqual({ kind: "auto_fix" });
    expect(afterVerification(spentThenReturned, "worker_error")).toEqual({ kind: "infra_retry" });

    const spentAgain = jobWithAttempts(["initial", "auto_fix", "review_fix", "auto_fix"], budget);
    expect(afterVerification(spentAgain, "gate_fail")).toEqual({ kind: "await_review" });
  });

  it.each(["gate_fail", "scope_violation", "report_invalid"] as const)(
    "retries {fix: 0} never auto-fixes",
    (verdict) => {
      const job = jobWithAttempts(["initial"], { fix: 0, infra: 2 });
      expect(afterVerification(job, verdict)).toEqual({ kind: "await_review" });
    },
  );
});
