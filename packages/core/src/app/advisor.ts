// The model advisor: which of the plugin's own main-model runs over the last 30 days looked small enough for the
// flash model. A run is a claude-engine job or a subagent the router served; it looks light when it was read-only or
// a sweep (a job not in edit mode), or when it took few turns and wrote little. This only reads the records the
// plugin already keeps; `/<p>:usage` prices the light runs on both models and words the result as an estimate. It
// never changes a brief, an agent or a setting.
import type { Job } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import type { SpoolEvent } from "../domain/route-events.ts";
import { routesOf, tokenCount, windowStart } from "./activity.ts";
import type { Deps } from "./deps.ts";

/** A run this short (model turns, or requests for a subagent) and this quiet (output tokens) looks flash-sized. */
export const LIGHT_TURNS = 10;
export const LIGHT_OUTPUT_TOKENS = 4000;

/** Tokens summed over runs, in the price table's shape. */
export interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** What the advisor found: how many main-model runs it looked at, how many looked light, and their tokens. */
export interface FlashAdvice {
  readonly mainModel: string;
  readonly flashModel: string;
  /** Main-model runs in the window. */
  readonly runs: number;
  /** Those that looked light: jobs and subagents apart. */
  readonly lightJobs: number;
  readonly lightAgents: number;
  /** The light runs' tokens, to price on both models. */
  readonly tokens: TokenTotals;
}

interface Run {
  readonly light: boolean;
  readonly source: "job" | "agent";
  readonly tokens: TokenTotals;
}

const ZERO: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function add(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Main-model jobs on the claude engine with an attempt ended since `since`, as runs. */
function jobRuns(jobs: readonly Job[], since: number): Run[] {
  return jobs.flatMap((job) => {
    if (job.brief.engine !== undefined || job.brief.model !== "main") return [];
    const usages = job.attempts.flatMap((attempt) =>
      attempt.usage !== undefined && Date.parse(attempt.endedAt ?? attempt.startedAt) >= since
        ? [attempt.usage]
        : [],
    );
    if (usages.length === 0) return [];
    const tokens = usages.reduce<TokenTotals>((total, usage) => add(total, usage), ZERO);
    const turns = usages.reduce((total, usage) => total + usage.turns, 0);
    const light =
      job.brief.mode !== "edit" || (turns <= LIGHT_TURNS && tokens.outputTokens <= LIGHT_OUTPUT_TOKENS);
    return [{ light, source: "job" as const, tokens }];
  });
}

/** Subagents the router sent to the main model since `since`, one run per agent id. A main session is the user's own
 *  `/model` choice and is left alone. */
function agentRuns(plugin: string, model: string, events: readonly SpoolEvent[], since: number): Run[] {
  const agents = new Map<string, { requests: number; tokens: TokenTotals }>();
  for (const event of routesOf(plugin, events)) {
    if (event.route !== "provider" || event.model !== model || event.agent_id === undefined) continue;
    if (!(Date.parse(event.ts) >= since)) continue;
    const seen = agents.get(event.agent_id) ?? { requests: 0, tokens: ZERO };
    agents.set(event.agent_id, {
      requests: seen.requests + 1,
      tokens: add(seen.tokens, {
        inputTokens: tokenCount(event.usage, "input_tokens"),
        outputTokens: tokenCount(event.usage, "output_tokens"),
        cacheReadTokens: tokenCount(event.usage, "cache_read_input_tokens"),
        cacheWriteTokens: tokenCount(event.usage, "cache_creation_input_tokens"),
      }),
    });
  }
  return [...agents.values()].map(({ requests, tokens }) => ({
    light: requests <= LIGHT_TURNS && tokens.outputTokens <= LIGHT_OUTPUT_TOKENS,
    source: "agent" as const,
    tokens,
  }));
}

/** The advisor's findings over the plugin's jobs and its router's spool since `since` (epoch ms). */
export function flashAdvice(
  provider: Provider,
  jobs: readonly Job[],
  events: readonly SpoolEvent[],
  since: number,
): FlashAdvice {
  const mainModel = provider.catalog.main.id;
  const runs = [...jobRuns(jobs, since), ...agentRuns(provider.name, mainModel, events, since)];
  const light = runs.filter((run) => run.light);
  return {
    mainModel,
    flashModel: provider.catalog.flash.id,
    runs: runs.length,
    lightJobs: light.filter((run) => run.source === "job").length,
    lightAgents: light.filter((run) => run.source === "agent").length,
    tokens: light.reduce<TokenTotals>((total, run) => add(total, run.tokens), ZERO),
  };
}

/** The window the advisor looks at: the last 30 calendar days, like the usage report's longest window. */
const ADVISOR_DAYS = 30;

/** The advisor over every job on this machine and the spool events `usage` already read. */
export function modelAdvice(deps: Deps, jobs: readonly Job[], events: readonly SpoolEvent[]): FlashAdvice {
  const now = new Date(deps.clock.now());
  return flashAdvice(deps.provider, jobs, events, windowStart(now, ADVISOR_DAYS));
}
