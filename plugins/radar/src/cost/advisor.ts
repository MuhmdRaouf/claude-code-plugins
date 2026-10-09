/**
 * The model advisor: a cautious look for subagent runs that used a main model for work a flash model would
 * likely have done as well. A run counts only when everything about it looks small — few requests, little output,
 * nothing but read-only tools, no failures — and the saving is what the same tokens cost on the model's own flash
 * sibling from the price table. It is a hint, never a verdict: the card says "looks", and runs it cannot price
 * (models no offering names) are counted without a figure.
 */
import {
  addTokens,
  type RequestRecord,
  type Tokens,
  type ToolCallRecord,
  ZERO_TOKENS,
} from "../shared/model.ts";
import { addCost, flashOf, isSmallModel, requestCost } from "./prices.ts";

/** Tools that only look: a run that used nothing else is a candidate. */
export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "TodoWrite",
]);

export const ADVISOR_LIMITS = { maxRequests: 12, maxOutputTokens: 8000 } as const;

export type AdvisorModelRow = {
  model: string;
  flash: string | null;
  runs: number;
  costUsd: number | null;
  flashCostUsd: number | null;
};

export type AdvisorReport = {
  /** Subagent runs on a main model that were looked at. */
  runsChecked: number;
  /** Of those, the ones that look flash-sized. */
  candidates: number;
  /** Estimated saving had the candidates run on their flash sibling; null when none of them is priced. */
  savingUsd: number | null;
  byModel: AdvisorModelRow[];
  examples: { sessionId: string; agentId: string; model: string; requests: number; outputTokens: number }[];
};

type Run = { sessionId: string; agentId: string; requests: RequestRecord[]; tools: ToolCallRecord[] };

function runsOf(requests: RequestRecord[], tools: ToolCallRecord[]): Run[] {
  const runs = new Map<string, Run>();
  const run = (sessionId: string, agentId: string): Run => {
    const key = `${sessionId}:${agentId}`;
    let entry = runs.get(key);
    if (entry === undefined) {
      entry = { sessionId, agentId, requests: [], tools: [] };
      runs.set(key, entry);
    }
    return entry;
  };
  for (const r of requests) {
    if (r.agentId !== "main") {
      run(r.sessionId, r.agentId).requests.push(r);
    }
  }
  for (const t of tools) {
    const agentId = t.agentId ?? "main";
    if (agentId !== "main" && runs.has(`${t.sessionId}:${agentId}`)) run(t.sessionId, agentId).tools.push(t);
  }
  return [...runs.values()].filter((r) => r.requests.length > 0);
}

/** The model a run mostly used (by request count). */
function dominantModel(run: Run): string {
  const counts = new Map<string, number>();
  for (const r of run.requests) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

function looksSmall(run: Run): boolean {
  const output = run.requests.reduce((acc, r) => acc + r.tokens.output, 0);
  return (
    run.requests.length <= ADVISOR_LIMITS.maxRequests &&
    output <= ADVISOR_LIMITS.maxOutputTokens &&
    run.tools.every((t) => t.ok && READ_ONLY_TOOLS.has(t.name))
  );
}

/** One candidate's contribution: its tokens priced on its own model and on its flash sibling. */
function priced(
  model: string,
  run: Run,
): { tokens: Tokens; flash: string | null; cost: number | null; flashCost: number | null } {
  const tokens: Tokens = run.requests.reduce((acc, r) => addTokens(acc, r.tokens), { ...ZERO_TOKENS });
  const flash = flashOf(model);
  return {
    tokens,
    flash,
    cost: priceAs(model, run),
    flashCost: flash === null ? null : priceAs(flash, run),
  };
}

/** The run's requests priced as if each had run on `model`, on that request's own conditions; null when none
 *  of them was priced (one request at a time, so a tiering model prices each call at its own prompt size). */
function priceAs(model: string, run: Run): number | null {
  let total: number | null = null;
  for (const request of run.requests) {
    total = addCost(total, requestCost({ ...request, model })?.usd ?? null);
  }
  return total;
}

export function advise(requests: RequestRecord[], tools: ToolCallRecord[]): AdvisorReport {
  const byModel = new Map<string, AdvisorModelRow>();
  const examples: AdvisorReport["examples"] = [];
  let runsChecked = 0;
  let saving: number | null = null;
  for (const run of runsOf(requests, tools)) {
    const model = dominantModel(run);
    if (isSmallModel(model)) continue;
    runsChecked += 1;
    if (!looksSmall(run)) continue;
    const { tokens, flash, cost, flashCost } = priced(model, run);
    if (cost !== null && flashCost !== null) saving = addCost(saving, cost - flashCost);
    const row = byModel.get(model) ?? { model, flash, runs: 0, costUsd: null, flashCostUsd: null };
    row.runs += 1;
    row.costUsd = addCost(row.costUsd, cost);
    row.flashCostUsd = addCost(row.flashCostUsd, flashCost);
    byModel.set(model, row);
    examples.push({
      sessionId: run.sessionId,
      agentId: run.agentId,
      model,
      requests: run.requests.length,
      outputTokens: tokens.output,
    });
  }
  return {
    runsChecked,
    candidates: examples.length,
    savingUsd: saving,
    byModel: [...byModel.values()].sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model)),
    examples: examples.slice(0, 5),
  };
}
