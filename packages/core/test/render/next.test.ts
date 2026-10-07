import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { UsageWindow } from "../../src/app/activity.ts";
import { jobRows } from "../../src/app/activity.ts";
import type { Attempt, Verdict } from "../../src/domain/job.ts";
import { renderHook, renderSummary, renderUsage } from "../../src/render/index.ts";
import { conflictStep, nextStep } from "../../src/render/next.ts";
import { costUsdOf, PRICE_TABLE, PRICES_RETRIEVED, priceOf } from "../../src/render/prices.ts";
import { jobCostUsd, windowCosts } from "../../src/render/usage.ts";
import { aBrief, aJob, anAttempt } from "../support/builders.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const USAGE = {
  turns: 2,
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 9.99,
  rateLimitRetries: 0,
  durationMs: 1000,
};

function landed(verdict: Verdict, extra: Partial<Attempt> = {}, mode: "edit" | "exec" | "readonly" = "edit") {
  return aJob({
    id: "261006-next01",
    state: "awaiting_review",
    brief: aBrief({ mode }),
    attempts: [anAttempt({ verdict, ...extra })],
  });
}

describe("nextStep: the next step follows the verdict", () => {
  it("pass on an edit job: read the diff and accept it", () => {
    expect(nextStep(REFERENCE_PROVIDER, landed("pass"))).toBe(
      "/zai:review 261006-next01 to read the diff and accept it, or return it with feedback.",
    );
  });

  it.each(["readonly", "exec"] as const)("pass on a %s job never says accept: nothing to merge", (mode) => {
    const text = nextStep(REFERENCE_PROVIDER, landed("pass", {}, mode));

    expect(text).toContain("nothing to merge");
    expect(text).not.toMatch(/accept/);
  });

  it.each(["worker_error", "timeout"] as const)(
    "%s: the worker never finished, so there is nothing to accept",
    (verdict) => {
      const crashed = landed(verdict, {
        outcome: { kind: "crashed", exitCode: 1, signal: null, stderrTail: "boom" },
      });
      const text = nextStep(REFERENCE_PROVIDER, crashed);

      expect(text).toContain("the worker never finished (crashed (exit 1): boom)");
      expect(text).toContain("nothing to accept");
      expect(text).not.toMatch(/--force|accept it/);
    },
  );

  it.each(["gate_fail", "scope_violation", "report_invalid"] as const)(
    "%s: return with the failing output, never --force",
    (verdict) => {
      const text = nextStep(REFERENCE_PROVIDER, landed(verdict));

      expect(text).toBe(
        "/zai:review 261006-next01 to return it with the failing output as feedback, or discard it.",
      );
    },
  );

  it("quota: top up at the provider's billing page first; nothing was retried", () => {
    expect(nextStep(REFERENCE_PROVIDER, landed("quota"))).toBe(
      `Z.ai GLM says the account has no balance or quota left, so it was not retried: top up at https://z.ai/manage-apikey/billing, then /zai:review ${landed("quota").id} to return it to try again, or discard it.`,
    );
  });

  it("stopped: return or discard", () => {
    expect(nextStep(REFERENCE_PROVIDER, landed("stopped"))).toContain(
      "return it with feedback, or discard it",
    );
  });

  it("a job that is not awaiting review points at the board; a decided one has nothing left", () => {
    expect(nextStep(REFERENCE_PROVIDER, aJob({ state: "verifying" }))).toBe(
      "it is verifying; /zai:board shows it until it awaits review.",
    );
    expect(nextStep(REFERENCE_PROVIDER, aJob({ state: "accepted" }))).toBe(
      "nothing left to do: the job was accepted.",
    );
  });

  it("no CLI name anywhere: every step names a slash command", () => {
    for (const verdict of ["pass", "gate_fail", "worker_error", "stopped", "timeout"] as const) {
      expect(renderSummary(REFERENCE_PROVIDER, landed(verdict))).not.toMatch(
        /(^|\s)zai (accept|return|discard|review)/m,
      );
    }
  });

  it("a merge conflict says discard and run again: the worker may not rebase", () => {
    const text = conflictStep(REFERENCE_PROVIDER);

    expect(text).toContain("cannot rebase");
    expect(text).toContain("run the brief again on the current branch");
    expect(text).not.toMatch(/ask(ing)? the worker to rebase/);
  });
});

describe("the SessionStart review line", () => {
  it("names at most three jobs, then how many more", () => {
    const jobs = ["a", "b", "c", "d", "e"].map((id) => ({
      job: aJob({ id: `261006-${id}`, state: "awaiting_review", attempts: [anAttempt({ verdict: "pass" })] }),
      live: false,
    }));

    expect(renderHook(REFERENCE_PROVIDER, jobRows(REFERENCE_PROVIDER, jobs))).toBe(
      "zai: 5 jobs await review (/zai:review 261006-a, /zai:review 261006-b, /zai:review 261006-c and 2 more). /zai:board lists them.",
    );
  });
});

describe("the price table", () => {
  it("every entry names an https pricing page and the day it was read", () => {
    for (const [model, entry] of Object.entries(PRICE_TABLE)) {
      expect(entry.source, model).toMatch(/^https:\/\//);
      expect(entry.retrieved, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.retrieved <= PRICES_RETRIEVED, model).toBe(true);
      if (!entry.verified) expect(entry.note, model).toMatch(/inferred/);
    }
  });

  it("prices every catalog id the five provider plugins ship", () => {
    for (const plugin of ["zai", "kimi", "deepseek", "minimax", "qwen"]) {
      const source = readFileSync(
        new URL(`../../../../plugins/${plugin}-plugin-cc/src/provider.ts`, import.meta.url),
        "utf8",
      );
      const ids = [...source.matchAll(/\b(?:main|flash): \{ tier: "(?:main|flash)", id: "([^"]+)"/g)].map(
        (m) => m[1],
      );

      expect(ids.length, plugin).toBe(2);
      for (const id of ids) expect(priceOf(id ?? ""), `${plugin}: ${id}`).toBeDefined();
    }
  });

  it("prices tokens per million; an unknown model costs nothing, not a wrong sum", () => {
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };

    expect(costUsdOf("glm-5.3", tokens)).toBeCloseTo(1.4 + 4.4 + 0.26);
    expect(costUsdOf("not-a-model", tokens)).toBe(0);
    expect(priceOf("toString")).toBeUndefined();
  });
});

describe("usage leads with one estimated total", () => {
  const job = aJob({
    id: "261006-cost01",
    state: "accepted",
    attempts: [
      anAttempt({ startedAt: "2026-10-06T10:00:00.000Z", endedAt: "2026-10-06T10:05:00.000Z", usage: USAGE }),
    ],
  });
  const old = aJob({
    id: "261006-cost02",
    state: "accepted",
    attempts: [
      anAttempt({ startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T10:05:00.000Z", usage: USAGE }),
    ],
  });
  const row = {
    model: "glm-5.3",
    requests: 4,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const windows: UsageWindow[] = [
    { label: "Today", days: 1, rows: [row] },
    { label: "Last 7 days", days: 7, rows: [row] },
    { label: "Last 30 days", days: 30, rows: [row] },
  ];

  it("job attempts are priced from the table, never the worker's own figure", () => {
    expect(jobCostUsd(REFERENCE_PROVIDER, job)).toBeCloseTo(1.4 + 0.44);
  });

  it("each window adds the router's requests and the jobs that ended in it", () => {
    const costs = windowCosts(REFERENCE_PROVIDER, windows, [job, old], NOW);

    expect(costs.map((cost) => [cost.label, cost.router, Number(cost.jobs.toFixed(4))])).toEqual([
      ["Today", 1.4, 1.84],
      ["Last 7 days", 1.4, 1.84],
      ["Last 30 days", 1.4, 3.68],
    ]);
  });

  it("the first lines are the totals and what the estimate rests on", () => {
    const text = renderUsage(REFERENCE_PROVIDER, {
      windows,
      jobs: [],
      engines: [],
      allJobs: [job, old],
      now: NOW,
    });

    expect(text.split("\n").slice(0, 3)).toEqual([
      "Z.ai GLM usage",
      "Est. cost: today $3.24 · 7 days $3.24 · 30 days $5.08 (30 days: agents and /model $1.40, jobs $3.68)",
      `Estimated from Z.ai GLM list prices read ${PRICES_RETRIEVED}; your bill is the provider's. Token counts are exact.`,
    ]);
  });
});
