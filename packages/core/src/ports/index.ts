/**
 * Ports: the only way app/ touches the world. Adapters implement them; tests use the fakes in test/support/.
 * Expected failures are Result values; adapters never decide policy.
 */
import type { Priority } from "../domain/brief.ts";
import type { EngineConfig } from "../domain/engine.ts";
import type { ChangeSet, GateResult, Job } from "../domain/job.ts";
import type { Result } from "../domain/result.ts";
import type { SpoolEvent } from "../domain/route-events.ts";
import type { JobPaths } from "../domain/state-layout.ts";
import type { Progress } from "../domain/worker-events.ts";

export type {
  Access,
  ReportContract,
  Worker,
  WorkerCapabilities,
  WorkerError,
  WorkerExit,
  WorkerRun,
  WorkerSpec,
} from "./worker.ts";

// ── git ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type GitError =
  | { readonly kind: "not_a_repo"; readonly path: string }
  | { readonly kind: "bad_ref"; readonly ref: string }
  | { readonly kind: "conflict"; readonly paths: readonly string[] }
  | { readonly kind: "dirty"; readonly paths: readonly string[] }
  | { readonly kind: "git_failed"; readonly command: string; readonly stderr: string };

export interface Git {
  root(cwd: string): Promise<Result<string, GitError>>;
  resolve(repo: string, ref: string): Promise<Result<string, GitError>>;
  currentBranch(repo: string): Promise<Result<string, GitError>>;
  addWorktree(repo: string, path: string, branch: string, baseSha: string): Promise<Result<void, GitError>>;
  removeWorktree(repo: string, path: string, branch: string): Promise<Result<void, GitError>>;
  /** Changes in `dir` relative to baseSha, including untracked files (renames as delete+add). */
  changes(dir: string, baseSha: string): Promise<Result<ChangeSet, GitError>>;
  /** `git status --porcelain=v1 -z` fingerprint, for exec/readonly unchanged checks. */
  statusFingerprint(dir: string): Promise<Result<string, GitError>>;
  diff(dir: string, baseSha: string, opts: { readonly stat: boolean }): Promise<Result<string, GitError>>;
  /** Stage everything in the worktree and commit on its branch. Returns the commit sha. The repository's commit hooks
   *  run unless verify is false; a failing hook is git_failed carrying the hook's output. */
  commitAll(
    dir: string,
    message: string,
    opts: { readonly verify: boolean },
  ): Promise<Result<string, GitError>>;
  /** The repository's `<provider>.trailer` setting: worked-by (the default) or none. */
  trailer(repo: string): Promise<Result<"worked-by" | "none", GitError>>;
  isAncestor(repo: string, ancestor: string, descendant: string): Promise<Result<boolean, GitError>>;
  /** Rebase the job branch checked out in `worktree` onto `onto`. Conflicts confined to the `regenerate` globs are
   *  settled by taking `onto`'s side (the file is recreated before landing anyway); any other conflict aborts the
   *  rebase and reports the unmerged paths, leaving the branch exactly as it was. */
  rebaseJobBranch(
    worktree: string,
    onto: string,
    regenerate: readonly string[],
  ): Promise<Result<void, GitError>>;
  /** Stage everything in `dir` and amend it into HEAD; returns the amended commit's sha. */
  amendAll(dir: string, opts: { readonly verify: boolean }): Promise<Result<string, GitError>>;
  /** A detached temporary checkout of `sha` at `path`, for verifying a commit exactly as it lands. */
  addDetachedWorktree(repo: string, path: string, sha: string): Promise<Result<void, GitError>>;
  removeDetachedWorktree(repo: string, path: string): Promise<Result<void, GitError>>;
  /** `git merge --ff-only <sha>` in repo, but only onto the tip the caller last saw: "moved" when it changed
   *  meanwhile, dirty when uncommitted files overlap the change set. */
  fastForward(repo: string, sha: string, expectedTip: string): Promise<Result<"landed" | "moved", GitError>>;
  /** Apply the worktree's change set to repo's working tree without committing (3-way). */
  applyToWorkingTree(repo: string, worktree: string, baseSha: string): Promise<Result<void, GitError>>;
}

// ── gates ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface GateRunner {
  /** Runs `sh -c <run>` in cwd with a minimal env (+ passEnv), bounded output tail, kill on timeout. */
  run(
    cwd: string,
    gate: { readonly run: string; readonly timeoutMs: number },
    passEnv: Readonly<Record<string, string>>,
    logPath: string,
  ): Promise<GateResult>;
}

// ── storage ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type StoreError =
  | { readonly kind: "not_found"; readonly id: string }
  | {
      readonly kind: "version_conflict";
      readonly id: string;
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly kind: "locked"; readonly id: string; readonly holderPid: number }
  | { readonly kind: "io"; readonly message: string };

export interface JobStore {
  create(job: Job): Promise<Result<Job, StoreError>>;
  get(id: string): Promise<Result<Job, StoreError>>;
  /** Resolves a unique id prefix too. */
  find(idOrPrefix: string): Promise<Result<Job, StoreError>>;
  /** Writes only if stored version === job.version; returns the job with version + 1. */
  update(job: Job): Promise<Result<Job, StoreError>>;
  list(filter?: { readonly repoRoot?: string }): Promise<readonly Job[]>;
  paths(id: string): JobPaths;
  /** Exclusive driver lock (atomic create, stale-pid reclaim). */
  lock(id: string, pid: number): Promise<Result<() => Promise<void>, StoreError>>;
}

export interface Semaphore {
  /** Enqueues the holder at `priority` and waits until fewer than capacity() slots are held and no older ticket of a
   *  higher priority does; returns a release function. */
  acquire(
    holder: { readonly jobId: string; readonly pid: number; readonly priority: Priority },
    signal?: AbortSignal,
  ): Promise<() => Promise<void>>;
  held(): Promise<readonly { readonly jobId: string; readonly pid: number }[]>;
}

/** Shared AIMD state (file-backed, locked read-modify-write). */
export interface LimiterStore {
  /** The current cap, ticking it up after a quiet period (call only while waiting for a slot). */
  capacity(now: number): Promise<number>;
  /** The cap and the ceiling it grows back towards, without ticking. */
  limit(now: number): Promise<{ readonly cap: number; readonly max: number }>;
  rateLimited(now: number, options?: { readonly endedAttempt?: boolean }): Promise<void>;
  /** Persists the ceiling, clamping the cap down to it but never up. */
  saveMax(max: number, now: number): Promise<void>;
}

/** The files a job keeps beside its record and the ones it names (its report schema): the stop request, the driver's
 *  progress snapshot, the driver lock's holder, the engine's process group, the brief, the attempt logs as text, and
 *  the accepts' leftover checkouts. Bound to one state root. */
export interface JobFiles {
  /** The brief as submitted, with the job's (empty) artifacts directory beside it. */
  writeBrief(paths: JobPaths, text: string): Promise<void>;
  requestStop(paths: JobPaths): Promise<void>;
  stopRequested(paths: JobPaths): Promise<boolean>;
  clearStop(paths: JobPaths): Promise<void>;
  writeProgress(paths: JobPaths, attempt: number, progress: Progress): Promise<void>;
  /** The driver's latest snapshot for `attempt`; undefined when there is none or it belongs to another attempt. */
  readProgress(paths: JobPaths, attempt: number): Promise<Progress | undefined>;
  /** A file's text (an attempt log, a report schema), or why it cannot be read. */
  readText(path: string): Promise<Result<string, string>>;
  /** The pid in the driver lock file, if one is held. */
  driverPid(paths: JobPaths): Promise<number | undefined>;
  /** The running engine's group leader, if the job has one. */
  enginePid(paths: JobPaths): number | undefined;
  clearEnginePid(paths: JobPaths): void;
  /** The job ids that have an accept checkout on disk. */
  checkoutIds(): readonly string[];
  /** The repository a detached checkout belongs to, read from its `.git` file. */
  checkoutRepo(checkout: string): string | undefined;
  exists(path: string): boolean;
  /** Removes a directory tree; a missing one is fine. */
  removeTree(path: string): void;
}

/** Which delegation engines are enabled and who watches each (the state root's `engines.json`). */
export interface EngineConfigStore {
  read(): EngineConfig;
  write(config: EngineConfig): void;
}

/** What the routers wrote to Radar's spool over the last `days` calendar days up to `now`. */
export interface RouteSpool {
  events(now: Date, days: number): readonly SpoolEvent[];
}

// ── small things ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Clock {
  now(): number;
  iso(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Ids {
  jobId(): string;
  sessionId(): string;
}

export interface ProcessControl {
  isAlive(pid: number): boolean;
  /** SIGTERM the process group, SIGKILL after graceMs. */
  terminateGroup(pid: number, graceMs: number): Promise<void>;
  /** Start `<cli> drive <id>` as an orphaned process-group leader (outside the caller's process tree); returns its pid. */
  spawnDriver(jobId: string): number;
}

export interface Output {
  line(text: string): void;
  error(text: string): void;
}
