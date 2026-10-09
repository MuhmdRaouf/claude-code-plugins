/**
 * Router health: provider plugins' routers append "router.event" lines to the shared spool (fallback to Anthropic,
 * refusal, rate limit, budget stop, restart). This module reads those lines tolerantly — the health kind may sit in
 * `event` (when the line names itself with `kind: "router.event"`) or in `kind`/`type` (when `event` is
 * "router.event") — and folds them into per-provider counts over time. Pure; no IO.
 */
import {
  ROUTER_EVENT_KINDS,
  type RouterEventKind,
  type RouterEventRecord,
  type SpoolLine,
} from "../shared/model.ts";

const KINDS = new Set<string>(ROUTER_EVENT_KINDS);
const KIND_KEYS = ["event", "kind", "type", "action", "name"] as const;

/** True when a spool line is a router health event (either naming convention). */
export function isRouterEventLine(line: SpoolLine): boolean {
  return line.event === "router.event" || line.kind === "router.event";
}

function healthKindOf(line: SpoolLine): RouterEventKind | null {
  for (const key of KIND_KEYS) {
    const value = line[key];
    if (typeof value === "string" && KINDS.has(value)) return value as RouterEventKind;
  }
  return null;
}

function tsOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** One spool line as a router health event, or null when it is not one (or names no plugin or kind). */
export function parseRouterEvent(line: SpoolLine): RouterEventRecord | null {
  if (!isRouterEventLine(line)) return null;
  const event = healthKindOf(line);
  const ts = tsOf(line.ts);
  if (event === null || ts === null || typeof line.plugin !== "string" || line.plugin === "") return null;
  return {
    ts,
    plugin: line.plugin,
    event,
    reason: typeof line.reason === "string" ? line.reason.slice(0, 200) : "",
    model: typeof line.model === "string" && line.model !== "" ? line.model : null,
  };
}

export type RouterCounts = Record<RouterEventKind, number>;

export type ProviderHealth = {
  plugin: string;
  counts: RouterCounts;
  /** Events per hour over the window, oldest first: one total per bucket. */
  series: number[];
  /** Per-kind series, same buckets, in ROUTER_EVENT_KINDS order. */
  kindSeries: number[][];
  lastAt: number | null;
  /** The most recent reason given, for the card's subtitle. */
  lastReason: string | null;
};

export type RouterHealth = {
  windowMs: number;
  buckets: number;
  providers: ProviderHealth[];
  recent: RouterEventRecord[];
};

const zeroCounts = (): RouterCounts => ({
  fallback: 0,
  refusal: 0,
  rate_limited: 0,
  budget_stop: 0,
  restart: 0,
});

function providerEntry(plugin: string, buckets: number): ProviderHealth {
  return {
    plugin,
    counts: zeroCounts(),
    series: new Array<number>(buckets).fill(0),
    kindSeries: ROUTER_EVENT_KINDS.map(() => new Array<number>(buckets).fill(0)),
    lastAt: null,
    lastReason: null,
  };
}

function addEvent(entry: ProviderHealth, event: RouterEventRecord, bucket: number): void {
  entry.counts[event.event] += 1;
  entry.series[bucket] = (entry.series[bucket] ?? 0) + 1;
  const kindRow = entry.kindSeries[ROUTER_EVENT_KINDS.indexOf(event.event)];
  if (kindRow !== undefined) kindRow[bucket] = (kindRow[bucket] ?? 0) + 1;
  if (entry.lastAt === null || event.ts >= entry.lastAt) {
    entry.lastAt = event.ts;
    entry.lastReason = event.reason === "" ? null : event.reason;
  }
}

/** Per-provider counts and hourly series over the last `windowMs` (default 24 h), busiest provider first. */
export function routerHealth(
  events: RouterEventRecord[],
  now: number,
  windowMs = 86_400_000,
  buckets = 24,
): RouterHealth {
  const start = now - windowMs;
  const span = windowMs / buckets;
  const byPlugin = new Map<string, ProviderHealth>();
  const inWindow = events.filter((event) => event.ts > start && event.ts <= now);
  for (const event of inWindow) {
    const entry = byPlugin.get(event.plugin) ?? providerEntry(event.plugin, buckets);
    byPlugin.set(event.plugin, entry);
    addEvent(entry, event, Math.min(buckets - 1, Math.floor((event.ts - start) / span)));
  }
  const total = (entry: ProviderHealth): number => entry.series.reduce((a, b) => a + b, 0);
  return {
    windowMs,
    buckets,
    providers: [...byPlugin.values()].sort((a, b) => total(b) - total(a) || a.plugin.localeCompare(b.plugin)),
    recent: [...inWindow].sort((a, b) => b.ts - a.ts).slice(0, 50),
  };
}
