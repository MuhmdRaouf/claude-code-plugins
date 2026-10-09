import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { UsageWindow } from "../../src/app/activity.ts";
import { jobRows } from "../../src/app/activity.ts";
import type { Attempt, Verdict } from "../../src/domain/job.ts";
import { renderHook, renderSummary, renderUsage } from "../../src/render/index.ts";
import { conflictStep, nextStep } from "../../src/render/next.ts";
import {
  costUsdOf,
  estimateText,
  OFFERINGS,
  offeringOfHost,
  PRICE_TABLE,
  PRICES_RETRIEVED,
  type PriceRequest,
  priceOf,
  priceRequest,
} from "../../src/render/prices.ts";
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
      const ids = [
        ...source
          .replace(/\s+/g, " ")

          .matchAll(/\b(?:main|flash): \{ ?tier: "(?:main|flash)", id: "([^"]+)"/g),
      ].map((m) => m[1]);

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

  it("finds a row through case, prefix and suffix, prices cache writes at the 5-minute rate, and estimates in words", () => {
    const million = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };

    expect(priceOf("MiniMax-M3")?.input).toBe(0.3);
    expect(priceOf("minimax-m3")?.input).toBe(0.3);
    expect(priceOf("zai/glm-5.3-flash")?.input).toBe(0.15);
    expect(priceOf("claude-opus-5")).toBeUndefined();
    expect(costUsdOf("kimi-k3", million)).toBeCloseTo(3);
    expect(estimateText("glm-5.3", { ...million, cacheWriteTokens: 0 })).toMatch(/^est\. \$/);
    expect(estimateText("not-a-model", million)).toBe("unpriced");
  });
});

describe("the offering sheets", () => {
  const QUIET = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const aRequest = (over: Partial<PriceRequest> = {}) => ({
    offering: null as PriceRequest["offering"],
    model: "glm-5.3",
    tokens: QUIET,
    ts: Date.parse("2026-10-07T12:00:00.000Z"),
    ...over,
  });

  it("every offering names an https page, the day it was read, and only verified or noted figures", () => {
    for (const offering of OFFERINGS) {
      expect(offering.source, offering.id).toMatch(/^https:\/\//);
      expect(offering.retrieved, offering.id).toBe(PRICES_RETRIEVED);
      expect(offering.host, offering.id).toMatch(/^[a-z.-]+$/);
      for (const [id, sheet] of Object.entries(offering.models)) {
        expect(sheet.verified || /inferred/.test(sheet.note ?? ""), `${offering.id}: ${id}`).toBe(true);
      }
    }
  });

  it("maps each offering's host from a URL or bare host, and no other host", () => {
    expect(offeringOfHost("https://api.anthropic.com/v1/messages")).toBe("anthropic");
    expect(offeringOfHost("api.z.ai")).toBe("zai");
    expect(offeringOfHost("https://api.moonshot.ai/v1")).toBe("moonshot");
    expect(offeringOfHost("https://api.deepseek.com/chat/completions")).toBe("deepseek");
    expect(offeringOfHost("api.minimax.io")).toBe("minimax");
    expect(offeringOfHost("https://dashscope-intl.aliyuncs.com/api/v2/apps")).toBe("qwen");
    expect(offeringOfHost("https://api.openai.com/v1")).toBeNull();
    expect(offeringOfHost("localhost:4173")).toBeNull();
  });

  it("finds the sheet through prefixes, brackets, dates and case; an unknown id gets null", () => {
    expect(priceRequest(aRequest({ model: "zai/glm-5.3[1m]" }))?.detail[0]).toBe("Z.ai list");
    expect(priceRequest(aRequest({ model: "MINIMAX-M3" }))?.detail[0]).toBe("MiniMax list");
    expect(priceRequest(aRequest({ model: "claude-sonnet-5-5-20261008" }))?.detail[0]).toBe("Anthropic list");
    expect(priceRequest(aRequest({ model: "Claude-Opus-5-5@20261008" }))?.detail[0]).toBe("Anthropic list");
    expect(priceRequest(aRequest({ model: "gpt-99" }))).toBeNull();
  });

  it("an id only one offering has prices with no offering given; a wrong offering gets null", () => {
    expect(priceRequest(aRequest({ model: "claude-opus-5-5" }))?.detail).toContain("Anthropic list");
    expect(priceRequest(aRequest({ offering: "deepseek", model: "glm-5.3" }))).toBeNull();
    expect(priceRequest(aRequest({ offering: null, model: "not-a-model" }))).toBeNull();
  });

  it("a tier replaces the base rates only once prompt tokens pass its threshold", () => {
    const at = aRequest({ model: "claude-haiku-5-5", tokens: { ...QUIET, input: 100_000 } });
    const over = aRequest({ model: "claude-haiku-5-5", tokens: { ...QUIET, input: 100_001 } });

    expect(priceRequest(at)?.usd).toBeCloseTo(0.01);
    expect(priceRequest(over)?.usd).toBeCloseTo(0.05);
    expect(priceRequest(over)?.detail).toContain("tier over 100k");
    expect(priceRequest(at)?.detail).not.toContain("tier over 100k");
  });

  it("deepseek bills peak inside its windows and half outside, Friday night and Saturday included", () => {
    const at = (iso: string) =>
      priceRequest(
        aRequest({ model: "deepseek-flash", ts: Date.parse(iso), tokens: { ...QUIET, input: 1_000_000 } }),
      );

    expect(at("2026-10-07T02:00:00Z")?.usd).toBeCloseTo(0.3); // Wednesday, inside 01:00–04:00
    expect(at("2026-10-07T03:59:00Z")?.usd).toBeCloseTo(0.3);
    expect(at("2026-10-07T04:00:00Z")?.usd).toBeCloseTo(0.15); // the window ends at 04:00
    expect(at("2026-10-07T05:00:00Z")?.usd).toBeCloseTo(0.15);
    expect(at("2026-10-07T06:00:00Z")?.usd).toBeCloseTo(0.3); // the second window starts at 06:00
    expect(at("2026-10-07T10:00:00Z")?.usd).toBeCloseTo(0.15);
    expect(at("2026-10-09T06:30:00Z")?.usd).toBeCloseTo(0.3); // Friday morning is still a weekday
    expect(at("2026-10-09T23:00:00Z")?.usd).toBeCloseTo(0.15); // Friday night is not
    expect(at("2026-10-10T07:00:00Z")?.usd).toBeCloseTo(0.15); // Saturday never peaks
    expect(at("2026-10-07T05:00:00Z")?.detail).toContain("off-peak ×0.5");
  });

  it("fast mode prices input/output off the fast row and keeps the cache ratios of fast input", () => {
    const tokens = {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
    };
    const normal = priceRequest(aRequest({ model: "claude-opus-5-5", tokens }));
    const fast = priceRequest(aRequest({ model: "claude-opus-5-5", tokens, speed: "fast" }));

    expect(normal?.usd).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(fast?.usd).toBeCloseTo(8 + 40 + 0.4 + 10 + 16); // read 8 × (0.2/4), writes 1.25× and 2× fast input
    expect(fast?.detail).toContain("fast mode");
    expect(normal?.detail).not.toContain("fast mode");
  });

  it("US geo multiplies Claude 4.6 and later only", () => {
    const geo = aRequest({
      model: "claude-opus-4-8",
      geo: "us",
      tokens: { ...QUIET, input: 1_000_000, output: 1_000_000 },
    });

    expect(priceRequest(geo)?.usd).toBeCloseTo(30 * 1.1);
    expect(priceRequest(geo)?.detail).toContain("US geo ×1.1");
    expect(
      priceRequest(
        aRequest({ model: "claude-opus-4-8", tokens: { ...QUIET, input: 1_000_000, output: 1_000_000 } }),
      )?.usd,
    ).toBeCloseTo(30);
    const oldGeo = aRequest({
      model: "claude-sonnet-4-5",
      geo: "us",
      tokens: { ...QUIET, input: 1_000_000 },
    });
    expect(priceRequest(oldGeo)?.usd).toBeCloseTo(3);
    expect(priceRequest(oldGeo)?.detail).not.toContain("US geo ×1.1");
  });

  it("MiniMax priority is ×1.5 on the tier rates too, and highspeed stays flat", () => {
    const under = aRequest({
      model: "MiniMax-M3",
      serviceTier: "priority",
      tokens: { ...QUIET, input: 200_000, output: 200_000 },
    });
    const over = aRequest({
      model: "MiniMax-M3",
      serviceTier: "priority",
      tokens: { ...QUIET, input: 600_000 },
    });
    const highspeed = aRequest({
      model: "MiniMax-M2.7-highspeed",
      serviceTier: "priority",
      tokens: { ...QUIET, input: 1_000_000 },
    });

    expect(priceRequest(under)?.usd).toBeCloseTo(0.2 * 0.45 + 0.2 * 1.8);
    expect(priceRequest(over)?.usd).toBeCloseTo(0.6 * 0.9);
    expect(priceRequest(over)?.detail).toEqual(["MiniMax list", "tier over 512k", "priority ×1.5"]);
    expect(priceRequest(highspeed)?.usd).toBeCloseTo(0.6);
    expect(priceRequest(highspeed)?.detail).not.toContain("priority ×1.5");
  });

  it("1-hour cache writes bill at the 1-hour rate where listed, else the 5-minute one", () => {
    const k3 = aRequest({ model: "kimi-k3", tokens: { ...QUIET, cacheWrite1h: 1_000_000 } });
    const k3short = aRequest({ model: "kimi-k3", tokens: { ...QUIET, cacheWrite5m: 1_000_000 } });
    const qwen = aRequest({ model: "qwen3.8-max", tokens: { ...QUIET, cacheWrite1h: 1_000_000 } });

    expect(priceRequest(k3)?.usd).toBeCloseTo(6);
    expect(priceRequest(k3)?.detail).toContain("1 h cache writes");
    expect(priceRequest(k3short)?.usd).toBeCloseTo(3);
    expect(priceRequest(k3short)?.detail).not.toContain("1 h cache writes");
    expect(priceRequest(qwen)?.usd).toBeCloseTo(2.5); // qwen lists no 1-hour split; the 5-minute rate stands in
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
