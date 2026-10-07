// Spending budgets, as the observatory sets them: `<observatory>/budgets.json` holds what the user asked for, and
// `<observatory>/budget-status.json` what the observatory last worked out — which scopes are stopped this period. A
// router reads the status (and the budgets, for the period's name) and refuses its provider's models while its scope,
// or "total", is stopped. Anything it cannot trust — no file, a file older than ten minutes, a file that does not
// parse — stops nothing: a broken observatory must never cut a user off.
import { z } from "zod";

/** A status older than this (or this far in the future) is stale and stops nothing. */
export const BUDGET_STALE_MS = 10 * 60_000;

const PERIODS = ["day", "week", "month"] as const;
export type BudgetPeriod = (typeof PERIODS)[number];

/** The stop a router obeys: the scope that is stopped and its budget's period, when budgets.json names it. */
export interface BudgetStop {
  readonly scope: string;
  readonly period: BudgetPeriod | undefined;
}

const StatusShape = z.looseObject({
  version: z.literal(1),
  updatedAt: z.number(),
  stopped: z.array(z.string()),
  spend: z
    .array(z.looseObject({ id: z.string(), pct: z.number() }))
    .optional()
    .catch(undefined),
});

const BudgetShape = z.looseObject({
  id: z.string(),
  scope: z.string(),
  period: z.enum(PERIODS),
  action: z.string(),
});

const BudgetsShape = z.looseObject({ version: z.literal(1), budgets: z.array(z.unknown()) });

/** The scope a plugin's own budget has: `provider:<name>`. */
export function providerScope(plugin: string): string {
  return `provider:${plugin}`;
}

/** The budgets that parse, one bad entry skipped rather than all of them lost. */
function budgetsOf(budgets: unknown): z.infer<typeof BudgetShape>[] {
  const parsed = BudgetsShape.safeParse(budgets);
  if (!parsed.success) return [];
  return parsed.data.budgets.flatMap((entry) => {
    const budget = BudgetShape.safeParse(entry);
    return budget.success ? [budget.data] : [];
  });
}

/**
 * Whether this plugin's provider models are stopped right now: its own scope first, then "total". `status` and
 * `budgets` are the parsed files (undefined when missing or unreadable); `now` is epoch milliseconds.
 */
export function budgetStop(
  plugin: string,
  status: unknown,
  budgets: unknown,
  now: number,
): BudgetStop | undefined {
  const parsed = StatusShape.safeParse(status);
  if (!parsed.success) return undefined;
  if (Math.abs(now - parsed.data.updatedAt) > BUDGET_STALE_MS) return undefined;
  const scope = [providerScope(plugin), "total"].find((name) => parsed.data.stopped.includes(name));
  if (scope === undefined) return undefined;
  const stops = budgetsOf(budgets).filter((budget) => budget.scope === scope && budget.action === "stop");
  const over = new Set((parsed.data.spend ?? []).filter((row) => row.pct >= 100).map((row) => row.id));
  const budget = stops.find((stop) => over.has(stop.id)) ?? stops[0];
  return { scope, period: budget?.period };
}

/** The refusal's text, word for word the same in every router. */
export function budgetMessage(display: string, stop: BudgetStop): string {
  return `${display} budget reached for this ${stop.period ?? "period"}: raise or lift it in the Observatory dashboard (/observatory:open)`;
}
