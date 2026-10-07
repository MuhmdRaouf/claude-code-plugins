import type { ActivityRow } from "../app/activity.ts";
import type { BoardRow, ReviewPacket } from "../app/queries.ts";
import type { Job } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import { board, hook } from "./board.ts";
import { modelId } from "./format.ts";
import { jobView } from "./job.ts";
import { review, reviewSummary } from "./review.ts";
import { summary } from "./summary.ts";
import { type UsageReport, usage } from "./usage.ts";
import { waitLine, waitTotals } from "./wait.ts";

/** Pure text renderers. Width-stable tables, no colour codes (Claude reads this output), ISO-free relative ages. Every
 *  name they print (CLI, slash commands, agents, models) comes from the provider. */
export function renderBoard(provider: Provider, rows: readonly ActivityRow[], now: number): string {
  return board(provider, rows, now);
}

/** The review packet: header (id, title, model, mode, attempt n of m, verdict), report summary + open items, a gate
 *  table (failing tails inline), scope result, change list, usage line, then the three next actions as exact commands. */
export function renderReview(provider: Provider, packet: ReviewPacket): string {
  return review(provider, packet);
}

/** `review --summary`: the verdict and what failed, without the diff or the change list. */
export function renderReviewSummary(provider: Provider, packet: ReviewPacket): string {
  return reviewSummary(provider, packet);
}

/** Compact one-screen summary the dispatcher subagent returns (verdict first, then what changed, then next actions). */
export function renderSummary(provider: Provider, job: Job): string {
  return summary(provider, job);
}

/** `usage`: the estimated total for today, 7 and 30 days (router and jobs together, from the dated price table),
 *  then the spool's per-model windows, then the job ledger, then one row per delegation engine that ran jobs. */
export function renderUsage(provider: Provider, report: UsageReport): string {
  return usage(provider, report);
}

/** The first line `run` prints, before the job runs: the dispatcher reads the id from it. */
export function renderStarted(provider: Provider, job: Job): string {
  return `${provider.name} job ${job.id} started: ${job.brief.title} (${modelId(provider, job)}, ${job.brief.mode})`;
}

/** The SessionStart hook's line: jobs awaiting review or still running; empty when there are none. */
export function renderHook(provider: Provider, rows: readonly ActivityRow[]): string {
  return hook(provider, rows);
}

/** `show`: one job's state, attempts and live progress. */
export function renderJob(provider: Provider, row: BoardRow, now: number): string {
  return jobView(provider, row, now);
}

/** One compact line per job as it lands in a multi-follow (`wait a b c`, `batch --wait`). */
export function renderWaitLine(provider: Provider, job: Job, landed: boolean): string {
  return waitLine(provider, job, landed);
}

/** The totals line after the last job of a multi-follow lands. */
export function renderWaitTotals(provider: Provider, jobs: readonly Job[]): string {
  return waitTotals(provider, jobs);
}
