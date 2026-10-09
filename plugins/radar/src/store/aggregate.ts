/**
 * Pure aggregation over records: percentiles, totals, per-model and per-upstream tables. No state, no IO —
 * every function here is trivially testable and shared by the JSON routes and the SSE snapshot.
 */
import { costOfAll } from "../cost/prices.ts";
import {
  addTokens,
  type ModelRow,
  type RequestRecord,
  type SessionView,
  type Summary,
  type ToolCallRecord,
  totalTokens,
  type UpstreamRow,
  ZERO_TOKENS,
} from "../shared/model.ts";
import { providerOf, upstreamHost } from "../shared/provider.ts";

/** Linear-interpolation percentile (nearest-rank feels steppy on small samples); null for no data. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? sorted[sorted.length - 1] ?? 0;
  if (low === high) return lowValue;
  const highValue = sorted[high] ?? lowValue;
  const weight = rank - low;
  return Math.round(lowValue + (highValue - lowValue) * weight);
}

export function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((a, b) => a + b, 0);
  return Math.round(total / values.length);
}

const STOP_ERRORS = new Set(["error", "overloaded_error", "api_error", "request_error"]);

export function summarize(
  sessions: SessionView[],
  requests: RequestRecord[],
  tools: ToolCallRecord[],
  now: number,
): Summary {
  const latencies = requests.map((r) => r.latencyMs).filter((v): v is number => v !== null);
  const started = sessions.map((s) => s.startedAt).filter((v): v is number => v !== null);
  const tokens = requests.reduce((acc, r) => addTokens(acc, r.tokens), ZERO_TOKENS);
  return {
    sessions: sessions.length,
    liveSessions: sessions.filter((s) => s.live).length,
    agents: sessions.reduce((acc, s) => acc + s.agents.length, 0),
    requests: requests.length,
    tokens,
    errors:
      tools.filter((t) => !t.ok).length +
      requests.filter((r) => r.stopReason !== null && STOP_ERRORS.has(r.stopReason)).length,
    toolCalls: tools.length,
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    startedAt: started.length > 0 ? Math.min(...started) : null,
    now,
    costUsd: costOfAll(requests),
  };
}

export function modelRows(requests: RequestRecord[]): ModelRow[] {
  const byModel = new Map<string, RequestRecord[]>();
  for (const request of requests) {
    const bucket = byModel.get(request.model);
    if (bucket) bucket.push(request);
    else byModel.set(request.model, [request]);
  }
  const rows: ModelRow[] = [];
  for (const [model, bucket] of byModel) {
    const latencies = bucket.map((r) => r.latencyMs).filter((v): v is number => v !== null);
    rows.push({
      model,
      provider: providerOf(model),
      requests: bucket.length,
      errors: bucket.filter((r) => r.stopReason !== null && STOP_ERRORS.has(r.stopReason)).length,
      tokens: bucket.reduce((acc, r) => addTokens(acc, r.tokens), ZERO_TOKENS),
      latencyP50: percentile(latencies, 50),
      costUsd: costOfAll(bucket),
    });
  }
  return rows.sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
}

/** One row per host: a router's "api.z.ai" and a session's "https://api.z.ai" are the same endpoint. */
export function upstreamRows(requests: RequestRecord[]): UpstreamRow[] {
  const byHost = new Map<string, RequestRecord[]>();
  for (const request of requests) {
    const host = upstreamHost(request.upstream);
    const bucket = byHost.get(host);
    if (bucket) bucket.push(request);
    else byHost.set(host, [request]);
  }
  const rows: UpstreamRow[] = [];
  for (const [host, bucket] of byHost) {
    rows.push({
      upstream: bucket[0]?.upstream ?? "",
      host,
      requests: bucket.length,
      tokens: bucket.reduce((acc, r) => addTokens(acc, r.tokens), ZERO_TOKENS),
      costUsd: costOfAll(bucket),
    });
  }
  return rows.sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
}

/** Count of tool calls per tool name, most used first. */
export function toolCounts(tools: ToolCallRecord[]): { name: string; count: number; failures: number }[] {
  const byName = new Map<string, { count: number; failures: number }>();
  for (const tool of tools) {
    const entry = byName.get(tool.name) ?? { count: 0, failures: 0 };
    entry.count += 1;
    if (!tool.ok) entry.failures += 1;
    byName.set(tool.name, entry);
  }
  return [...byName.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
