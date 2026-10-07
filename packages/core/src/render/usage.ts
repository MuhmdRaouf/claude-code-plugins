import type { ModelUsage, RouterHealthCounts, UsageWindow } from "../app/activity.ts";
import { USAGE_WINDOWS, windowStart } from "../app/activity.ts";
import type { FlashAdvice } from "../app/advisor.ts";
import type { Job } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import type { EngineUsage, TierUsage } from "../domain/usage.ts";
import { count, duration, modelId, percent, plural, table, usd } from "./format.ts";
import { costUsdOf, PRICES_RETRIEVED, priceOf } from "./prices.ts";

/** What one job attempt cost at the list price of the job's model: the plugin's own estimate, never the worker's (a
 *  `claude -p` worker prices the provider's ids as the Anthropic model they stand in for). */
export function jobCostUsd(provider: Provider, job: Job): number {
  const model = modelId(provider, job);
  return job.attempts.reduce(
    (total, attempt) => total + (attempt.usage === undefined ? 0 : costUsdOf(model, attempt.usage)),
    0,
  );
}

/** One window's estimated cost: the router's requests (agents and `/model`) and the jobs' attempts, apart. */
interface WindowCost {
  readonly label: string;
  readonly router: number;
  readonly jobs: number;
}

/** Whether a job ran on the claude engine (the provider's model through Claude Code), the only kind this table prices. */
function onClaude(job: Job): boolean {
  return job.brief.engine === undefined;
}

/** Each usage window priced: the spool's per-model rows plus every job attempt that ended in the window. Jobs reach
 *  the provider directly, never through the router, so the two never count the same request. */
export function windowCosts(
  provider: Provider,
  windows: readonly UsageWindow[],
  jobs: readonly Job[],
  now: number,
): readonly WindowCost[] {
  // A job on omp, opencode or pi runs on the tool's own setup and model: only the tool's report prices it.
  const priced = jobs.filter(onClaude);
  return USAGE_WINDOWS.map(([label, days]) => {
    const since = windowStart(new Date(now), days);
    const rows = windows.find((window) => window.days === days)?.rows ?? [];
    const jobsCost = priced.reduce((total, job) => {
      const model = modelId(provider, job);
      return (
        total +
        job.attempts.reduce((sum, attempt) => {
          const at = Date.parse(attempt.endedAt ?? attempt.startedAt);
          if (attempt.usage === undefined || !(at >= since)) return sum;
          return sum + costUsdOf(model, attempt.usage);
        }, 0)
      );
    }, 0);
    return { label, router: sum(rows, (row) => costUsdOf(row.model, row)), jobs: jobsCost };
  });
}

/** One usage window's table: a row per model, then the window's total. */
function windowTable(window: UsageWindow): string[] {
  const rows = window.rows;
  const total = {
    requests: sum(rows, (row) => row.requests),
    inputTokens: sum(rows, (row) => row.inputTokens),
    outputTokens: sum(rows, (row) => row.outputTokens),
    cacheReadTokens: sum(rows, (row) => row.cacheReadTokens),
    cacheWriteTokens: sum(rows, (row) => row.cacheWriteTokens),
    costUsd: sum(rows, (row) => costUsdOf(row.model, row)),
  };
  return table([
    ["MODEL", "REQ", "IN", "OUT", "CACHE R", "CACHE W", "EST COST"],
    ...rows.map((row) => modelLine(row)),
    ["TOTAL", ...lineOf(total)],
  ]);
}

interface Line {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

function modelLine(row: ModelUsage): readonly string[] {
  return [row.model, ...lineOf({ ...row, costUsd: costUsdOf(row.model, row) })];
}

function lineOf(line: Line): readonly string[] {
  return [
    String(line.requests),
    count(line.inputTokens),
    count(line.outputTokens),
    count(line.cacheReadTokens),
    count(line.cacheWriteTokens),
    usd(line.costUsd),
  ];
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

/** The headline: one estimated total per window, then where the 30 days went and what the estimate rests on. */
function headline(provider: Provider, costs: readonly WindowCost[], models: readonly string[]): string[] {
  const totals = costs.map((cost) => `${shortLabel(cost.label)} ${usd(cost.router + cost.jobs)}`);
  const month = costs.at(-1);
  const split =
    month === undefined ? "" : ` (30 days: agents and /model ${usd(month.router)}, jobs ${usd(month.jobs)})`;
  const unpriced = models.filter((model) => priceOf(model) === undefined);
  const unverified = models.filter((model) => priceOf(model)?.verified === false);
  return [
    `Est. cost: ${totals.join(" · ")}${split}`,
    `Estimated from ${provider.display} list prices read ${PRICES_RETRIEVED}; your bill is the provider's. Token counts are exact.`,
    ...(unpriced.length === 0 ? [] : [`No list price for ${unpriced.join(", ")}: counted as $0.`]),
    ...(unverified.length === 0 ? [] : [`Cache rates unverified for ${unverified.join(", ")}.`]),
  ];
}

function shortLabel(label: string): string {
  return label.replace(/^Last /, "").toLowerCase();
}

/** The delegation engines' section: one row per engine that ran jobs; nothing at all when none did. Each tool runs on
 *  its own setup, so the row is the tool's own report — the models it named and its numbers — and says so. */
function engineSection(provider: Provider, engines: readonly EngineUsage[]): string[] {
  if (engines.length === 0) return [];
  return [
    "",
    `${provider.name} engines (as each tool reports them; the tools run on their own setup)`,
    ...table([
      ["ENGINE", "MODEL", "JOBS", "ACCEPTED", "REQ", "IN", "OUT", "CACHE R", "CACHE W", "COST"],
      ...engines.map((row) => [
        row.engine,
        row.models.length === 0 ? "-" : row.models.join(", "),
        String(row.jobs),
        String(row.accepted),
        ...lineOf(row),
      ]),
    ]),
  ];
}

/** The job ledger: how jobs went, per model. Their cost is in the headline. */
function jobSection(provider: Provider, jobs: readonly TierUsage[]): string[] {
  if (jobs.length === 0) return [`No ${provider.name} jobs in this repository yet.`];
  return [
    `${provider.name} jobs in this repository`,
    ...table([
      ["MODEL", "JOBS", "ACCEPTED", "DISCARDED", "1ST-TRY", "RETURNS", "IN", "OUT", "429S", "TIME"],
      ...jobs.map((row) => [
        provider.catalog[row.tier].id,
        String(row.jobs),
        String(row.accepted),
        String(row.discarded),
        percent(row.firstTryPassRate),
        String(row.reviewReturns),
        count(row.inputTokens),
        count(row.outputTokens),
        String(row.rateLimitRetries),
        duration(row.durationMs),
      ]),
    ]),
  ];
}

/** The router's last 24 hours in one line: what went other than plainly, counted. */
function healthSection(health: RouterHealthCounts | undefined): string[] {
  if (health === undefined) return [];
  const parts = [
    plural(health.fallback, "fallback"),
    plural(health.refusal, "refusal"),
    plural(health.rate_limited, "rate limit"),
    plural(health.restart, "restart"),
    ...(health.budget_stop === 0 ? [] : [plural(health.budget_stop, "budget stop")]),
  ];
  const quiet = Object.values(health).every((n) => n === 0);
  return [
    "",
    quiet
      ? "Router health, last 24 h: no fallbacks, refusals, rate limits or restarts."
      : `Router health, last 24 h: ${parts.join(" · ")}`,
  ];
}

/** The advisor speaks only with this much to go on: main-model runs looked at, light ones among them, and a saving. */
export const ADVISOR_MIN_RUNS = 10;
export const ADVISOR_MIN_LIGHT = 3;
const ADVISOR_MIN_SAVING_USD = 0.01;

/** What the light runs would have saved on the flash model at list prices; undefined when either model is unpriced. */
export function advisorSaving(advice: FlashAdvice): number | undefined {
  if (priceOf(advice.mainModel) === undefined || priceOf(advice.flashModel) === undefined) return undefined;
  return costUsdOf(advice.mainModel, advice.tokens) - costUsdOf(advice.flashModel, advice.tokens);
}

/** Whether the advisor has enough to say anything: enough runs, enough light ones, a priced saving worth a cent. */
export function adviceWorthShowing(advice: FlashAdvice | undefined): advice is FlashAdvice {
  if (advice === undefined) return false;
  const light = advice.lightJobs + advice.lightAgents;
  const saving = advisorSaving(advice);
  return (
    advice.runs >= ADVISOR_MIN_RUNS &&
    light >= ADVISOR_MIN_LIGHT &&
    saving !== undefined &&
    saving >= ADVISOR_MIN_SAVING_USD
  );
}

/** The model advisor, cautiously worded and only with enough data; it suggests, it never changes anything. */
function adviceSection(provider: Provider, advice: FlashAdvice | undefined): string[] {
  if (!adviceWorthShowing(advice)) return [];
  const light = advice.lightJobs + advice.lightAgents;
  return [
    "",
    "Model advisor (an estimate; nothing was changed)",
    `${light} of ${advice.runs} ${advice.mainModel} runs in the last 30 days looked light: read-only or sweep jobs, or few turns and short answers.`,
    `On ${advice.flashModel} they could have cost about ${usd(advisorSaving(advice) ?? 0)} less at list prices, if the flash model handles them as well.`,
    `For work like that, try \`model: ${provider.tierNames.flash}\` in a brief or the ${provider.agentPrefix}${provider.agents.flash} agent.`,
  ];
}

/** What `usage` prints: the estimated totals first, then the router's health and per-model windows (agents and
 *  `/model`), then the job ledger, then the engines', then the model advisor when it has something to say. */
export interface UsageReport {
  readonly windows: readonly UsageWindow[];
  /** This repository's claude-engine ledger, per tier. */
  readonly jobs: readonly TierUsage[];
  readonly engines: readonly EngineUsage[];
  /** Every job on this machine, for the priced totals. */
  readonly allJobs: readonly Job[];
  readonly now: number;
  /** The router's last 24 hours; absent, no health line. */
  readonly health?: RouterHealthCounts;
  /** The model advisor's findings; shown only when there is enough data. */
  readonly advice?: FlashAdvice;
}

export function usage(provider: Provider, report: UsageReport): string {
  const costs = windowCosts(provider, report.windows, report.allJobs, report.now);
  const models = [
    ...new Set([
      ...report.windows.flatMap((window) => window.rows.map((row) => row.model)),
      ...report.allJobs.filter(onClaude).map((job) => modelId(provider, job)),
    ]),
  ];
  const spool = report.windows.map((window) =>
    window.rows.length === 0
      ? `${window.label}: no agent or /model requests.`
      : [`${window.label}, agents and /model`, ...windowTable(window)].join("\n"),
  );
  return [
    `${provider.display} usage`,
    ...headline(provider, costs, models),
    ...(report.engines.length === 0
      ? []
      : [
          "Jobs on omp, opencode or pi are not in the total: their rows below are as each tool reports them.",
        ]),
    ...healthSection(report.health),
    "",
    ...spool,
    "",
    ...jobSection(provider, report.jobs),
    ...engineSection(provider, report.engines),
    ...adviceSection(provider, report.advice),
  ].join("\n");
}
