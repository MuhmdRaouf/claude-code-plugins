/**
 * Attribution: who spent what. Ledger rows grouped by project, session, agent or model over today, the last 7
 * days or the last 30 days, each group with its request count, tokens by kind and estimated cost. Pure.
 */
import { addTokens, type Tokens, ZERO_TOKENS } from "../shared/model.ts";
import type { LedgerNames, LedgerRow } from "./ledger.ts";
import { addCost, costOf } from "./prices.ts";

export const ATTRIBUTION_BY = ["project", "session", "agent", "model"] as const;
export type AttributionBy = (typeof ATTRIBUTION_BY)[number];
export const ATTRIBUTION_RANGES = ["day", "week", "month"] as const;
export type AttributionRange = (typeof ATTRIBUTION_RANGES)[number];

export type AttributionRow = {
  key: string;
  label: string;
  requests: number;
  tokens: Tokens;
  /** Estimated USD at list price; null when no request in the group has a price. */
  costUsd: number | null;
  /** Requests in the group whose model the price table does not know. */
  unpriced: number;
};

/** Start of the range: local midnight today, or 7 / 30 days back from now. */
export function rangeStart(range: AttributionRange, now: number): number {
  if (range === "week") return now - 7 * 86_400_000;
  if (range === "month") return now - 30 * 86_400_000;
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const shortId = (id: string): string => id.slice(0, 8);

function sessionLabel(names: LedgerNames, sessionId: string): string {
  const known = names.sessions[sessionId];
  const project = known?.project ?? null;
  return project === null ? shortId(sessionId) : `${project} · ${shortId(sessionId)}`;
}

function projectOf(names: LedgerNames, sessionId: string): string | null {
  return names.sessions[sessionId]?.project ?? null;
}

function keyAndLabel(row: LedgerRow, by: AttributionBy, names: LedgerNames): { key: string; label: string } {
  if (by === "model") return { key: row.model, label: row.model };
  if (by === "session") return { key: row.sessionId, label: sessionLabel(names, row.sessionId) };
  if (by === "project") {
    const project = projectOf(names, row.sessionId);
    return { key: project ?? "(no project)", label: project ?? "(no project)" };
  }
  const key = `${row.sessionId}:${row.agentId}`;
  const agent = row.agentId === "main" ? "main" : (names.agents[key] ?? shortId(row.agentId));
  return { key, label: `${agent} · ${sessionLabel(names, row.sessionId)}` };
}

/** Rows grouped and summed, most expensive first, then most tokens. */
export function attribute(
  rows: LedgerRow[],
  by: AttributionBy,
  names: LedgerNames,
  since: number,
): AttributionRow[] {
  const groups = new Map<string, AttributionRow>();
  for (const row of rows) {
    if (row.ts < since) continue;
    const { key, label } = keyAndLabel(row, by, names);
    const group = groups.get(key) ?? {
      key,
      label,
      requests: 0,
      tokens: { ...ZERO_TOKENS },
      costUsd: null,
      unpriced: 0,
    };
    const cost = costOf(row.model, row.tokens);
    group.requests += 1;
    group.tokens = addTokens(group.tokens, row.tokens);
    group.costUsd = addCost(group.costUsd, cost);
    if (cost === null) group.unpriced += 1;
    groups.set(key, group);
  }
  const total = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;
  return [...groups.values()].sort(
    (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || total(b.tokens) - total(a.tokens),
  );
}

/** Today's estimated spend across every row (null when nothing today is priced). */
export function spendSince(rows: LedgerRow[], since: number): number | null {
  let total: number | null = null;
  for (const row of rows) if (row.ts >= since) total = addCost(total, costOf(row.model, row.tokens));
  return total;
}
