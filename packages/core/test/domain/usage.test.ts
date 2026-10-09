import { describe, expect, it } from "vitest";
import type { Brief } from "../../src/domain/brief.ts";
import type { Attempt, AttemptKind, Job, JobState, Usage, Verdict } from "../../src/domain/job.ts";
import type { ModelTier } from "../../src/domain/model.ts";
import { summarizeUsage } from "../../src/domain/usage.ts";

const NO_USAGE: Usage = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  rateLimitRetries: 0,
  durationMs: 0,
};

function attempt(n: number, kind: AttemptKind, verdict?: Verdict, usage?: Partial<Usage>): Attempt {
  return {
    n,
    kind,
    prompt: "do it",
    sessionId: `session-${n}`,
    startedAt: "2026-10-06T08:00:00.000Z",
    ...(verdict === undefined ? {} : { verdict }),
    ...(usage === undefined ? {} : { usage: { ...NO_USAGE, ...usage } }),
  };
}

let nextId = 0;

function job(model: ModelTier, state: JobState, attempts: readonly Attempt[] = []): Job {
  nextId += 1;
  const brief: Brief = {
    title: `job ${nextId}`,
    body: "Fix it.",
    model,
    mode: "edit",
    cwd: "/work/repo",
    base: "HEAD",
    scope: ["**"],
    forbid: [],
    gates: [],
    setup: [],
    regenerate: [],
    timeoutMs: 7_200_000,
    retries: { fix: 1, infra: 2 },
    report: { kind: "builtin", name: "change" },
    addDirs: [],
    env: [],
    tags: [],
  };
  return {
    id: `job-${nextId}`,
    brief,
    state,
    workspace: { repoRoot: "/work/repo", baseSha: "abc123", artifactsDir: "/state/artifacts" },
    attempts,
    createdAt: "2026-10-06T08:00:00.000Z",
    updatedAt: "2026-10-06T08:00:00.000Z",
    version: 1,
  };
}

describe("summarizeUsage", () => {
  it("returns one row per tier that has jobs, glm first", () => {
    const flashOnly = summarizeUsage([job("flash", "queued")]);
    const both = summarizeUsage([job("flash", "running"), job("main", "queued"), job("flash", "queued")]);

    expect(summarizeUsage([])).toEqual([]);
    expect(flashOnly.map((row) => row.tier)).toEqual(["flash"]);
    expect(both.map((row) => [row.tier, row.jobs])).toEqual([
      ["main", 1],
      ["flash", 2],
    ]);
  });
  it("counts jobs, decided, accepted, discarded", () => {
    const jobs = [
      job("main", "queued"),
      job("main", "running"),
      job("main", "verifying"),
      job("main", "awaiting_review"),
      job("main", "accepted"),
      job("main", "accepted"),
      job("main", "discarded"),
    ];

    expect(summarizeUsage(jobs)[0]).toMatchObject({ jobs: 7, decided: 3, accepted: 2, discarded: 1 });
  });
  it("firstTryPassRate uses the first attempt's verdict over decided jobs", () => {
    const jobs = [
      job("main", "accepted", [attempt(1, "initial", "pass")]),
      job("main", "accepted", [attempt(1, "initial", "gate_fail"), attempt(2, "auto_fix", "pass")]),
      job("main", "discarded", [attempt(1, "initial", "pass"), attempt(2, "review_fix", "gate_fail")]),
      job("main", "discarded", []),
      // Undecided jobs do not count, even with a passing first attempt.
      job("main", "awaiting_review", [attempt(1, "initial", "pass")]),
    ];

    expect(summarizeUsage(jobs)[0]?.firstTryPassRate).toBe(0.5);
  });
  it("acceptRate = accepted / decided; meanAttemptsToAccept over accepted jobs", () => {
    const jobs = [
      job("flash", "accepted", [attempt(1, "initial", "pass")]),
      job("flash", "accepted", [attempt(1, "initial", "gate_fail"), attempt(2, "auto_fix", "pass")]),
      job("flash", "accepted", [
        attempt(1, "initial", "worker_error"),
        attempt(2, "infra_retry", "gate_fail"),
        attempt(3, "auto_fix", "pass"),
      ]),
      job("flash", "discarded", [attempt(1, "initial"), attempt(2, "auto_fix"), attempt(3, "review_fix")]),
      job("flash", "running", [attempt(1, "initial")]),
    ];

    expect(summarizeUsage(jobs)[0]).toMatchObject({ acceptRate: 0.75, meanAttemptsToAccept: 2 });
  });
  it("reviewReturns counts review_fix attempts", () => {
    // A return is a reviewer event that has already happened, so jobs still in flight count too.
    const jobs = [
      job("main", "accepted", [attempt(1, "initial"), attempt(2, "review_fix"), attempt(3, "review_fix")]),
      job("main", "running", [attempt(1, "initial"), attempt(2, "auto_fix"), attempt(3, "review_fix")]),
      job("main", "discarded", [attempt(1, "initial"), attempt(2, "infra_retry")]),
    ];

    expect(summarizeUsage(jobs)[0]?.reviewReturns).toBe(3);
  });
  it("sums tokens, cost, rate-limit retries and duration over all attempts", () => {
    const jobs = [
      job("main", "accepted", [
        attempt(1, "initial", "gate_fail", {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 1000,
          cacheWriteTokens: 7,
          costUsd: 0.25,
          rateLimitRetries: 2,
          durationMs: 60_000,
        }),
        attempt(2, "auto_fix", "pass", {
          inputTokens: 50,
          outputTokens: 5,
          costUsd: 0.5,
          durationMs: 30_000,
        }),
      ]),
      job("main", "running", [attempt(1, "initial", undefined, { inputTokens: 1, rateLimitRetries: 10 })]),
      // An attempt that never produced usage (still running) contributes nothing.
      job("main", "queued", [attempt(1, "initial")]),
      job("flash", "accepted", [attempt(1, "initial", "pass", { inputTokens: 999, costUsd: 9 })]),
    ];

    expect(summarizeUsage(jobs)[0]).toMatchObject({
      inputTokens: 151,
      outputTokens: 15,
      cacheReadTokens: 1000,
      costUsd: 0.75,
      rateLimitRetries: 12,
      durationMs: 90_000,
    });
  });
  it("rates are null with a zero denominator", () => {
    const undecided = summarizeUsage([job("main", "running", [attempt(1, "initial")])])[0];
    const noneAccepted = summarizeUsage([job("main", "discarded", [attempt(1, "initial", "gate_fail")])])[0];

    expect(undecided).toMatchObject({ firstTryPassRate: null, acceptRate: null, meanAttemptsToAccept: null });
    expect(noneAccepted).toMatchObject({ firstTryPassRate: 0, acceptRate: 0, meanAttemptsToAccept: null });
  });
});
