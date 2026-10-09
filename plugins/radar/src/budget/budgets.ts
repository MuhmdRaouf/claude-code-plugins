/**
 * Budgets: the user sets them in the dashboard's settings, radar keeps them in
 * <state>/budgets.json, measures spend against them from the usage ledger and writes <state>/budget-status.json for
 * the provider plugins' routers to read. A budget with action "stop" at or over 100% for its current period puts its
 * scope in `stopped`; the routers then refuse that scope's requests (claude-* requests never). No file means no
 * budgets; an unreadable file is treated the same, never as an error that blocks anything.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerRow } from "../cost/ledger.ts";
import { addCost, pluginOf, requestCost } from "../cost/prices.ts";
import { stateDir } from "../shared/paths.ts";

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];
export type BudgetAction = "warn" | "stop";

export type Budget = {
  id: string;
  /** "total" or "provider:<plugin name>", e.g. "provider:zai". */
  scope: string;
  period: Period;
  limitUsd: number;
  action: BudgetAction;
};

export type BudgetSpend = {
  id: string;
  spentUsd: number;
  limitUsd: number;
  /** Spend as a percentage of the limit (100 = the limit), one decimal. */
  pct: number;
  scope: string;
  period: Period;
  action: BudgetAction;
  /** When the current period began (epoch ms). */
  periodStart: number;
};

export type BudgetStatus = {
  version: 1;
  updatedAt: number;
  stopped: string[];
  spend: BudgetSpend[];
};

export function budgetsPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "budgets.json");
}

export function budgetStatusPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "budget-status.json");
}

const SCOPE = /^(total|provider:[a-z0-9][a-z0-9._-]{0,39})$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_BUDGETS = 50;

/** One budget from untrusted JSON, or a sentence saying what is wrong with it. */
export function validateBudget(input: unknown): Budget | string {
  if (typeof input !== "object" || input === null) return "a budget must be an object";
  const record = input as Record<string, unknown>;
  if (typeof record.id !== "string" || !ID.test(record.id)) return "id: 1-40 letters, digits, _ or -";
  if (typeof record.scope !== "string" || !SCOPE.test(record.scope)) {
    return 'scope: "total" or "provider:<plugin>"';
  }
  if (typeof record.period !== "string" || !PERIODS.includes(record.period as Period)) {
    return "period: day, week or month";
  }
  const limit = record.limitUsd;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit > 1_000_000) {
    return "limitUsd: a positive amount up to 1,000,000";
  }
  if (record.action !== "warn" && record.action !== "stop") return "action: warn or stop";
  return {
    id: record.id,
    scope: record.scope,
    period: record.period as Period,
    limitUsd: Math.round(limit * 100) / 100,
    action: record.action,
  };
}

/** A whole budgets list from untrusted JSON: the budgets, or the first problem found. */
export function validateBudgets(input: unknown): Budget[] | string {
  const list = Array.isArray(input)
    ? input
    : typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).budgets
      : undefined;
  if (!Array.isArray(list)) return "expected {budgets: [...]}";
  if (list.length > MAX_BUDGETS) return `at most ${MAX_BUDGETS} budgets`;
  const out: Budget[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const budget = validateBudget(entry);
    if (typeof budget === "string") return `budget ${index + 1}: ${budget}`;
    if (ids.has(budget.id)) return `budget ${index + 1}: duplicate id ${budget.id}`;
    ids.add(budget.id);
    out.push(budget);
  }
  return out;
}

/** The budgets on disk; missing, unreadable or malformed entries are skipped, never fatal. */
export function readBudgets(env: NodeJS.ProcessEnv): Budget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(budgetsPath(env), "utf8"));
  } catch {
    return [];
  }
  const list =
    typeof parsed === "object" && parsed !== null ? (parsed as { budgets?: unknown }).budgets : null;
  if (!Array.isArray(list)) return [];
  const out: Budget[] = [];
  for (const entry of list) {
    const budget = validateBudget(entry);
    if (typeof budget !== "string" && !out.some((b) => b.id === budget.id)) out.push(budget);
  }
  return out;
}

/** Write a file whole or not at all: a reader never sees half a JSON document. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeBudgets(env: NodeJS.ProcessEnv, budgets: Budget[]): void {
  writeJsonAtomic(budgetsPath(env), { version: 1, budgets });
}

/** Local start of the current day, week (Monday) or month. */
export function periodStart(period: Period, now: number): number {
  const date = new Date(now);
  if (period === "month") return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (period === "day") return midnight.getTime();
  const sinceMonday = (midnight.getDay() + 6) % 7;
  return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - sinceMonday).getTime();
}

/** Does a request on this model count against this scope? */
export function inScope(scope: string, model: string): boolean {
  if (scope === "total") return true;
  return scope === `provider:${pluginOf(model) ?? ""}`;
}

/** Spend for one budget's current period. */
export function spendFor(budget: Budget, rows: LedgerRow[], now: number): BudgetSpend {
  const start = periodStart(budget.period, now);
  let spent: number | null = null;
  for (const row of rows) {
    if (row.ts >= start && row.ts <= now && inScope(budget.scope, row.model)) {
      spent = addCost(spent, requestCost(row)?.usd ?? null);
    }
  }
  const spentUsd = spent ?? 0;
  return {
    id: budget.id,
    spentUsd: Math.round(spentUsd * 10_000) / 10_000,
    limitUsd: budget.limitUsd,
    pct: Math.round((spentUsd / budget.limitUsd) * 1000) / 10,
    scope: budget.scope,
    period: budget.period,
    action: budget.action,
    periodStart: start,
  };
}

/** The whole status document routers read. */
export function computeStatus(budgets: Budget[], rows: LedgerRow[], now: number): BudgetStatus {
  const spend = budgets.map((budget) => spendFor(budget, rows, now));
  const stopped = new Set<string>();
  for (const entry of spend) if (entry.action === "stop" && entry.pct >= 100) stopped.add(entry.scope);
  return { version: 1, updatedAt: now, stopped: [...stopped].sort(), spend };
}

/** Publish the status; never throws (a router reading a missing or stale file simply stops nothing). */
export function writeStatus(env: NodeJS.ProcessEnv, status: BudgetStatus): boolean {
  try {
    writeJsonAtomic(budgetStatusPath(env), status);
    return true;
  } catch {
    return false;
  }
}
