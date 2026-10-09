// The on-disk contract: every file and directory a plugin keeps under its state root, named once. Nothing else in the
// codebase spells a state file's name; the router's uninstall cleanup and the setup ledger read the same names here.
// Pure paths (node:path only), so the ensure hook and the emergency passthrough may use it without pulling more in.
import { dirname, join } from "node:path";

/** One job's files: its directory under `jobs/`, the sidecars beside job.json, and its worktree. */
export interface JobPaths {
  readonly dir: string;
  /** The job record, written only by the job store. */
  readonly record: string;
  readonly brief: string;
  readonly artifacts: string;
  attemptLog(n: number): string;
  gateLog(n: number, gate: number): string;
  /** A brief's `regenerate` rule's output while landing, and a gate's in the landing check. */
  regenerateLog(n: number): string;
  landCheckLog(n: number): string;
  /** The detached driver's stdout and stderr. */
  readonly driverLog: string;
  /** Present while a stop was requested and not yet acted on. */
  readonly stop: string;
  /** The driver's progress snapshot, for readers that are not the driver. */
  readonly progress: string;
  /** Held by the job's driver; holds its pid. */
  readonly driverLock: string;
  /** The delegation engine's process group leader, while it runs. */
  readonly enginePid: string;
  readonly worktree: string;
  /** The fresh detached checkout an accept verifies the commit to land in; it exists only while the accept runs. */
  readonly checkout: string;
}

export interface StateLayout {
  readonly root: string;
  /** Setup ran (and was not removed); the hooks act only once it exists. */
  readonly setupDone: string;
  /** The `route: provider` mark an older install carries in place of `setup-done`; read, then removed. */
  readonly legacyRouteMark: string;
  /** Which delegation engines are enabled and who watches each. */
  readonly engines: string;
  /** Every change setup made outside the plugin, so the router can undo exactly those on uninstall. */
  readonly ledger: string;
  /** The ledger of a disabled plugin, kept for its re-enable. */
  readonly disabledLedger: string;
  /** The router's copied bundles, its package.json and its log. */
  readonly routerDir: string;
  readonly routerLog: string;
  /** What the starter knows about the running router (pid, port, version, control token). */
  readonly routerPid: string;
  /** The retired router's pid record, moved here from `routerPid` when setup --remove retires it: the hooks then
   *  treat the plugin as not set up, and a later setup still finds the token to take the port over. */
  readonly routerRetired: string;
  /** Held by whoever is starting or stopping the router. */
  readonly routerLock: string;
  /** Why the router last crashed, appended and rotated. */
  readonly crashLog: string;
  /** What an uninstall could not remove, for the user to read. */
  readonly leftBehind: string;
  /** The CLAUDE_CONFIG_DIR the claude worker runs with. */
  readonly claudeHome: string;
  /** The adaptive concurrency limiter's shared state. */
  readonly limiter: string;
  /** The semaphore's slot and ticket files. */
  readonly slots: string;
  readonly jobs: string;
  /** The accepts' temporary checkouts, one per job id. */
  readonly checkouts: string;
  job(id: string): JobPaths;
}

const ENGINE_PID = "engine.pid";

/** The job's engine.pid, found from one of its attempt logs (a worker knows its log, not its job). */
export function enginePidBeside(attemptLog: string): string {
  return join(dirname(attemptLog), ENGINE_PID);
}

export function stateLayout(root: string): StateLayout {
  const routerDir = join(root, "router");
  const jobs = join(root, "jobs");
  const checkouts = join(root, "checkouts");
  return {
    root,
    setupDone: join(root, "setup-done"),
    legacyRouteMark: join(root, "route"),
    engines: join(root, "engines.json"),
    ledger: join(root, "ledger.json"),
    disabledLedger: join(root, "ledger.disabled.json"),
    routerDir,
    routerLog: join(routerDir, "router.log"),
    routerPid: join(root, "router.pid"),
    routerRetired: join(root, "router.retired"),
    routerLock: join(root, "router.lock"),
    crashLog: join(root, "router-crash.log"),
    leftBehind: join(root, "LEFT-BEHIND.md"),
    claudeHome: join(root, "claude-home"),
    limiter: join(root, "limiter.json"),
    slots: join(root, "slots"),
    jobs,
    checkouts,
    job(id) {
      const dir = join(jobs, id);
      return {
        dir,
        record: join(dir, "job.json"),
        brief: join(dir, "brief.md"),
        artifacts: join(dir, "artifacts"),
        attemptLog: (n) => join(dir, `attempt-${n}.jsonl`),
        gateLog: (n, gate) => join(dir, `gate-${n}-${gate}.log`),
        regenerateLog: (n) => join(dir, `regenerate-${n}.log`),
        landCheckLog: (n) => join(dir, `land-check-${n}.log`),
        driverLog: join(dir, "driver.log"),
        stop: join(dir, "stop"),
        progress: join(dir, "progress.json"),
        driverLock: join(dir, "driver.lock"),
        enginePid: join(dir, ENGINE_PID),
        worktree: join(root, "worktrees", id),
        checkout: join(checkouts, id),
      };
    },
  };
}
