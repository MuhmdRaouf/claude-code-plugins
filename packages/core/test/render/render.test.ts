import { describe, expect, it } from "vitest";
import type { ActivityRow, UsageWindow } from "../../src/app/activity.ts";
import { jobRows } from "../../src/app/activity.ts";
import type { BoardRow, ReviewPacket } from "../../src/app/queries.ts";
import type { Attempt, Job } from "../../src/domain/job.ts";
import type { TierUsage } from "../../src/domain/usage.ts";
import { INITIAL_PROGRESS } from "../../src/domain/worker-events.ts";
import {
  renderBoard,
  renderHook,
  renderJob,
  renderReview,
  renderStarted,
  renderSummary,
  renderUsage,
  renderWaitLine,
  renderWaitTotals,
} from "../../src/render/index.ts";
import {
  aBrief,
  aChangeSet,
  aGateResult,
  aJob,
  anAttempt,
  aReportCheck,
  aScopeCheck,
  aVerification,
} from "../support/builders.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const USAGE = {
  turns: 3,
  inputTokens: 4200,
  outputTokens: 310,
  cacheReadTokens: 2800,
  cacheWriteTokens: 900,
  costUsd: 0.0123,
  rateLimitRetries: 0,
  durationMs: 42_130,
};

const REPORT = {
  summary: "Renamed foo to bar in 3 files",
  files: [{ path: "src/a.ts", why: "rename" }],
  tests_added: ["test/a.test.ts"],
  open_items: ["docs still say foo"],
};

function passed(overrides: Partial<Attempt> = {}): Attempt {
  return anAttempt({
    endedAt: ago(5 * MIN),
    outcome: { kind: "completed" },
    usage: USAGE,
    report: REPORT,
    verification: aVerification({
      gates: [
        aGateResult({ run: "npm test", durationMs: 1200 }),
        aGateResult({ run: "npm run lint", durationMs: 400 }),
      ],
      changes: aChangeSet({
        added: ["src/b.ts"],
        modified: ["src/a.ts"],
        deleted: ["old.ts"],
        untracked: ["notes.md"],
      }),
    }),
    verdict: "pass",
    ...overrides,
  });
}

function gateFailed(n = 1): Attempt {
  return passed({
    n,
    verification: aVerification({
      gates: [
        aGateResult({
          run: "npm test",
          exitCode: 1,
          durationMs: 2300,
          tail: "FAIL test/a.test.ts\nexpected 2, got 1\n",
        }),
        aGateResult({ run: "npm run lint", durationMs: 400 }),
      ],
      changes: aChangeSet({ modified: ["src/a.ts"] }),
    }),
    verdict: "gate_fail",
  });
}

function reviewJob(attempts: readonly Attempt[], overrides: Partial<Job> = {}): Job {
  return aJob({
    id: "261006-abc123",
    state: "awaiting_review",
    createdAt: ago(20 * MIN),
    updatedAt: ago(5 * MIN),
    workspace: {
      repoRoot: "/repo",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      worktree: "/state/worktrees/261006-abc123",
      branch: "zai/261006-abc123",
      artifactsDir: "/state/jobs/261006-abc123/artifacts",
    },
    attempts,
    ...overrides,
  });
}

/** The job as one board row, the way `jobRows` maps it. */
function jobRowOf(job: Job, live = false): ActivityRow {
  return jobRows(REFERENCE_PROVIDER, [{ job, live }])[0] as ActivityRow;
}

const ESC = String.fromCharCode(27);

describe("renderers", () => {
  it("renderBoard: one table of subagents, sessions and jobs, active first, stale jobs flagged; snapshot", () => {
    const rows: ActivityRow[] = [
      {
        kind: "subagent",
        id: "3f2a1b9c",
        model: "glm-5.3",
        state: "active",
        requests: 12,
        inputTokens: 45_200,
        outputTokens: 3100,
        at: ago(5_000),
      },
      {
        kind: "session",
        id: "9c8b7a6d",
        model: "glm-5.3-flash",
        state: "idle",
        requests: 3,
        inputTokens: 1200,
        outputTokens: 300,
        at: ago(2 * HOUR),
      },
      {
        kind: "job",
        id: "261006-run001",
        state: "running",
        at: ago(3 * MIN),
        title: "Rename the helper",
      },
      {
        kind: "job",
        id: "261006-old001",
        state: "verifying",
        stale: true,
        at: ago(26 * HOUR),
        title: "Sweep call sites",
      },
    ];

    expect(renderBoard(REFERENCE_PROVIDER, rows, NOW)).toMatchInlineSnapshot(`
      "KIND      ID             MODEL          STATE              REQ  IN     OUT   LAST      TITLE
      subagent  3f2a1b9c       glm-5.3        active             12   45.2k  3.1k  just now  -
      session   9c8b7a6d       glm-5.3-flash  idle               3    1.2k   300   2h ago    -
      job       261006-run001  -              running            -    -      -     3m ago    Rename the helper
      job       261006-old001  -              verifying (stale)  -    -      -     1d ago    Sweep call sites

      stale: 1 job has no live driver (261006-old001); stopping one here moves it to review, where /zai:review <id> discards it."
    `);
  });

  it("renderBoard: empty board says so and where activity will appear", () => {
    expect(renderBoard(REFERENCE_PROVIDER, [], NOW)).toMatchInlineSnapshot(
      `"No Z.ai GLM activity yet. After /zai:setup, the sessions and subagents on its models appear here."`,
    );
  });

  it("renderReview: header, report summary and open items, gate table with failing tails, scope, changes, usage, next actions; snapshot pass + gate_fail", () => {
    const pass: ReviewPacket = {
      job: reviewJob([gateFailed(), passed({ n: 2, kind: "auto_fix" })]),
      diffStat: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
      diff: "diff --git a/src/a.ts b/src/a.ts\n-foo\n+bar\n",
    };
    const fail: ReviewPacket = { job: reviewJob([gateFailed()]) };

    expect(renderReview(REFERENCE_PROVIDER, pass)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict pass · glm-5.3 · edit · attempt 2 (auto_fix) · awaiting review
      worktree /state/worktrees/261006-abc123 (branch zai/261006-abc123, base 0123456)

      Attempts
        #1 (initial): gate_fail; gates 1/2 passed (failing: \`npm test\`); 1 changed path, in scope; report valid.
        #2 (auto_fix): pass; gates 2/2 passed; 4 changed paths, in scope; report valid.

      Report
        Renamed foo to bar in 3 files
        Tests added: test/a.test.ts
        Open items:
        - docs still say foo

      Gates (2/2 passed)
        pass  npm test      exit 0  1.2s
        pass  npm run lint  exit 0  0.4s

      Scope: in scope
      Changes (4):
        A src/b.ts
        M src/a.ts
        D old.ts
        ? notes.md

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · est. $0.0080 · 42s

      Diff stat
         src/a.ts | 2 +-
         1 file changed, 1 insertion(+), 1 deletion(-)

      Diff
      \`\`\`diff
      diff --git a/src/a.ts b/src/a.ts
      -foo
      +bar
      \`\`\`

      Next
        /zai:review 261006-abc123 to read the diff and accept it, or return it with feedback."
    `);
    expect(renderReview(REFERENCE_PROVIDER, fail)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict gate_fail · glm-5.3 · edit · attempt 1 (initial) · awaiting review
      worktree /state/worktrees/261006-abc123 (branch zai/261006-abc123, base 0123456)

      Report
        Renamed foo to bar in 3 files
        Tests added: test/a.test.ts
        Open items:
        - docs still say foo

      Gates (1/2 passed)
        FAIL  npm test      exit 1  2.3s
          | FAIL test/a.test.ts
          | expected 2, got 1
        pass  npm run lint  exit 0  0.4s

      Scope: in scope
      Changes (1):
        M src/a.ts

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · est. $0.0080 · 42s

      Next
        /zai:review 261006-abc123 to return it with the failing output as feedback, or discard it."
    `);
  });

  it("renderReview: scope violations, an invalid report and a worker error are spelled out", () => {
    const attempt = passed({
      outcome: { kind: "api_error", message: "API Error: Request rejected (429)", status: 429 },
      usage: { ...USAGE, rateLimitRetries: 10 },
      report: undefined,
      verification: aVerification({
        scope: aScopeCheck({ outOfScope: ["package.json"], forbidden: [".env"] }),
        report: aReportCheck({ present: false, valid: false, problems: ["no structured report"] }),
        changes: aChangeSet({ modified: ["package.json", ".env"] }),
      }),
      verdict: "worker_error",
    });
    const exec = reviewJob([attempt], {
      brief: aBrief({ mode: "exec", scope: [] }),
      workspace: { repoRoot: "/repo", baseSha: "0".repeat(40), artifactsDir: "/state/jobs/x/artifacts" },
    });
    const changed = passed({
      report: { summary: "x", open_items: [] },
      verification: aVerification({
        scope: aScopeCheck({ repoChanged: true }),
        report: aReportCheck({ valid: false, problems: ["items: Invalid input"] }),
      }),
      verdict: "scope_violation",
    });

    expect(renderReview(REFERENCE_PROVIDER, { job: exec })).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict worker_error · glm-5.3 · exec · attempt 1 (initial) · awaiting review
      repository /repo (must stay unchanged), artifacts /state/jobs/x/artifacts

      Worker: API error (429): API Error: Request rejected (429)

      Report: missing (the worker ended without a structured report)

      Gates: none run

      Scope: VIOLATED, out of scope: package.json; forbidden: .env
      Changes (2):
        M package.json
        M .env

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · est. $0.0080 · 42s · 10 rate-limit retries

      Next
        the worker never finished (API error (429): API Error: Request rejected (429)): nothing to accept. Fix the cause, then /zai:review 261006-abc123 to return it to try again, or discard it."
    `);
    expect(
      renderReview(REFERENCE_PROVIDER, { job: reviewJob([changed], { state: "running" }) }),
    ).toMatchInlineSnapshot(`
      "zai job 261006-abc123: Rename the helper
      verdict scope_violation · glm-5.3 · edit · attempt 1 (initial) · running
      worktree /state/worktrees/261006-abc123 (branch zai/261006-abc123, base 0123456)

      Report
        x
        Open items: none
        Invalid against its contract:
        - items: Invalid input

      Gates: none run

      Scope: VIOLATED, the repository changed (this job must leave it unchanged)
      Changes: none

      Usage: 3 turns · 4.2k in / 310 out tokens · 2.8k cache read · est. $0.0080 · 42s

      Next
        it is running; /zai:board shows it until it awaits review."
    `);
  });

  it("renderSummary: verdict first, then files changed count, gates line, next actions; under 25 lines", () => {
    const many = aChangeSet({ modified: Array.from({ length: 14 }, (_, i) => `src/file-${i}.ts`) });
    const pass = reviewJob([gateFailed(), passed({ n: 2, kind: "auto_fix" })]);
    const failed = reviewJob([
      gateFailed(),
      {
        ...gateFailed(2),
        kind: "auto_fix",
        verification: aVerification({ changes: many, gates: [aGateResult({ exitCode: 1 })] }),
      },
    ]);
    const crashed = reviewJob([
      anAttempt({
        outcome: { kind: "crashed", exitCode: 1, signal: null, stderrTail: "Error: boom\n" },
        verification: aVerification(),
        verdict: "worker_error",
      }),
    ]);

    expect(renderSummary(REFERENCE_PROVIDER, pass)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: verdict pass (awaiting review)
      Rename the helper (glm-5.3, edit); 2 attempts: #1 initial gate_fail, #2 auto_fix pass
      Changed 4 files: notes.md, old.ts, src/a.ts, src/b.ts
      Gates: 2/2 passed
      Report: Renamed foo to bar in 3 files (1 open item)
      Next: /zai:review 261006-abc123 to read the diff and accept it, or return it with feedback."
    `);
    expect(renderSummary(REFERENCE_PROVIDER, failed)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: verdict gate_fail (awaiting review)
      Rename the helper (glm-5.3, edit); 2 attempts: #1 initial gate_fail, #2 auto_fix gate_fail
      Changed 14 files: src/file-0.ts, src/file-1.ts, src/file-10.ts, src/file-11.ts, src/file-12.ts, src/file-13.ts, src/file-2.ts, src/file-3.ts, src/file-4.ts, src/file-5.ts and 4 more
      Gates: 0/1 passed; failing: npm test
      Report: Renamed foo to bar in 3 files (1 open item)
      Next: /zai:review 261006-abc123 to return it with the failing output as feedback, or discard it."
    `);
    expect(renderSummary(REFERENCE_PROVIDER, crashed)).toMatchInlineSnapshot(`
      "zai job 261006-abc123: verdict worker_error (awaiting review)
      Rename the helper (glm-5.3, edit); 1 attempt: #1 initial worker_error
      Worker: crashed (exit 1): Error: boom
      Changed: nothing
      Gates: none
      Report: (no summary)
      Next: the worker never finished (crashed (exit 1): Error: boom): nothing to accept. Fix the cause, then /zai:review 261006-abc123 to return it to try again, or discard it."
    `);
    for (const job of [pass, failed, crashed]) {
      expect(renderSummary(REFERENCE_PROVIDER, job).split("\n").length).toBeLessThan(25);
    }
  });

  it("renderUsage: per-model windows with a total each, priced from the table, then the job ledger; snapshot", () => {
    const main: TierUsage = {
      tier: "main",
      jobs: 5,
      decided: 4,
      accepted: 3,
      discarded: 1,
      firstTryPassRate: 0.5,
      acceptRate: 0.75,
      meanAttemptsToAccept: 1.6666,
      reviewReturns: 2,
      inputTokens: 1_234_567,
      outputTokens: 45_600,
      cacheReadTokens: 980,
      costUsd: 3.456,
      rateLimitRetries: 12,
      durationMs: 3_600_000,
    };
    const flash: TierUsage = {
      ...main,
      tier: "flash",
      jobs: 1,
      decided: 0,
      accepted: 0,
      discarded: 0,
      firstTryPassRate: null,
      acceptRate: null,
      meanAttemptsToAccept: null,
      reviewReturns: 0,
      costUsd: 0.0042,
      rateLimitRetries: 0,
    };
    const windows: UsageWindow[] = [
      { label: "Today", days: 1, rows: [] },
      {
        label: "Last 7 days",
        days: 7,
        rows: [
          {
            model: "glm-5.3",
            requests: 12,
            inputTokens: 1_000_000,
            outputTokens: 200_000,
            cacheReadTokens: 500_000,
            cacheWriteTokens: 0,
          },
          {
            model: "glm-5.3-flash",
            requests: 3,
            inputTokens: 100_000,
            outputTokens: 50_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 100_000,
          },
        ],
      },
      { label: "Last 30 days", days: 30, rows: [] },
    ];

    expect(
      renderUsage(REFERENCE_PROVIDER, {
        windows,
        jobs: [main, flash],
        engines: [],
        allJobs: [reviewJob([passed()])],
        now: NOW,
      }),
    ).toMatchInlineSnapshot(`
      "Z.ai GLM usage
      Est. cost: today $0.0080 · 7 days $2.46 · 30 days $0.0080 (30 days: agents and /model $0.0000, jobs $0.0080)
      Estimated from Z.ai GLM list prices read 2026-10-08; your bill is the provider's. Token counts are exact.

      Today: no agent or /model requests.
      Last 7 days, agents and /model
      MODEL          REQ  IN      OUT     CACHE R  CACHE W  EST COST
      glm-5.3        12   1.0M    200.0k  500.0k   0        $2.41
      glm-5.3-flash  3    100.0k  50.0k   0        100.0k   $0.0400
      TOTAL          15   1.1M    250.0k  500.0k   100.0k   $2.45
      Last 30 days: no agent or /model requests.

      zai jobs in this repository
      MODEL          JOBS  ACCEPTED  DISCARDED  1ST-TRY  RETURNS  IN    OUT    429S  TIME
      glm-5.3        5     3         1          50%      2        1.2M  45.6k  12    1h00m
      glm-5.3-flash  1     0         0          n/a      0        1.2M  45.6k  0     1h00m"
    `);
    expect(
      renderUsage(REFERENCE_PROVIDER, { windows: [], jobs: [], engines: [], allJobs: [], now: NOW }),
    ).toMatchInlineSnapshot(`
      "Z.ai GLM usage
      Est. cost: today $0.0000 · 7 days $0.0000 · 30 days $0.0000 (30 days: agents and /model $0.0000, jobs $0.0000)
      Estimated from Z.ai GLM list prices read 2026-10-08; your bill is the provider's. Token counts are exact.


      No zai jobs in this repository yet."
    `);
  });

  it("renderStarted, renderHook and renderJob: the one-liners and the job view", () => {
    const running: BoardRow = {
      job: aJob({
        id: "261006-run001",
        state: "running",
        createdAt: ago(3 * MIN),
        updatedAt: ago(MIN),
        attempts: [gateFailed(), anAttempt({ n: 2, kind: "auto_fix" })],
      }),
      progress: { ...INITIAL_PROGRESS, phase: "writing", lastText: "Now I will\nupdate the tests", turns: 4 },
      live: true,
    };
    const review: BoardRow = { job: reviewJob([passed()]), live: false };

    expect(renderStarted(REFERENCE_PROVIDER, reviewJob([]))).toBe(
      "zai job 261006-abc123 started: Rename the helper (glm-5.3, edit)",
    );
    const rows = jobRows(
      REFERENCE_PROVIDER,
      [running, review, running].map((row) => ({ job: row.job, live: row.live })),
    );
    expect(renderHook(REFERENCE_PROVIDER, rows)).toMatchInlineSnapshot(
      `"zai: 1 job awaits review (/zai:review 261006-abc123); 2 jobs queued or running. /zai:board lists them."`,
    );
    expect(
      renderHook(REFERENCE_PROVIDER, [{ kind: "job", id: "j-done", state: "accepted", at: ago(0) }]),
    ).toBe("");
    expect(renderJob(REFERENCE_PROVIDER, running, NOW)).toMatchInlineSnapshot(`
      "zai job 261006-run001: Rename the helper
      running · glm-5.3 · edit · created 3m ago · updated 1m ago
      workspace /state/worktrees/j1
      Attempts:
        #1 (initial): gate_fail; gates 1/2 passed (failing: \`npm test\`); 1 changed path, in scope; report valid.
        #2 (auto_fix): no verdict; not verified.
      Progress: writing
        "Now I will update the tests""
    `);
    expect(renderJob(REFERENCE_PROVIDER, { job: running.job, live: false }, NOW)).toContain("stale");
  });

  it("renderWaitLine and renderWaitTotals: one compact line per landed job, then the totals", () => {
    const sweep = reviewJob(
      [
        passed({
          report: {
            summary: "4 sites swept",
            items: [
              { id: "src/a.ts", status: "ok", detail: "no foo left" },
              { id: "src/b.ts", status: "ok", detail: "" },
              { id: "src/c.ts", status: "fail", detail: "still calls foo" },
              { id: "src/d.ts", status: "gap", detail: "not checked" },
            ],
            open_items: [],
          },
        }),
      ],
      {
        brief: aBrief({
          mode: "exec",
          report: { kind: "builtin", name: "sweep" },
          title: "Sweep call sites",
        }),
      },
    );
    const longTitle = "Rename the helper everywhere it is called from in the whole codebase today";

    expect(renderWaitLine(REFERENCE_PROVIDER, reviewJob([passed()]), true)).toBe(
      "261006-abc123 pass Rename the helper gates 2/2 est. $0.0080",
    );
    expect(
      renderWaitLine(REFERENCE_PROVIDER, reviewJob([passed({ verification: aVerification() })]), true),
    ).toBe("261006-abc123 pass Rename the helper gates none est. $0.0080");
    expect(renderWaitLine(REFERENCE_PROVIDER, sweep, true)).toBe(
      "261006-abc123 pass Sweep call sites sweep 2/1/1 est. $0.0080",
    );
    expect(renderWaitLine(REFERENCE_PROVIDER, reviewJob([anAttempt()]), false)).toBe(
      "261006-abc123 stale Rename the helper gates ? est. $0.0000",
    );
    expect(
      renderWaitLine(
        REFERENCE_PROVIDER,
        reviewJob([passed()], { brief: aBrief({ title: longTitle }) }),
        true,
      ),
    ).toBe(`261006-abc123 pass ${longTitle.slice(0, 59)}… gates 2/2 est. $0.0080`);

    expect(renderWaitTotals(REFERENCE_PROVIDER, [reviewJob([passed()]), reviewJob([gateFailed()])])).toBe(
      "2 jobs: 1 pass, 1 not pass · est. $0.0159",
    );
    expect(renderWaitTotals(REFERENCE_PROVIDER, [reviewJob([passed()])])).toBe(
      "1 job: 1 pass, 0 not pass · est. $0.0080",
    );
    expect(renderWaitTotals(REFERENCE_PROVIDER, [])).toBe("0 jobs: 0 pass, 0 not pass · est. $0.0000");
  });

  it("no ANSI escape codes in any output", () => {
    const job = reviewJob([gateFailed(), passed({ n: 2 })]);
    const outputs = [
      renderBoard(REFERENCE_PROVIDER, [jobRowOf(job)], NOW),
      renderReview(REFERENCE_PROVIDER, { job, diff: "+x\n", diffStat: " a | 1 +\n" }),
      renderSummary(REFERENCE_PROVIDER, job),
      renderJob(REFERENCE_PROVIDER, { job, live: true }, NOW),
      renderWaitLine(REFERENCE_PROVIDER, job, true),
      renderWaitTotals(REFERENCE_PROVIDER, [job]),
      renderUsage(REFERENCE_PROVIDER, {
        windows: [],
        engines: [],
        allJobs: [job],
        now: NOW,
        jobs: [
          {
            tier: "main",
            jobs: 1,
            decided: 1,
            accepted: 1,
            discarded: 0,
            firstTryPassRate: 1,
            acceptRate: 1,
            meanAttemptsToAccept: 2,
            reviewReturns: 0,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 1,
            costUsd: 1,
            rateLimitRetries: 0,
            durationMs: 1,
          },
        ],
      }),
    ];

    for (const output of outputs) expect(output).not.toContain(ESC);
  });
});
