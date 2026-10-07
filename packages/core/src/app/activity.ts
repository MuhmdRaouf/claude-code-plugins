// The live board and the spool usage windows: what ran through this plugin's router, read back from the spool it
// wrote. One row per subagent and per main session the router served, beside the job store's
// jobs; usage sums the provider-bound requests per model over calendar windows. Jobs on a delegation engine (omp,
// opencode, pi) join the board through their own source, KIND the engine and the engine's pid while it runs.
import type { EngineTool } from "../domain/engine.ts";
import type { Job, JobState } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import {
  isHealthEvent,
  type RouteEvent,
  type RouterHealth,
  type RouteUsage,
  type SpoolEvent,
} from "../domain/route-events.ts";
import type { Deps } from "./deps.ts";
import { jobEngine } from "./engine-select.ts";
import { board } from "./queries.ts";

/** A request this recent marks its session or subagent active. */
const ACTIVE_WINDOW_MS = 60_000;

/** The board reads today's and yesterday's spool; usage reads thirty days. */
const BOARD_SPOOL_DAYS = 2;
const USAGE_SPOOL_DAYS = 30;

/** The windows `usage` reports: today, then the last 7 and 30 calendar days (today included). */
export const USAGE_WINDOWS: readonly (readonly [label: string, days: number])[] = [
  ["Today", 1],
  ["Last 7 days", 7],
  ["Last 30 days", 30],
];

/** One row of the live board: a subagent or a main session this plugin's router served, or a job from the store —
 *  `job` on claude, the engine's name on a delegation engine. */
export interface ActivityRow {
  readonly kind: "subagent" | "session" | "job" | EngineTool;
  /** First 8 characters of the agent or session id; the job id in full. */
  readonly id: string;
  readonly model?: string;
  /** "active" or "idle" for spool rows; the job state for job rows. */
  readonly state: string;
  /** A job row's last verdict: the board's review state label shows it. */
  readonly verdict?: string;
  /** A job mid-flight whose driver is gone. */
  readonly stale?: boolean;
  readonly requests?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** When the row was last active: its last request, or the job's last update. */
  readonly at: string;
  readonly title?: string;
  /** An engine job's running engine process (its group leader), while the driver is live. */
  readonly pid?: number;
}

/** Where board rows come from: the spool, the job store's claude jobs, and its jobs on delegation engines. */
interface BoardSource {
  rows(now: number): Promise<readonly ActivityRow[]>;
}

type Scope = { readonly repoRoot?: string; readonly all: boolean };

/** The spool's route events for one plugin only; every plugin's router shares the same files. */
export function routesOf(plugin: string, events: readonly SpoolEvent[]): RouteEvent[] {
  return events.filter(
    (event): event is RouteEvent =>
      !isHealthEvent(event) && event.event === "route" && event.plugin === plugin,
  );
}

/** The id a row is grouped under: the agent for a subagent's requests, the session for a main session's. */
function rowKey(event: RouteEvent): string | undefined {
  return event.agent_id ?? event.session_id;
}

interface Tally {
  last: RouteEvent;
  requests: number;
  input: number;
  output: number;
}

/** The subagent and session rows of the given route events. A request only reaches the spool once it completes, so
 *  "active" means one answered within the active window — one still streaming shows as soon as it lands. */
export function spoolRows(plugin: string, events: readonly SpoolEvent[], now: number): ActivityRow[] {
  const groups = new Map<string, Tally>();
  for (const event of routesOf(plugin, events)) {
    const key = rowKey(event);
    if (key === undefined) continue;
    const tokens = usageTokens(event.usage);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { last: event, requests: 1, input: tokens.input, output: tokens.output });
      continue;
    }
    group.requests += 1;
    group.input += tokens.input;
    group.output += tokens.output;
    if (Date.parse(event.ts) > Date.parse(group.last.ts)) group.last = event;
  }
  return [...groups.entries()].map(([key, group]) => ({
    kind: group.last.agent_id === undefined ? "session" : "subagent",
    id: key.slice(0, 8),
    model: group.last.model,
    state: now - Date.parse(group.last.ts) <= ACTIVE_WINDOW_MS ? "active" : "idle",
    requests: group.requests,
    inputTokens: group.input,
    outputTokens: group.output,
    at: group.last.ts,
  }));
}

/** The input and output tokens of one answer's usage, as numbers whatever the provider reports. */
function usageTokens(usage: RouteUsage | undefined): { input: number; output: number } {
  return { input: tokenCount(usage, "input_tokens"), output: tokenCount(usage, "output_tokens") };
}

/** A usage counter by its Anthropic name; anything but a number (or a numeric string) counts as nothing. */
export function tokenCount(usage: RouteUsage | undefined, key: string): number {
  const value = usage?.[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A board row's job and whether its driver is live, as `board()` reports them. */
type JobInView = { readonly job: Job; readonly live: boolean };

/** The job store's jobs as board rows: the model id it ran on and its verdict. */
export function jobRows(provider: Provider, jobs: readonly JobInView[]): ActivityRow[] {
  return jobs.map(({ job, live }) => ({
    kind: "job" as const,
    id: job.id,
    model: provider.catalog[job.brief.model].id,
    state: job.state,
    verdict: job.attempts.at(-1)?.verdict ?? "no verdict",
    stale: (job.state === "running" || job.state === "verifying") && !live,
    at: job.updatedAt,
    title: job.brief.title,
    ...jobTokens(job),
  }));
}

/** A job's model turns and tokens over its finished attempts, for the board's REQ, IN and OUT columns; none before
 *  the first attempt ends. */
function jobTokens(job: Job): Pick<ActivityRow, "requests" | "inputTokens" | "outputTokens"> {
  const usages = job.attempts.flatMap((attempt) => (attempt.usage === undefined ? [] : [attempt.usage]));
  if (usages.length === 0) return {};
  const sum = (value: (usage: (typeof usages)[number]) => number) =>
    usages.reduce((total, usage) => total + value(usage), 0);
  return {
    requests: sum((usage) => usage.turns),
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
  };
}

/** The board's order: active rows first, then newest first by when each row was last active. */
export function orderRows(rows: readonly ActivityRow[]): ActivityRow[] {
  return [...rows].sort(
    (a, b) => Number(isActive(b)) - Number(isActive(a)) || Date.parse(b.at) - Date.parse(a.at),
  );
}

const ACTIVE_JOBS: ReadonlySet<JobState> = new Set<JobState>(["queued", "running", "verifying"]);

function isActive(row: ActivityRow): boolean {
  return row.kind === "subagent" || row.kind === "session"
    ? row.state === "active"
    : ACTIVE_JOBS.has(row.state as JobState);
}

/** The spool source: subagents and sessions this plugin's router served today or yesterday. */
function spoolSource(deps: Deps): BoardSource {
  return {
    rows: (now) =>
      Promise.resolve(spoolRows(deps.provider.name, deps.spool.events(new Date(now), BOARD_SPOOL_DAYS), now)),
  };
}

function scopedJobs(deps: Deps, scope: Scope): Promise<readonly JobInView[]> {
  return board(deps, {
    ...(scope.repoRoot === undefined ? {} : { repoRoot: scope.repoRoot }),
    all: scope.all,
  });
}

/** The job store source: the verified loop's claude jobs, repo-filtered unless the scope says all. */
function jobSource(deps: Deps, scope: Scope): BoardSource {
  return {
    rows: async () =>
      jobRows(
        deps.provider,
        (await scopedJobs(deps, scope)).filter(({ job }) => jobEngine(job) === "claude"),
      ),
  };
}

/** The engine source: jobs on omp, opencode or pi, KIND the engine, with the engine's pid while one runs. Stopping
 *  one is stopping its job, the same as any other. */
function engineSource(deps: Deps, scope: Scope): BoardSource {
  return {
    rows: async () =>
      engineRows(
        deps,
        (await scopedJobs(deps, scope)).filter(({ job }) => jobEngine(job) !== "claude"),
      ),
  };
}

/**
 * Engine jobs as board rows: a job row with the engine as KIND and its live engine process. The tool runs on its own
 * setup, so the model and the numbers are the tool's own report: the model it last said it ran on (none when it names
 * none, never the provider's catalog), and its requests and tokens summed over the attempts.
 */
function engineRows(deps: Deps, jobs: readonly JobInView[]): ActivityRow[] {
  return jobs.flatMap((view) => {
    const engine = jobEngine(view.job);
    if (engine === "claude") return [];
    const [row] = jobRows(deps.provider, [view]);
    if (row === undefined) return [];
    const pid = view.live ? deps.files.enginePid(deps.store.paths(view.job.id)) : undefined;
    const usages = view.job.attempts.flatMap((attempt) =>
      attempt.usage === undefined ? [] : [attempt.usage],
    );
    const { model: _catalog, ...rest } = row;
    const model = usages.findLast((usage) => usage.model !== undefined)?.model;
    return [
      {
        ...rest,
        kind: engine,
        ...(model === undefined ? {} : { model }),
        ...(usages.length === 0
          ? {}
          : {
              requests: usages.reduce((total, usage) => total + usage.turns, 0),
              inputTokens: usages.reduce((total, usage) => total + usage.inputTokens, 0),
              outputTokens: usages.reduce((total, usage) => total + usage.outputTokens, 0),
            }),
        ...(pid === undefined ? {} : { pid }),
      },
    ];
  });
}

/** The whole board, every source merged: active first, then newest first. */
export async function activityBoard(deps: Deps, scope: Scope): Promise<readonly ActivityRow[]> {
  const now = deps.clock.now();
  const sources: readonly BoardSource[] = [
    spoolSource(deps),
    jobSource(deps, scope),
    engineSource(deps, scope),
  ];
  const rows = (await Promise.all(sources.map((source) => source.rows(now)))).flat();
  return orderRows(rows);
}

// ── usage windows ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Per-model totals over one usage window: the provider-bound requests this plugin's router forwarded. */
export interface ModelUsage {
  readonly model: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** One named window and its per-model rows. */
export interface UsageWindow {
  readonly label: string;
  readonly days: number;
  readonly rows: readonly ModelUsage[];
}

/** Local midnight of `days` calendar days back, today included: the window's inclusive start. */
export function windowStart(now: Date, days: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
}

/** Per-model usage over the provider-bound route events since `since`: the provider's own bill. Anthropic-routed and
 *  peer-routed requests are someone else's and never count. */
export function modelUsage(
  plugin: string,
  events: readonly SpoolEvent[],
  since: number,
): readonly ModelUsage[] {
  const groups = new Map<string, ModelUsage>();
  for (const event of routesOf(plugin, events)) {
    if (event.route !== "provider" || Date.parse(event.ts) < since) continue;
    const seen = groups.get(event.model);
    const usage = event.usage;
    groups.set(event.model, {
      model: event.model,
      requests: (seen?.requests ?? 0) + 1,
      inputTokens: (seen?.inputTokens ?? 0) + tokenCount(usage, "input_tokens"),
      outputTokens: (seen?.outputTokens ?? 0) + tokenCount(usage, "output_tokens"),
      cacheReadTokens: (seen?.cacheReadTokens ?? 0) + tokenCount(usage, "cache_read_input_tokens"),
      cacheWriteTokens: (seen?.cacheWriteTokens ?? 0) + tokenCount(usage, "cache_creation_input_tokens"),
    });
  }
  return [...groups.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/** The spool's last thirty days, which every part of `usage` reads (read once, passed around). */
export function usageEvents(deps: Deps): readonly SpoolEvent[] {
  return deps.spool.events(new Date(deps.clock.now()), USAGE_SPOOL_DAYS);
}

/** The three usage windows over the spool's last thirty days. */
export function usageWindows(
  deps: Deps,
  events: readonly SpoolEvent[] = usageEvents(deps),
): readonly UsageWindow[] {
  const now = new Date(deps.clock.now());
  return USAGE_WINDOWS.map(([label, days]) => ({
    label,
    days,
    rows: modelUsage(deps.provider.name, events, windowStart(now, days)),
  }));
}

// ── router health ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The router health window: the last 24 hours. */
const HEALTH_WINDOW_MS = 24 * 60 * 60_000;

/** How this plugin's router fared over the last 24 hours, one count per health event kind. */
export type RouterHealthCounts = Readonly<Record<RouterHealth, number>>;

/** The health events of `plugin` at or after `since` (epoch ms), counted per kind. */
export function healthCounts(
  plugin: string,
  events: readonly SpoolEvent[],
  since: number,
): RouterHealthCounts {
  const counts: Record<RouterHealth, number> = {
    fallback: 0,
    refusal: 0,
    rate_limited: 0,
    budget_stop: 0,
    restart: 0,
  };
  for (const event of events)
    if (isHealthEvent(event) && event.plugin === plugin && event.ts >= since) counts[event.event] += 1;
  return counts;
}

/** The router's last 24 hours, from the spool's events (`usage` passes the thirty days it already read). */
export function routerHealth(
  deps: Deps,
  events: readonly SpoolEvent[] = deps.spool.events(new Date(deps.clock.now()), 2),
): RouterHealthCounts {
  return healthCounts(deps.provider.name, events, deps.clock.now() - HEALTH_WINDOW_MS);
}
