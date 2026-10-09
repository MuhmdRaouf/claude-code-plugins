import type { Brief } from "../domain/brief.ts";
import type { Attempt, Job, WorkerOutcome } from "../domain/job.ts";
import { selfContainedPrompt } from "../domain/prompt.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  finalizeWorker,
  INITIAL_PROGRESS,
  type Progress,
  reduceProgress,
  type WorkerEvent,
  type WorkerResult,
} from "../domain/worker-events.ts";
import type { Access, ReportContract, WorkerError, WorkerRun, WorkerSpec } from "../ports/index.ts";
import { resumesSession } from "./attempts.ts";
import type { Deps } from "./deps.ts";
import { type AppError, describeWorkerError } from "./errors.ts";
import { reportContract } from "./report-schema.ts";
import type { StopWatch } from "./stop-watch.ts";

/** Progress reaches progress.json at most this often while the worker streams. */
const PROGRESS_EVERY_MS = 2_000;
const RATE_LIMITED = 429;

interface AttemptRun {
  /** The attempt as it ran: outcome, usage, report, endedAt, and the session/prompt actually used. */
  readonly attempt: Attempt;
  readonly outcome: WorkerOutcome;
  /** Set when the worker could not be started at all (retrying will not help). */
  readonly failure?: AppError;
}

/** Runs the worker for `attempt`. A fix attempt whose session cannot be resumed is re-run once in a new session with
 *  the prompt made self-contained. */
export async function runAttempt(
  deps: Deps,
  job: Job,
  attempt: Attempt,
  stop: StopWatch,
): Promise<AttemptRun> {
  const report = await reportContract(deps.files, job.brief.report);
  if (!report.ok) {
    return notStarted(deps, attempt, report.error, {
      kind: "brief",
      errors: [{ kind: "field", field: "report", message: report.error }],
    });
  }
  const resume = resumesSession(attempt);
  // A worker with no session of its own (sessionKey "none") cannot resume anything: run the fix attempt as a
  // self-contained fresh session instead of asking for a resume it must refuse.
  if (resume && deps.worker.caps.sessionKey === "none") {
    const fresh = selfContained(deps, job, attempt);
    return finished(deps, fresh, await runSession(deps, job, fresh, report.value, stop, false));
  }
  const first = await runSession(deps, job, attempt, report.value, stop, resume);
  if (!(resume && first.ok && first.value.sessionMissing)) return finished(deps, attempt, first);
  const fresh = selfContained(deps, job, attempt);
  return finished(deps, fresh, await runSession(deps, job, fresh, report.value, stop, false));
}

/** The attempt re-run in a new session: the prompt retells everything the lost session knew, under a fresh key. */
function selfContained(deps: Deps, job: Job, attempt: Attempt): Attempt {
  return {
    ...attempt,
    prompt: selfContainedPrompt(
      job.brief,
      job.attempts.slice(0, attempt.n - 1),
      attempt.prompt,
      job.workspace.artifactsDir,
      deps.provider,
    ),
    sessionId: deps.ids.sessionId(),
  };
}

/** A session's result, and whether the worker found no session to resume. */
type SessionRun = WorkerResult & { readonly sessionMissing: boolean };

function finished(deps: Deps, attempt: Attempt, run: Result<SessionRun, WorkerError>): AttemptRun {
  if (!run.ok)
    return notStarted(deps, attempt, describeWorkerError(deps.provider, run.error), {
      kind: "worker",
      error: run.error,
    });
  const { outcome, usage, report, sessionId } = run.value;
  return {
    attempt: {
      ...attempt,
      sessionId: sessionId ?? attempt.sessionId,
      endedAt: deps.clock.iso(),
      outcome,
      usage,
      report,
    },
    outcome,
  };
}

function notStarted(deps: Deps, attempt: Attempt, message: string, failure: AppError): AttemptRun {
  const outcome: WorkerOutcome = { kind: "crashed", exitCode: null, signal: null, stderrTail: message };
  return { attempt: { ...attempt, endedAt: deps.clock.iso(), outcome }, outcome, failure };
}

async function runSession(
  deps: Deps,
  job: Job,
  attempt: Attempt,
  report: ReportContract,
  stop: StopWatch,
  resume: boolean,
): Promise<Result<SessionRun, WorkerError>> {
  const started = await deps.worker.start(workerSpec(deps, job, attempt, report, resume));
  if (!started.ok) return err(started.error);
  const run = started.value;
  // However the worker ends after a stop request, the attempt was stopped.
  const requested = { stop: false };
  const interrupt = () => {
    requested.stop = true;
    void run.interrupt("stopped");
  };
  if (stop.signal.aborted) interrupt();
  else stop.signal.addEventListener("abort", interrupt, { once: true });
  try {
    const kept = await follow(deps, job, attempt.n, run);
    const exit = await run.exit;
    const result = finalizeWorker(kept, exit, requested.stop ? "stopped" : exit.forced);
    return ok({ ...result, sessionMissing: exit.sessionMissing });
  } finally {
    stop.signal.removeEventListener("abort", interrupt);
  }
}

/** Folds the stream into progress (persisted at most every 2 s, and once at the end), reports every 429 retry to the
 *  limiter, and keeps only the events finalizeWorker reads (a long run streams many thousands of deltas). An
 *  engine-keyed session's `session` event is kept too: its id is the one a later attempt resumes. */
async function follow(deps: Deps, job: Job, n: number, run: WorkerRun): Promise<readonly WorkerEvent[]> {
  const paths = deps.store.paths(job.id);
  const kept: WorkerEvent[] = [];
  let progress: Progress = INITIAL_PROGRESS;
  let savedAt = Number.NEGATIVE_INFINITY;
  for await (const event of run.events) {
    progress = reduceProgress(progress, event);
    if (
      event.type === "init" ||
      event.type === "api_retry" ||
      event.type === "result" ||
      (event.type === "session" && deps.worker.caps.sessionKey === "engine")
    )
      kept.push(event);
    if (event.type === "api_retry" && event.status === RATE_LIMITED)
      await deps.limiter.rateLimited(deps.clock.now());
    if (deps.clock.now() - savedAt >= PROGRESS_EVERY_MS) {
      savedAt = deps.clock.now();
      await deps.files.writeProgress(paths, n, progress);
    }
  }
  await deps.files.writeProgress(paths, n, progress);
  return kept;
}

function workerSpec(
  deps: Deps,
  job: Job,
  attempt: Attempt,
  report: ReportContract,
  resume: boolean,
): WorkerSpec {
  const { brief, workspace } = job;
  return {
    cwd: workspaceDir(job),
    model: deps.provider.catalog[brief.model],
    ...(brief.effort === undefined ? {} : { effort: brief.effort }),
    access: ACCESS[brief.mode],
    prompt: attempt.prompt,
    session: { kind: resume ? "resume" : "new", key: attempt.sessionId },
    report,
    // exec writes its outputs to the artifacts dir, outside the repository it runs in.
    addDirs: brief.mode === "exec" ? [...brief.addDirs, workspace.artifactsDir] : brief.addDirs,
    ...(brief.budgetUsd === undefined ? {} : { budgetUsd: brief.budgetUsd }),
    passEnv: passEnv(deps, job),
    timeoutMs: brief.timeoutMs,
    logPath: deps.store.paths(job.id).attemptLog(attempt.n),
  };
}

const ACCESS: Readonly<Record<Brief["mode"], Access>> = { edit: "write", exec: "exec", readonly: "readonly" };

/** Where the worker and the gates run: the job's worktree (edit) or the repository itself. */
export function workspaceDir(job: Job): string {
  return job.workspace.worktree ?? job.workspace.repoRoot;
}

/** The brief's env names with their values from the orchestrator's environment (never persisted), plus the provider's
 *  artifacts variable. */
export function passEnv(deps: Deps, job: Job): Readonly<Record<string, string>> {
  const named = job.brief.env.flatMap((name) => {
    const value = deps.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(named), [deps.provider.artifactsEnv]: job.workspace.artifactsDir };
}
