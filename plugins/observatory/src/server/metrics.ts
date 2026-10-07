/**
 * GET /metrics: the Prometheus text exposition format (0.0.4), built from what observatory already holds. Usage
 * counters (requests, tokens, estimated cost) come from the 35-day usage ledger, so they survive restarts; the rest
 * (latency histogram, tool calls, errors, sessions, alerts, budgets, router events) describe the dashboard's
 * current window. Pure: the route hands it plain data.
 */
import type { Alert } from "../alerts/engine.ts";
import type { BudgetSpend } from "../budget/budgets.ts";
import type { LedgerNames, LedgerRow } from "../cost/ledger.ts";
import { costOf, pluginOf } from "../cost/prices.ts";
import type { ApiErrorRecord, RequestRecord, RouterEventRecord, ToolCallRecord } from "../shared/model.ts";

export type MetricsInput = {
  version: string;
  ledger: LedgerRow[];
  names: LedgerNames;
  requests: RequestRecord[];
  tools: ToolCallRecord[];
  apiErrors: ApiErrorRecord[];
  routerEvents: RouterEventRecord[];
  alerts: Alert[];
  sessions: { live: boolean }[];
  budgets: BudgetSpend[];
};

/** Label values escaped the way the text format wants: backslash, quote and newline. */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(pairs: Record<string, string>): string {
  const parts = Object.entries(pairs).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

/** "zai", "kimi", … for provider plugins' models, "anthropic" for claude-*, else "other". */
export function providerSlug(model: string): string {
  const plugin = pluginOf(model);
  if (plugin !== null) return plugin;
  return model.toLowerCase().startsWith("claude-") ? "anthropic" : "other";
}

type Family = { name: string; type: "counter" | "gauge" | "histogram"; help: string; lines: string[] };

function family(name: string, type: Family["type"], help: string): Family {
  return { name, type, help, lines: [] };
}

/** Sum values per label set, then emit one sample each, in a stable order. */
function summed(target: Family, entries: [Record<string, string>, number][], suffix = ""): void {
  const totals = new Map<string, number>();
  for (const [pairs, value] of entries) {
    const key = labels(pairs);
    totals.set(key, (totals.get(key) ?? 0) + value);
  }
  for (const key of [...totals.keys()].sort())
    target.lines.push(`${target.name}${suffix}${key} ${num(totals.get(key) ?? 0)}`);
}

function num(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e6) / 1e6);
}

const TOKEN_KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const KIND_LABEL = { input: "input", output: "output", cacheRead: "cache_read", cacheWrite: "cache_write" };

function usageFamilies(input: MetricsInput): Family[] {
  const requests = family(
    "observatory_requests_total",
    "counter",
    "Model requests seen, by model and project.",
  );
  const tokens = family("observatory_tokens_total", "counter", "Tokens by kind, model and project.");
  const cost = family(
    "observatory_cost_usd_total",
    "counter",
    "Estimated cost in USD at list price (priced models only), by model and project.",
  );
  const r: [Record<string, string>, number][] = [];
  const t: [Record<string, string>, number][] = [];
  const c: [Record<string, string>, number][] = [];
  for (const row of input.ledger) {
    const base = {
      model: row.model,
      provider: providerSlug(row.model),
      project: input.names.sessions[row.sessionId]?.project ?? "",
    };
    r.push([base, 1]);
    for (const kind of TOKEN_KINDS) t.push([{ ...base, kind: KIND_LABEL[kind] }, row.tokens[kind]]);
    const usd = costOf(row.model, row.tokens);
    if (usd !== null) c.push([base, usd]);
  }
  summed(requests, r);
  summed(tokens, t);
  summed(cost, c);
  return [requests, tokens, cost];
}

const LATENCY_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300];

function latencyFamily(input: MetricsInput): Family {
  const histogram = family(
    "observatory_request_latency_seconds",
    "histogram",
    "Time from the prompt or tool result to the model's answer, by provider.",
  );
  const byProvider = new Map<string, number[]>();
  for (const request of input.requests) {
    if (request.latencyMs === null || request.provider === "route") continue;
    const slug = providerSlug(request.model);
    byProvider.set(slug, [...(byProvider.get(slug) ?? []), request.latencyMs / 1000]);
  }
  for (const provider of [...byProvider.keys()].sort()) {
    const values = byProvider.get(provider) ?? [];
    for (const le of LATENCY_BUCKETS) {
      const count = values.filter((v) => v <= le).length;
      histogram.lines.push(`${histogram.name}_bucket${labels({ provider, le: String(le) })} ${count}`);
    }
    histogram.lines.push(`${histogram.name}_bucket${labels({ provider, le: "+Inf" })} ${values.length}`);
    histogram.lines.push(
      `${histogram.name}_sum${labels({ provider })} ${num(values.reduce((a, b) => a + b, 0))}`,
    );
    histogram.lines.push(`${histogram.name}_count${labels({ provider })} ${values.length}`);
  }
  return histogram;
}

function activityFamilies(input: MetricsInput): Family[] {
  const tools = family("observatory_tool_calls_total", "counter", "Tool calls by tool and result.");
  summed(
    tools,
    input.tools.map((t) => [{ tool: t.name, result: t.ok ? "ok" : "error" }, 1]),
  );
  const errors = family(
    "observatory_api_errors_total",
    "counter",
    "Rate limits and server errors (429, 5xx), by status and where they were seen.",
  );
  summed(
    errors,
    input.apiErrors.map((e) => [{ status: String(e.status), source: e.source }, 1]),
  );
  const router = family(
    "observatory_router_events_total",
    "counter",
    "Router health events by provider and kind.",
  );
  summed(
    router,
    input.routerEvents.map((e) => [{ provider: e.plugin, event: e.event }, 1]),
  );
  const sessions = family("observatory_sessions", "gauge", "Sessions tracked, live or ended.");
  const live = input.sessions.filter((s) => s.live).length;
  sessions.lines.push(`observatory_sessions${labels({ state: "live" })} ${live}`);
  sessions.lines.push(`observatory_sessions${labels({ state: "ended" })} ${input.sessions.length - live}`);
  return [tools, errors, router, sessions];
}

function alertFamilies(input: MetricsInput): Family[] {
  const alerts = family("observatory_alerts", "gauge", "Active alerts by kind.");
  for (const kind of ["stuck", "loop", "retry_storm", "context", "budget"]) {
    alerts.lines.push(
      `observatory_alerts${labels({ kind })} ${input.alerts.filter((a) => a.kind === kind).length}`,
    );
  }
  const spent = family("observatory_budget_spent_usd", "gauge", "Estimated spend this period per budget.");
  const limit = family("observatory_budget_limit_usd", "gauge", "Each budget's limit for its period.");
  for (const budget of input.budgets) {
    const pairs = labels({ budget: budget.id, scope: budget.scope, period: budget.period });
    spent.lines.push(`observatory_budget_spent_usd${pairs} ${num(budget.spentUsd)}`);
    limit.lines.push(`observatory_budget_limit_usd${pairs} ${num(budget.limitUsd)}`);
  }
  return [alerts, spent, limit];
}

/** The whole exposition, ending in a newline as the format requires. */
export function renderMetrics(input: MetricsInput): string {
  const info = family(
    "observatory_info",
    "gauge",
    "Always 1; the version label says which observatory answered.",
  );
  info.lines.push(`observatory_info${labels({ version: input.version })} 1`);
  const families = [
    info,
    ...usageFamilies(input),
    latencyFamily(input),
    ...activityFamilies(input),
    ...alertFamilies(input),
  ];
  const out: string[] = [];
  for (const f of families) {
    out.push(`# HELP ${f.name} ${f.help}`, `# TYPE ${f.name} ${f.type}`, ...f.lines);
  }
  return `${out.join("\n")}\n`;
}
