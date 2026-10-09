import type { Job } from "../domain/job.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { type EngineUsage, summarizeEngines, summarizeUsage, type TierUsage } from "../domain/usage.ts";
import { INITIAL_PROGRESS, type Progress, reduceProgress } from "../domain/worker-events.ts";
import type { Worker } from "../ports/index.ts";
import type { Deps } from "./deps.ts";
import { depsForJob, jobEngine } from "./engine-select.ts";
import type { AppError } from "./errors.ts";

export interface BoardRow {
  readonly job: Job;
  readonly progress?: Progress;
  /** Driver lock held by a live process. */
  readonly live: boolean;
}

type Scope = { readonly repoRoot?: string; readonly all: boolean };

function jobsIn(deps: Deps, scope: Scope): Promise<readonly Job[]> {
  return deps.store.list(
    scope.all || scope.repoRoot === undefined ? undefined : { repoRoot: scope.repoRoot },
  );
}

/** Jobs (repo-filtered unless all), newest first; progress folded from the latest attempt log for running jobs. A job
 *  whose state is running/verifying but whose driver is dead is reported live=false (the board shows it as stale). */
export async function board(deps: Deps, opts: Scope): Promise<readonly BoardRow[]> {
  const jobs = await jobsIn(deps, opts);
  return Promise.all(jobs.map((job) => rowOf(deps, job)));
}

/** One job's board row, found by id or unique prefix. */
export async function jobRow(deps: Deps, id: string): Promise<Result<BoardRow, AppError>> {
  const found = await deps.store.find(id);
  return found.ok ? ok(await rowOf(deps, found.value)) : err({ kind: "store", error: found.error });
}

async function rowOf(deps: Deps, job: Job): Promise<BoardRow> {
  const pid = await deps.files.driverPid(deps.store.paths(job.id));
  const live = pid !== undefined && deps.process.isAlive(pid);
  const progress = job.state === "running" ? await runningProgress(deps, job) : undefined;
  return progress === undefined ? { job, live } : { job, progress, live };
}

/** The driver's snapshot when it has one for the running attempt, else the attempt's log folded. */
async function runningProgress(deps: Deps, job: Job): Promise<Progress | undefined> {
  const n = job.attempts.length;
  const paths = deps.store.paths(job.id);
  return (
    (await deps.files.readProgress(paths, n)) ??
    (await foldAttemptLog(deps, paths.attemptLog(n), depsForJob(deps, job).worker))
  );
}

export interface ReviewPacket {
  readonly job: Job;
  readonly diffStat?: string;
  readonly diff?: string;
}

/** Everything the reviewer needs; diff included on request, bounded to maxDiffChars with a truncation marker. Only an
 *  undecided edit job still has a worktree to diff. */
export async function reviewPacket(
  deps: Deps,
  id: string,
  opts: { readonly diff: boolean; readonly maxDiffChars: number },
): Promise<Result<ReviewPacket, AppError>> {
  const found = await deps.store.find(id);
  if (!found.ok) return err({ kind: "store", error: found.error });
  const job = found.value;
  const { worktree, baseSha } = job.workspace;
  if (worktree === undefined || job.state === "accepted" || job.state === "discarded") return ok({ job });
  const stat = await deps.git.diff(worktree, baseSha, { stat: true });
  if (!stat.ok) return err({ kind: "git", error: stat.error });
  if (!opts.diff) return ok({ job, diffStat: stat.value });
  const diff = await deps.git.diff(worktree, baseSha, { stat: false });
  if (!diff.ok) return err({ kind: "git", error: diff.error });
  return ok({ job, diffStat: stat.value, diff: bounded(diff.value, opts.maxDiffChars) });
}

function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[diff truncated: ${text.length - max} more characters]\n`;
}

/** The claude engine's per-tier ledger; jobs on a delegation engine are engineUsage's. */
export async function usage(deps: Deps, opts: Scope): Promise<readonly TierUsage[]> {
  return summarizeUsage((await jobsIn(deps, opts)).filter((job) => jobEngine(job) === "claude"));
}

/** Per delegation engine: its jobs and what their attempts used. */
export async function engineUsage(deps: Deps, opts: Scope): Promise<readonly EngineUsage[]> {
  return summarizeEngines(await jobsIn(deps, opts));
}

/** Progress folded from an attempt's raw log, read by the worker that wrote it; undefined when there is no log yet. */
async function foldAttemptLog(
  deps: Deps,
  path: string,
  worker: Pick<Worker, "parseLine">,
): Promise<Progress | undefined> {
  const text = await deps.files.readText(path);
  if (!text.ok) return undefined;
  return text.value
    .split("\n")
    .reduce((progress, line) => worker.parseLine(line).reduce(reduceProgress, progress), INITIAL_PROGRESS);
}
