import { type SweepItem, sweepItems } from "../app/report-facts.ts";
import { isSweepBrief } from "../domain/brief.ts";
import type { Job } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import { gateFailed } from "../domain/verify.ts";
import { lastAttempt, modelId, oneLine, plural, usd, verdictOf } from "./format.ts";
import { priceOf } from "./prices.ts";
import { jobCostUsd } from "./usage.ts";

const TITLE_CHARS = 60;

/** One compact line per job as it lands in a multi-follow (`wait a b c`, `batch --wait`): id, verdict, title, gates
 *  (or sweep counts), cost. */
export function waitLine(provider: Provider, job: Job, landed: boolean): string {
  return [
    job.id,
    landed ? verdictOf(job) : "stale",
    oneLine(job.brief.title, TITLE_CHARS),
    verifiedText(job),
    priceOf(modelId(provider, job)) === undefined ? "unpriced" : `est. ${usd(jobCostUsd(provider, job))}`,
  ].join(" ");
}

/** The one line after the last job lands: how many jobs, how many passed, what they cost. */
export function waitTotals(provider: Provider, jobs: readonly Job[]): string {
  const pass = jobs.filter((job) => job.attempts.at(-1)?.verdict === "pass").length;
  return `${plural(jobs.length, "job")}: ${pass} pass, ${jobs.length - pass} not pass · est. ${usd(jobs.reduce((sum, job) => sum + jobCostUsd(provider, job), 0))}`;
}

/** What the verification column says: `gates n/m`, a sweep's `ok/fail/gap` counts, or `?` when nothing ran. */
function verifiedText(job: Job): string {
  const last = lastAttempt(job);
  if (isSweepBrief(job.brief)) {
    const items = sweepItems(last?.report);
    if (items === undefined) return "sweep ?";
    const by = (status: SweepItem["status"]) => items.filter((item) => item.status === status).length;
    return `sweep ${by("ok")}/${by("fail")}/${by("gap")}`;
  }
  const gates = last?.verification?.gates;
  if (gates === undefined) return "gates ?";
  if (gates.length === 0) return "gates none";
  return `gates ${gates.filter((gate) => !gateFailed(gate)).length}/${gates.length}`;
}
