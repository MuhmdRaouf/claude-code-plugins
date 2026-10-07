import { ENGINE_TOOLS, type EngineTool } from "./engine.ts";
import type { Job } from "./job.ts";
import type { ModelTier } from "./model.ts";

/**
 * The per-tier quality ledger the orchestrator reports. Per model tier, over decided jobs (accepted|discarded) unless noted:
 * - jobs: all jobs; decided; accepted; discarded
 * - firstTryPassRate: share of decided jobs whose FIRST attempt verdict was pass
 * - acceptRate: accepted / decided
 * - meanAttemptsToAccept: mean attempts over accepted jobs
 * - reviewReturns: total review_fix attempts
 * - tokens/cost/rateLimitRetries/durationMs: sums over all attempts of all jobs
 * Rates are null when the denominator is 0.
 */
export interface TierUsage {
  readonly tier: ModelTier;
  readonly jobs: number;
  readonly decided: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly firstTryPassRate: number | null;
  readonly acceptRate: number | null;
  readonly meanAttemptsToAccept: number | null;
  readonly reviewReturns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly rateLimitRetries: number;
  readonly durationMs: number;
}

const TIER_ORDER: readonly ModelTier[] = ["main", "flash"];

export function summarizeUsage(jobs: readonly Job[]): readonly TierUsage[] {
  return TIER_ORDER.flatMap((tier) => {
    const tierJobs = jobs.filter((job) => job.brief.model === tier);
    return tierJobs.length === 0 ? [] : [tierUsage(tier, tierJobs)];
  });
}

function tierUsage(tier: ModelTier, jobs: readonly Job[]): TierUsage {
  const accepted = jobs.filter((job) => job.state === "accepted");
  const discarded = jobs.filter((job) => job.state === "discarded");
  const decided = [...accepted, ...discarded];
  const passedFirstTry = decided.filter((job) => job.attempts[0]?.verdict === "pass");
  const attempts = jobs.flatMap((job) => job.attempts);
  const usages = attempts.flatMap((attempt) => (attempt.usage === undefined ? [] : [attempt.usage]));
  return {
    tier,
    jobs: jobs.length,
    decided: decided.length,
    accepted: accepted.length,
    discarded: discarded.length,
    firstTryPassRate: ratio(passedFirstTry.length, decided.length),
    acceptRate: ratio(accepted.length, decided.length),
    meanAttemptsToAccept: ratio(
      sum(accepted, (job) => job.attempts.length),
      accepted.length,
    ),
    reviewReturns: attempts.filter((attempt) => attempt.kind === "review_fix").length,
    inputTokens: sum(usages, (usage) => usage.inputTokens),
    outputTokens: sum(usages, (usage) => usage.outputTokens),
    cacheReadTokens: sum(usages, (usage) => usage.cacheReadTokens),
    costUsd: sum(usages, (usage) => usage.costUsd),
    rateLimitRetries: sum(usages, (usage) => usage.rateLimitRetries),
    durationMs: sum(usages, (usage) => usage.durationMs),
  };
}

/** One delegation engine's share of the job loop, as the tool itself reported it per attempt (requests are model
 *  turns): the tool runs on its own setup, so these are its numbers and the models it named, not the provider's bill. */
export interface EngineUsage {
  readonly engine: EngineTool;
  /** The models the tool said it ran on, in its own naming, sorted; empty when it named none. */
  readonly models: readonly string[];
  readonly jobs: number;
  readonly accepted: number;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

/** Per engine (omp, opencode, pi, in that order), over its jobs; an engine without jobs has no row. */
export function summarizeEngines(jobs: readonly Job[]): readonly EngineUsage[] {
  return ENGINE_TOOLS.flatMap((engine) => {
    const engineJobs = jobs.filter((job) => job.brief.engine === engine);
    if (engineJobs.length === 0) return [];
    const usages = engineJobs.flatMap((job) =>
      job.attempts.flatMap((attempt) => (attempt.usage === undefined ? [] : [attempt.usage])),
    );
    return [
      {
        engine,
        models: [
          ...new Set(usages.flatMap((usage) => (usage.model === undefined ? [] : [usage.model]))),
        ].sort(),
        jobs: engineJobs.length,
        accepted: engineJobs.filter((job) => job.state === "accepted").length,
        requests: sum(usages, (usage) => usage.turns),
        inputTokens: sum(usages, (usage) => usage.inputTokens),
        outputTokens: sum(usages, (usage) => usage.outputTokens),
        cacheReadTokens: sum(usages, (usage) => usage.cacheReadTokens),
        cacheWriteTokens: sum(usages, (usage) => usage.cacheWriteTokens),
        costUsd: sum(usages, (usage) => usage.costUsd),
      },
    ];
  });
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}
