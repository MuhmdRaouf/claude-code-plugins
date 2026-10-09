import { describe, expect, it } from "vitest";
import { type ActivityRow, jobRows } from "../../src/app/activity.ts";
import type { BoardRow } from "../../src/app/queries.ts";
import type { Attempt, Job, Verdict } from "../../src/domain/job.ts";
import type { TierUsage } from "../../src/domain/usage.ts";
import {
  renderBoard,
  renderHook,
  renderJob,
  renderReview,
  renderStarted,
  renderSummary,
  renderUsage,
} from "../../src/render/index.ts";
import { aJob, anAttempt, aVerification } from "../support/builders.ts";
import { ACME_PROVIDER, ZAI_NAMES } from "../support/provider.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function attempt(verdict: Verdict): Attempt {
  return anAttempt({ outcome: { kind: "completed" }, verification: aVerification(), verdict });
}

function job(overrides: Partial<Job> = {}): Job {
  return aJob({
    id: "261006-acme01",
    state: "awaiting_review",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    attempts: [attempt("pass")],
    workspace: {
      repoRoot: "/repo",
      baseSha: "b".repeat(40),
      worktree: "/state/worktrees/261006-acme01",
      branch: "acme-jobs/261006-acme01",
      artifactsDir: "/state/jobs/261006-acme01/artifacts",
    },
    ...overrides,
  });
}

const TIER: TierUsage = {
  tier: "flash",
  jobs: 1,
  decided: 0,
  accepted: 0,
  discarded: 0,
  firstTryPassRate: null,
  acceptRate: null,
  meanAttemptsToAccept: null,
  reviewReturns: 0,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 1,
  costUsd: 0,
  rateLimitRetries: 0,
  durationMs: 1,
};

// Every renderer, fed a second provider: its names everywhere, none of zai's.
describe("renderers take every name from the provider", () => {
  const pass = job();
  const failed = job({ attempts: [attempt("gate_fail")] });
  const running = job({ state: "running", attempts: [anAttempt()] });
  const stale: BoardRow = { job: running, live: false };
  const rows: readonly ActivityRow[] = jobRows(ACME_PROVIDER, [stale, { job: pass, live: false }]);
  const outputs = {
    started: renderStarted(ACME_PROVIDER, running),
    emptyBoard: renderBoard(ACME_PROVIDER, [], NOW),
    board: renderBoard(ACME_PROVIDER, rows, NOW),
    hook: renderHook(ACME_PROVIDER, rows),
    show: renderJob(ACME_PROVIDER, stale, NOW),
    reviewPass: renderReview(ACME_PROVIDER, { job: pass }),
    reviewFail: renderReview(ACME_PROVIDER, { job: failed }),
    reviewRunning: renderReview(ACME_PROVIDER, { job: running }),
    summaryPass: renderSummary(ACME_PROVIDER, pass),
    summaryFail: renderSummary(ACME_PROVIDER, failed),
    emptyUsage: renderUsage(ACME_PROVIDER, { windows: [], jobs: [], engines: [], allJobs: [], now: NOW }),
    usage: renderUsage(ACME_PROVIDER, {
      windows: [],
      jobs: [TIER],
      engines: [],
      allJobs: [pass, failed],
      now: NOW,
    }),
  };

  it.each(Object.entries(outputs))("%s names nothing of zai's", (_, text) => {
    expect(text).not.toMatch(ZAI_NAMES);
  });

  it("uses the provider's CLI name, slash prefix, agent prefix and catalog ids", () => {
    expect(outputs.started).toBe("acme job 261006-acme01 started: Rename the helper (big-model-9, edit)");
    expect(outputs.emptyBoard).toBe(
      "No Acme Models activity yet. After /acme:setup, the sessions and subagents on its models appear here.",
    );
    expect(outputs.board).toContain(
      "stopping one here moves it to review, where /acme:review <id> discards it.",
    );
    expect(outputs.hook).toBe(
      "acme: 1 job awaits review (/acme:review 261006-acme01); 1 job queued or running. /acme:board lists them.",
    );
    expect(outputs.show.split("\n").slice(0, 2)).toEqual([
      "acme job 261006-acme01: Rename the helper",
      "running (stale: no live driver; /acme:board stops it, /acme:review 261006-acme01 then discards it) · big-model-9 · edit · created just now · updated just now",
    ]);
    expect(outputs.reviewPass.split("\n").slice(-2)).toEqual([
      "Next",
      "  /acme:review 261006-acme01 to read the diff and accept it, or return it with feedback.",
    ]);
    expect(outputs.reviewFail).toContain(
      "/acme:review 261006-acme01 to return it with the failing output as feedback, or discard it.",
    );
    expect(outputs.reviewFail).not.toContain("--force");
    expect(outputs.reviewRunning).toContain("it is running; /acme:board shows it until it awaits review.");
    expect(outputs.summaryFail.split("\n")[0]).toBe(
      "acme job 261006-acme01: verdict gate_fail (awaiting review)",
    );
    expect(outputs.summaryFail).toContain("Next: /acme:review 261006-acme01 to return it");
    expect(outputs.emptyUsage).toContain("Acme Models usage");
    expect(outputs.emptyUsage).toContain("No acme jobs in this repository yet.");
    expect(outputs.usage.split("\n").at(-1)).toMatch(/^small-model-9 {2}/);
  });
});
