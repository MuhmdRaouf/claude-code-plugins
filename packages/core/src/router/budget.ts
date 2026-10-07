// The router's budget gate: what the observatory's budget-status.json says about this plugin, read at most every
// five seconds. Only a regular file under 1 MiB is read (a FIFO or a device there must never block the worker's event
// loop), and any trouble reading or parsing it stops nothing.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BudgetStop, budgetStop } from "../domain/budget.ts";
import type { EnvLookup } from "../domain/provider.ts";
import { observatoryHome } from "./spool-write.ts";

/** How long one reading of the files holds. */
export const BUDGET_CACHE_MS = 5000;

/** The largest status or budgets file worth reading. */
const MAX_BYTES = 1024 * 1024;

/** The observatory's budget status file, beside its spool. */
export function budgetStatusFile(env: EnvLookup): string {
  return join(observatoryHome(env), "budget-status.json");
}

/** The observatory's budgets file (the user's settings). */
export function budgetsFile(env: EnvLookup): string {
  return join(observatoryHome(env), "budgets.json");
}

/**
 * A small regular file as JSON; undefined for anything else (missing, a FIFO, too big, unreadable, not JSON). It is
 * opened non-blocking and checked through the open handle, so a file swapped for a FIFO between a check and the read
 * can never block the worker.
 */
function readSmallJson(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The gate: the stop in force for `plugin`'s models, or undefined. Reads the files at most once per `cacheMs`. */
export function createBudgetGate(
  plugin: string,
  env: EnvLookup,
  now: () => number = Date.now,
  cacheMs: number = BUDGET_CACHE_MS,
): () => BudgetStop | undefined {
  let readAt = Number.NEGATIVE_INFINITY;
  let stop: BudgetStop | undefined;
  return () => {
    const at = now();
    if (at - readAt < cacheMs && at >= readAt) return stop;
    readAt = at;
    const status = readSmallJson(budgetStatusFile(env));
    stop = status === undefined ? undefined : budgetStop(plugin, status, readSmallJson(budgetsFile(env)), at);
    return stop;
  };
}
