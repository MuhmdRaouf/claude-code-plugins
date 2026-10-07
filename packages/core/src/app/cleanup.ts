import { resolve } from "node:path";
import type { Job } from "../domain/job.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { Deps } from "./deps.ts";
import { reapOrphanEngines } from "./engine-reap.ts";

const TERMINAL: ReadonlySet<Job["state"]> = new Set(["accepted", "discarded"]);

/**
 * Removes what a previous run left behind: the worktrees and branches of decided jobs whose removal failed, the
 * temporary checkouts of interrupted accepts, and engine processes whose driver died. Best effort and silent — a failed cleanup never blocks the command — and
 * it touches only the plugin's own directories (its state root) and branch prefix, never anything of the user's.
 */
export async function cleanupWorkspace(deps: Deps): Promise<void> {
  try {
    const jobs = await deps.store.list();
    const decided = jobs.filter((job) => TERMINAL.has(job.state));
    await Promise.all(decided.map((job) => removeWorkspaceIfLeft(deps, job)));
    await removeLeftoverCheckouts(deps);
    await reapOrphanEngines(deps, jobs);
  } catch {
    // Nothing cleanup reports is worth a failing command.
  }
}

/** A decided job's worktree is normally removed by the decision itself; this catches the one that outlived it. */
async function removeWorkspaceIfLeft(deps: Deps, job: Job): Promise<void> {
  const { repoRoot, worktree, branch } = job.workspace;
  if (worktree === undefined || branch === undefined || !deps.files.exists(worktree)) return;
  if (resolve(worktree) !== stateLayout(deps.host.stateRoot).job(job.id).worktree) return;
  if (!branch.startsWith(deps.provider.branchPrefix)) return;
  await deps.git.removeWorktree(repoRoot, worktree, branch);
}

/** Checkout directories are named by job id, and one only exists while an accept holds the job's lock. So the lock
 *  settles each: held means an accept may be in flight (skip), acquirable or a job that no longer exists means the
 *  checkout is a leftover nobody is coming back for. */
async function removeLeftoverCheckouts(deps: Deps): Promise<void> {
  for (const id of deps.files.checkoutIds()) {
    const checkout = deps.store.paths(id).checkout;
    if (!deps.files.exists(checkout)) continue;
    const lock = await deps.store.lock(id, process.pid);
    if (lock.ok) {
      try {
        await removeCheckout(deps, checkout);
      } finally {
        await lock.value();
      }
    } else if (lock.error.kind === "not_found") {
      await removeCheckout(deps, checkout);
    }
  }
}

/** Removes one leftover checkout: its worktree registration, when the repository that holds it can still be found,
 *  then whatever is left on disk. */
async function removeCheckout(deps: Deps, checkout: string): Promise<void> {
  const repoRoot = deps.files.checkoutRepo(checkout);
  if (repoRoot !== undefined) await deps.git.removeDetachedWorktree(repoRoot, checkout);
  deps.files.removeTree(checkout);
}
