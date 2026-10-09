/**
 * CSV export of what a table shows: the same rows, in the same order and filter, with raw numbers and ISO
 * times so a spreadsheet can sum and sort them. Pure; main.ts turns the text into a download.
 */

import type { AttributionNode } from "../cost/attribution.ts";
import { requestCost } from "../cost/prices.ts";
import type { RequestRecord, ToolCallRecord } from "../shared/model.ts";

/** An estimate as a CSV number (six decimals), or blank when unpriced. */
function usd(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

/** One CSV field: quoted when it holds a comma, quote or line break; formula-looking text is defused. */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number | null)[][]): string {
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

const iso = (ts: number): string => new Date(ts).toISOString();

export function requestsCsv(requests: RequestRecord[]): string {
  return toCsv([
    [
      "time",
      "request_id",
      "session_id",
      "agent_id",
      "model",
      "provider",
      "upstream",
      "latency_ms",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "stop_reason",
      "est_cost_usd",
    ],
    ...requests.map((r) => [
      iso(r.ts),
      r.id,
      r.sessionId,
      r.agentId,
      r.model,
      r.provider,
      r.upstream,
      r.latencyMs,
      r.tokens.input,
      r.tokens.output,
      r.tokens.cacheRead,
      r.tokens.cacheWrite,
      r.stopReason,
      usd(requestCost(r)?.usd ?? null),
    ]),
  ]);
}

export function toolsCsv(tools: ToolCallRecord[]): string {
  return toCsv([
    ["started", "tool_use_id", "session_id", "agent_id", "tool", "duration_ms", "result"],
    ...tools.map((t) => [
      iso(t.startedAt),
      t.id,
      t.sessionId,
      t.agentId ?? "main",
      t.name,
      t.durationMs,
      t.ok ? "succeeded" : "failed",
    ]),
  ]);
}

/** The costs drill-down flattened: one row per model with its repo, session and agent spelled out, so a
 *  spreadsheet can pivot the tree any way it likes. */
export function attributionCsv(range: string, tree: AttributionNode[]): string {
  const rows: (string | number | null)[][] = [];
  const walk = (nodes: AttributionNode[], repo: string, session: string, agent: string): void => {
    for (const node of nodes) {
      if (node.kind === "repo") walk(node.children, node.label, session, agent);
      else if (node.kind === "session") walk(node.children, repo, node.label, agent);
      else if (node.kind === "agent") walk(node.children, repo, session, node.label);
      else
        rows.push([
          range,
          repo,
          session,
          agent,
          node.label,
          node.requests,
          node.tokens.input,
          node.tokens.output,
          node.tokens.cacheRead,
          node.tokens.cacheWrite,
          usd(node.costUsd),
          node.unpriced,
        ]);
    }
  };
  walk(tree, "", "", "");
  return toCsv([
    [
      "range",
      "repo",
      "session",
      "agent",
      "model",
      "requests",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "est_cost_usd",
      "unpriced_requests",
    ],
    ...rows,
  ]);
}

/** radar-requests-20261008-124301.csv, from the local wall clock. */
export function exportName(kind: string, now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `radar-${kind}-${stamp}.csv`;
}
