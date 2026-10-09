// The usage report's two newer parts: the router's last 24 hours of health events, and the model advisor that points
// out main-model runs that looked flash-sized, with a cautious estimate of what the flash model would have saved.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { healthCounts, routerHealth } from "../../src/app/activity.ts";
import { type FlashAdvice, flashAdvice, LIGHT_OUTPUT_TOKENS, modelAdvice } from "../../src/app/advisor.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { runCli } from "../../src/cli/run.ts";
import type { Usage } from "../../src/domain/job.ts";
import { healthEvent, type RouteEvent, type SpoolEvent } from "../../src/domain/route-events.ts";
import { renderUsage } from "../../src/render/index.ts";
import { adviceWorthShowing, advisorSaving } from "../../src/render/usage.ts";
import { radarHome } from "../../src/router/spool.ts";
import { aBrief, aJob, anAttempt } from "../support/builders.ts";
import { fakeDeps } from "../support/fakes.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { tempDir } from "../support/tmp.ts";

const NOON = new Date(2026, 9, 7, 12, 0, 0);
const HOUR = 60 * 60_000;
const at = (dayOffset: number, hour: number): string => new Date(2026, 9, 7 + dayOffset, hour).toISOString();

function route(fields: Partial<RouteEvent> & { readonly ts: string }): RouteEvent {
  return {
    event: "route",
    plugin: "zai",
    model: "glm-5.3",
    upstream: "api.z.ai",
    route: "provider",
    status: 200,
    latency_ms: 40,
    ...fields,
  };
}

function usage(fields: Partial<Usage>): Usage {
  return {
    turns: 3,
    inputTokens: 100_000,
    outputTokens: 1000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    rateLimitRetries: 0,
    durationMs: 1000,
    ...fields,
  };
}

/** A main-model job on the claude engine with one attempt yesterday. */
function job(id: string, fields: Partial<Usage>, brief: Partial<ReturnType<typeof aBrief>> = {}) {
  return aJob({
    id,
    brief: aBrief({ model: "main", ...brief }),
    attempts: [anAttempt({ startedAt: at(-1, 9), endedAt: at(-1, 10), usage: usage(fields) })],
  });
}

describe("router health over the last 24 hours", () => {
  it("counts this plugin's health events per kind, newer than the window only", () => {
    const now = NOON.getTime();
    const events: SpoolEvent[] = [
      healthEvent("zai", "fallback", "no worker was ready", "glm-5.3", now - HOUR),
      healthEvent("zai", "fallback", "no worker was ready", "", now - 2 * HOUR),
      healthEvent("zai", "refusal", "key: HTTP 401", "glm-5.3", now - 3 * HOUR),
      healthEvent("zai", "rate_limited", "HTTP 429", "glm-5.3", now - 25 * HOUR),
      healthEvent("kimi", "restart", "worker exited (SIGKILL)", "", now - HOUR),
      healthEvent("zai", "budget_stop", "total budget reached for this day", "glm-5.3", now),
      route({ ts: at(0, 11) }),
    ];
    expect(healthCounts("zai", events, now - 24 * HOUR)).toEqual({
      fallback: 2,
      refusal: 1,
      rate_limited: 0,
      budget_stop: 1,
      restart: 0,
    });
  });

  it("reads them from the spool on disk, today's and yesterday's file", () => {
    const fakes = fakeDeps([], { RADAR_HOME: join(tempDir("core-health-"), "radar") });
    fakes.clock.current = NOON.getTime();
    const spool = join(radarHome(fakes.deps.env), "spool");
    mkdirSync(spool, { recursive: true });
    const line = (event: SpoolEvent): string => `${JSON.stringify(event)}\n`;
    writeFileSync(
      join(spool, "2026-10-07.jsonl"),
      line(healthEvent("zai", "restart", "x", "", NOON.getTime())),
    );
    writeFileSync(
      join(spool, "2026-10-06.jsonl"),
      line(healthEvent("zai", "rate_limited", "HTTP 429", "glm-5.3", NOON.getTime() - 20 * HOUR)),
    );
    expect(routerHealth(fakes.deps)).toEqual({
      fallback: 0,
      refusal: 0,
      rate_limited: 1,
      budget_stop: 0,
      restart: 1,
    });
  });
});

describe("the model advisor", () => {
  const since = new Date(2026, 8, 8).getTime();

  it("calls a main-model job light when it was read-only or a sweep, or took few turns and wrote little", () => {
    const jobs = [
      job("sweep", { turns: 40, outputTokens: 50_000 }, { mode: "exec" }),
      job("read", { turns: 40, outputTokens: 50_000 }, { mode: "readonly" }),
      job("small", { turns: 4, outputTokens: 2000 }),
      job("big", { turns: 30, outputTokens: 2000 }),
      job("wordy", { turns: 4, outputTokens: LIGHT_OUTPUT_TOKENS + 1 }),
      job("flash", { turns: 2 }, { model: "flash" }),
      job("omp", { turns: 2 }, { engine: "omp" }),
      aJob({ id: "unrun", brief: aBrief({ model: "main" }) }),
      aJob({
        id: "old",
        brief: aBrief({ model: "main", mode: "exec" }),
        attempts: [anAttempt({ startedAt: at(-40, 9), endedAt: at(-40, 10), usage: usage({}) })],
      }),
    ];
    const advice = flashAdvice(REFERENCE_PROVIDER, jobs, [], since);
    expect(advice).toMatchObject({
      mainModel: "glm-5.3",
      flashModel: "glm-5.3-flash",
      runs: 5,
      lightJobs: 3,
      lightAgents: 0,
    });
    expect(advice.tokens).toEqual({
      inputTokens: 300_000,
      outputTokens: 102_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("counts each subagent the router sent to the main model as one run; main sessions and other models are not runs", () => {
    const tokens = { input_tokens: 10_000, output_tokens: 100, cache_read_input_tokens: 50 };
    const events: SpoolEvent[] = [
      ...Array.from({ length: 3 }, () => route({ ts: at(-1, 9), agent_id: "quick", usage: tokens })),
      ...Array.from({ length: 12 }, () => route({ ts: at(-1, 9), agent_id: "long", usage: tokens })),
      route({ ts: at(-1, 9), session_id: "main-session", usage: tokens }),
      route({ ts: at(-1, 9), agent_id: "flashy", model: "glm-5.3-flash", usage: tokens }),
      route({ ts: at(-1, 9), agent_id: "claude", model: "claude-sonnet-5-5", route: "anthropic" }),
      route({ ts: at(-1, 9), agent_id: "other", plugin: "kimi" }),
      route({ ts: at(-45, 9), agent_id: "ancient", usage: tokens }),
    ];
    const advice = flashAdvice(REFERENCE_PROVIDER, [], events, since);
    expect(advice).toMatchObject({ runs: 2, lightJobs: 0, lightAgents: 1 });
    expect(advice.tokens).toEqual({
      inputTokens: 30_000,
      outputTokens: 300,
      cacheReadTokens: 150,
      cacheWriteTokens: 0,
    });
  });

  it("speaks only with enough runs, enough light ones and a priced saving; it prices both models at list price", () => {
    const base: FlashAdvice = {
      mainModel: "glm-5.3",
      flashModel: "glm-5.3-flash",
      runs: 10,
      lightJobs: 2,
      lightAgents: 1,
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    expect(advisorSaving(base)).toBeCloseTo(1.4 - 0.15);
    expect(adviceWorthShowing(base)).toBe(true);
    expect(adviceWorthShowing(undefined)).toBe(false);
    expect(adviceWorthShowing({ ...base, runs: 9 })).toBe(false);
    expect(adviceWorthShowing({ ...base, lightJobs: 1 })).toBe(false);
    expect(adviceWorthShowing({ ...base, tokens: { ...base.tokens, inputTokens: 1000 } })).toBe(false);
    expect(advisorSaving({ ...base, mainModel: "custom-model" })).toBeUndefined();
    expect(adviceWorthShowing({ ...base, flashModel: "custom-flash" })).toBe(false);
  });

  it("prints the health line and, with enough data, the advisor's cautious estimate; never a change", () => {
    const fakes = fakeDeps();
    fakes.clock.current = NOON.getTime();
    const jobs = Array.from({ length: 10 }, (_, i) =>
      job(`j${i}`, { turns: 3, inputTokens: 1_000_000, outputTokens: 1000 }, { mode: "readonly" }),
    );
    const advice = modelAdvice(fakes.deps, jobs, []);
    const text = (health: Parameters<typeof renderUsage>[1]["health"], withAdvice = advice) =>
      renderUsage(REFERENCE_PROVIDER, {
        windows: [],
        jobs: [],
        engines: [],
        allJobs: [],
        now: NOON.getTime(),
        ...(health === undefined ? {} : { health }),
        advice: withAdvice,
      });
    const quiet = { fallback: 0, refusal: 0, rate_limited: 0, budget_stop: 0, restart: 0 };
    expect(text(quiet)).toContain(
      "Router health, last 24 h: no fallbacks, refusals, rate limits or restarts.",
    );
    expect(text({ ...quiet, fallback: 1, refusal: 2, rate_limited: 3 })).toContain(
      "Router health, last 24 h: 1 fallback · 2 refusals · 3 rate limits · 0 restarts",
    );
    expect(text({ ...quiet, restart: 1, budget_stop: 2 })).toContain(
      "Router health, last 24 h: 0 fallbacks · 0 refusals · 0 rate limits · 1 restart · 2 budget stops",
    );
    expect(text(undefined)).not.toContain("Router health");
    expect(text(undefined).split("\n").slice(-4)).toEqual([
      "Model advisor (an estimate; nothing was changed)",
      "10 of 10 glm-5.3 runs in the last 30 days looked light: read-only or sweep jobs, or few turns and short answers.",
      "On glm-5.3-flash they could have cost about $12.54 less at list prices, if the flash model handles them as well.",
      "For work like that, try `model: flash` in a brief or the zai:glm-5.3-flash agent.",
    ]);
    expect(text(undefined, { ...advice, runs: 3 })).not.toContain("Model advisor");
  });

  it("usage --json carries the health counts always and the advisor only when it speaks", async () => {
    const fakes = fakeDeps();
    fakes.clock.current = NOON.getTime();
    expect(await runCli(["usage", "--json"], fakes.deps, "/repo")).toBe(EXIT.ok);
    const quiet = JSON.parse(fakes.out.lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(quiet.routerHealth).toEqual({
      fallback: 0,
      refusal: 0,
      rate_limited: 0,
      budget_stop: 0,
      restart: 0,
    });
    expect(quiet.advisor).toBeUndefined();
    for (let i = 0; i < 10; i++)
      fakes.store.put(job(`j${i}`, { inputTokens: 1_000_000, outputTokens: 1000 }, { mode: "readonly" }));
    expect(await runCli(["usage", "--json"], fakes.deps, "/repo")).toBe(EXIT.ok);
    const advised = JSON.parse(fakes.out.lines.at(-1) ?? "{}") as { advisor?: { estSavingUsd: number } };
    expect(advised.advisor).toMatchObject({ runs: 10, lightJobs: 10, lightAgents: 0 });
    expect(advised.advisor?.estSavingUsd).toBeCloseTo(12.539);
    expect(await runCli(["usage"], fakes.deps, "/repo")).toBe(EXIT.ok);
    expect(fakes.out.text).toContain("Model advisor (an estimate; nothing was changed)");
    expect(fakes.out.text).toContain("Router health, last 24 h:");
  });
});
