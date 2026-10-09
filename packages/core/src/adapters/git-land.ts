import { existsSync } from "node:fs";
import { resolve } from "node:path";
import picomatch from "picomatch";
import { err, ok, type Result } from "../domain/result.ts";
import type { GitError } from "../ports/index.ts";
import { splitNul } from "./git-parse.ts";
import { gitError, gitText, gitValue, gitVoid, runGit } from "./git-run.ts";
import { blockingPaths } from "./git-status.ts";

/** A rebase that keeps stopping has gone wrong; the job branch is not that long. */
const MAX_REBASE_ROUNDS = 50;

/** The repository's `<provider>.trailer`: worked-by unless set to none (an unknown value is an error, not a guess). */
export async function readTrailer(
  provider: string,
  repo: string,
): Promise<Result<"worked-by" | "none", GitError>> {
  const args = ["config", "--get", `${provider}.trailer`];
  const run = await runGit(repo, args);
  if (run.ok) {
    const value = run.stdout.toString("utf8").trim();
    if (value === "" || value === "worked-by") return ok("worked-by");
    if (value === "none") return ok("none");
    return err({
      kind: "git_failed",
      command: `git ${args.join(" ")}`,
      stderr: `"${value}" is not worked-by or none`,
    });
  }
  // An unset key is git's quiet exit 1 (runGit pads stderr with the spawn error); anything else is a real failure.
  if (run.code === 1) return ok("worked-by");
  return err(gitError(repo, args, run));
}

export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<Result<boolean, GitError>> {
  const args = ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant];
  const run = await runGit(repo, args);
  if (run.ok) return ok(true);
  // "Not an ancestor" is git's quiet exit 1; a bad ref or a broken repo exits 128 with a message.
  if (run.code === 1) return ok(false);
  return err(gitError(repo, args, run));
}

/** A stopped rebase leaves `rebase-merge` (merge backend) or `rebase-apply` (apply backend) in the git dir. */
async function rebaseInProgress(worktree: string): Promise<Result<boolean, GitError>> {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const path = await gitValue(worktree, ["rev-parse", "--git-path", state]);
    if (!path.ok) return path;
    if (existsSync(resolve(worktree, path.value))) return ok(true);
  }
  return ok(false);
}

/** Aborts a stopped rebase: the job branch goes back where it was, nothing applied. */
function abortRebase(worktree: string): Promise<Result<void, GitError>> {
  return gitVoid(worktree, ["rebase", "--abort"]);
}

/** Rebases the job branch checked out in `worktree` onto `onto`. A conflict outside the `regenerate` globs aborts
 *  the rebase and reports every unmerged path; conflicts inside them take `onto`'s side (ours, mid-rebase) and carry
 *  on, since the file is regenerated before landing anyway. */
export async function rebaseJobBranch(
  worktree: string,
  onto: string,
  regenerate: readonly string[],
): Promise<Result<void, GitError>> {
  const args = ["rebase", "--quiet", "--end-of-options", onto];
  const isRegenerated = picomatch([...regenerate], { dot: true });
  for (let round = 0; round < MAX_REBASE_ROUNDS; round++) {
    // Running the rebase again while it is stopped fails harmlessly; the round then continues it.
    const step = await advanceRebase(worktree, args, isRegenerated);
    if (step.ok && step.value === "finished") return ok(undefined);
    if (!step.ok) return step;
  }
  return err({
    kind: "git_failed",
    command: `git ${args.join(" ")}`,
    stderr: `still reporting conflicts after ${MAX_REBASE_ROUNDS} commits`,
  });
}

/** One round: run the rebase and, when it stops on conflicts, settle the stop and continue it. An error ends the
 *  rebase for good — except a continue that stopped again, which asks for one more round. */
async function advanceRebase(
  worktree: string,
  args: readonly string[],
  isRegenerated: (path: string) => boolean,
): Promise<Result<"finished" | "stopped-again", GitError>> {
  const rebase = await runGit(worktree, args);
  if (rebase.ok) return ok("finished");
  const stopped = await rebaseInProgress(worktree);
  if (!stopped.ok) return stopped;
  if (!stopped.value) return err(gitError(worktree, args, rebase));
  const classified = await resolveConflicts(worktree, isRegenerated);
  if (!classified.ok) return classified;
  if (classified.value !== undefined) return err(classified.value);
  // Continuing may stop again on the next job commit; the caller classifies each stop the same way.
  const continued = await runGit(worktree, ["rebase", "--continue"]);
  return ok(continued.ok ? "finished" : "stopped-again");
}

/** Settles one stopped rebase: the error to fail with, or undefined when it resolved cleanly and the rebase continues.
 *  `worktree`'s branch is back where it was by the time an error leaves here. */
async function resolveConflicts(
  worktree: string,
  isRegenerated: (path: string) => boolean,
): Promise<Result<GitError | undefined, GitError>> {
  const unmerged = await gitText(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (!unmerged.ok) return unmerged;
  const paths = splitNul(unmerged.value);
  if (paths.some((path) => !isRegenerated(path))) {
    const aborted = await abortRebase(worktree);
    return aborted.ok ? ok({ kind: "conflict", paths }) : aborted;
  }
  for (const path of paths) {
    const settled = await settleRegenerated(worktree, path);
    if (!settled.ok) return settled;
  }
  return ok(undefined);
}

/** Takes the tip's side (ours, mid-rebase) for one regenerated path and stages it; the error to fail with, the rebase
 *  already aborted unless the abort itself failed. */
async function settleRegenerated(worktree: string, path: string): Promise<Result<void, GitError>> {
  const failure = await takeTipSide(worktree, path);
  if (failure === undefined) return ok(undefined);
  const aborted = await abortRebase(worktree);
  return aborted.ok ? err(failure) : aborted;
}

/** The error that stopped this path, or undefined when its conflict was settled and staged. */
async function takeTipSide(worktree: string, path: string): Promise<GitError | undefined> {
  const args = ["checkout", "--ours", "--", path];
  const taken = await runGit(worktree, args);
  if (!taken.ok) return gitError(worktree, args, taken);
  const added = await gitVoid(worktree, ["add", "--", path]);
  return added.ok ? undefined : added.error;
}

/** Stage everything in `dir` and amend it into HEAD; returns the amended commit's sha. */
export async function amendAll(
  dir: string,
  opts: { readonly verify: boolean },
): Promise<Result<string, GitError>> {
  const staged = await gitVoid(dir, ["add", "-A"]);
  if (!staged.ok) return staged;
  const verify = opts.verify ? [] : ["--no-verify"];
  const amended = await gitVoid(dir, [
    "commit",
    "--quiet",
    ...verify,
    "--amend",
    "--no-edit",
    "--cleanup=whitespace",
  ]);
  return amended.ok ? headSha(dir) : amended;
}

async function headSha(dir: string): Promise<Result<string, GitError>> {
  return gitValue(dir, ["rev-parse", "--verify", "HEAD"]);
}

export async function addDetachedWorktree(
  repo: string,
  path: string,
  sha: string,
): Promise<Result<void, GitError>> {
  // Registrations of removed checkouts would make git refuse the path.
  const pruned = await gitVoid(repo, ["worktree", "prune"]);
  if (!pruned.ok) return pruned;
  return gitVoid(repo, ["worktree", "add", "--quiet", "--detach", "--", path, sha]);
}

export async function removeDetachedWorktree(repo: string, path: string): Promise<Result<void, GitError>> {
  const removed = await gitVoid(repo, ["worktree", "remove", "--force", "--force", "--", path]);
  // Already gone on disk: only the stale registration is left to prune.
  if (!removed.ok && existsSync(path)) return removed;
  return gitVoid(repo, ["worktree", "prune"]);
}

/** Fast-forwards repo's current branch to `sha`, but only onto the tip the caller last saw as `expectedTip`: the tip
 *  moving meanwhile is "moved", not a failure. Refuses up front (dirty) when uncommitted files overlap the change set,
 *  since git would refuse too, less precisely. */
export async function fastForward(
  repo: string,
  sha: string,
  expectedTip: string,
): Promise<Result<"landed" | "moved", GitError>> {
  const tip = await headSha(repo);
  if (!tip.ok) return tip;
  if (tip.value !== expectedTip) return ok("moved");
  const touched = await gitText(repo, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--end-of-options",
    expectedTip,
    sha,
    "--",
  ]);
  if (!touched.ok) return touched;
  const blocked = await blockingPaths(repo, splitNul(touched.value), { stagedAnywhere: false });
  if (!blocked.ok) return blocked;
  if (blocked.value.length > 0) return err({ kind: "dirty", paths: blocked.value });

  const args = ["merge", "--quiet", "--ff-only", "--end-of-options", sha];
  const merged = await runGit(repo, args);
  if (merged.ok) return ok("landed");
  // The merge raced with a commit that moved the tip; anything else is a real failure.
  const after = await headSha(repo);
  return after.ok && after.value !== expectedTip ? ok("moved") : err(gitError(repo, args, merged));
}
