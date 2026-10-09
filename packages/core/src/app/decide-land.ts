import { DEFAULT_GATE_TIMEOUT_MS } from "../domain/brief-defaults.ts";
import type { Job } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { changedPaths, gateFailed } from "../domain/verify.ts";
import type { GitError } from "../ports/index.ts";
import type { Deps } from "./deps.ts";
import { passEnv } from "./drive-run.ts";
import { runSetupAndGates } from "./drive-verify.ts";
import { type AppError, describeGitError } from "./errors.ts";
import { reportFacts } from "./report-facts.ts";

export type AcceptMode = "commit" | "no_commit";

/** The branch tip moving between verification and landing is rare; a third try is not worth waiting for. */
const MAX_TIP_ROUNDS = 3;

const gitError = (error: GitError): Result<never, AppError> => err({ kind: "git", error });

/**
 * Lands an edit job's change set in its repository; returns the commit landed (commit mode) if one was made.
 * commit: commits whatever is not yet committed on the job branch, then — while the repository's branch tip has moved
 * past the job's base — rebases the job branch onto it (regenerate paths settled by taking the tip's side), runs the
 * regenerate commands and amends what they change, verifies the exact commit (setup, then gates) in a fresh detached
 * checkout, and fast-forwards the repository's branch onto it; the tip moving meanwhile restarts the round.
 * no_commit: applies the change set to the working tree. exec/readonly jobs have nothing to land.
 */
export async function land(
  deps: Deps,
  job: Job,
  opts: { readonly mode: AcceptMode; readonly verify: boolean },
): Promise<Result<string | undefined, AppError>> {
  const { repoRoot, worktree, baseSha } = job.workspace;
  if (worktree === undefined) return ok(undefined);
  if (opts.mode === "no_commit") {
    const applied = await deps.git.applyToWorkingTree(repoRoot, worktree, baseSha);
    return applied.ok ? ok(undefined) : gitError(applied.error);
  }
  const trailer = await deps.git.trailer(repoRoot);
  if (!trailer.ok) return gitError(trailer.error);
  const committed = await commitPending(deps, job, worktree, opts.verify, trailer.value);
  if (!committed.ok) return committed;

  for (let round = 0; round < MAX_TIP_ROUNDS; round++) {
    const outcome = await landRound(deps, job, worktree, opts);
    if (!outcome.ok) return outcome;
    if (!("retry" in outcome.value)) return ok(outcome.value.landed);
  }
  return gitError({
    kind: "git_failed",
    command: "git merge --ff-only",
    stderr: `the branch tip moved ${MAX_TIP_ROUNDS} times while landing; try again`,
  });
}

/** One round's outcome: the commit that landed (or undefined for an empty change set), or a retry. */
type RoundOutcome = { readonly landed: string | undefined } | { readonly retry: true };

/** One round of the tip loop: bring the job branch onto the tip if it moved, regenerate, verify the exact commit in a
 *  fresh checkout, then fast-forward the branch onto it; a tip that moved meanwhile asks for another round. */
async function landRound(
  deps: Deps,
  job: Job,
  worktree: string,
  opts: { readonly verify: boolean },
): Promise<Result<RoundOutcome, AppError>> {
  const { repoRoot } = job.workspace;
  const head = await headToLand(deps, job, worktree);
  if (!head.ok) return head;
  if ("settled" in head.value) return ok({ landed: head.value.settled });
  const { toLand, tip } = head.value;
  const regenerated = await regenerate(deps, job, worktree, toLand, opts.verify);
  if (!regenerated.ok) return regenerated;
  const verified = await verifyCommit(deps, job, regenerated.value);
  if (!verified.ok) return verified;
  const merged = await deps.git.fastForward(repoRoot, regenerated.value, tip);
  if (!merged.ok) return gitError(merged.error);
  // The branch tip moved while the commit was being verified: the next round rebases onto the new tip instead.
  return ok(merged.value === "landed" ? { landed: regenerated.value } : { retry: true });
}

/** Where the job branch stands against the repository tip: the commit this round would land, or a settled outcome —
 *  undefined when the change set is empty, or the branch's own head when a previous accept already landed it and only
 *  failed to record that. */
type HeadOutcome =
  | { readonly toLand: string; readonly tip: string }
  | { readonly settled: string | undefined };

async function headToLand(deps: Deps, job: Job, worktree: string): Promise<Result<HeadOutcome, AppError>> {
  const { repoRoot, baseSha } = job.workspace;
  const head = await deps.git.resolve(worktree, "HEAD");
  if (!head.ok) return gitError(head.error);
  if (head.value === baseSha) return ok({ settled: undefined });
  const tip = await deps.git.resolve(repoRoot, "HEAD");
  if (!tip.ok) return gitError(tip.error);
  if (head.value === tip.value) return ok({ settled: head.value });
  const ahead = await deps.git.isAncestor(worktree, tip.value, head.value);
  if (!ahead.ok) return gitError(ahead.error);
  if (ahead.value) return ok({ toLand: head.value, tip: tip.value });
  const rebased = await deps.git.rebaseJobBranch(
    worktree,
    tip.value,
    (job.brief.regenerate ?? []).flatMap((rule) => rule.paths),
  );
  if (!rebased.ok) {
    return rebased.error.kind === "conflict"
      ? err({ kind: "land_conflict", paths: rebased.error.paths })
      : gitError(rebased.error);
  }
  const after = await deps.git.resolve(worktree, "HEAD");
  if (!after.ok) return gitError(after.error);
  return ok({ toLand: after.value, tip: tip.value });
}

async function commitPending(
  deps: Deps,
  job: Job,
  worktree: string,
  verify: boolean,
  trailer: "worked-by" | "none",
): Promise<Result<void, AppError>> {
  const head = await deps.git.resolve(worktree, "HEAD");
  if (!head.ok) return gitError(head.error);
  const pending = await deps.git.changes(worktree, head.value);
  if (!pending.ok) return gitError(pending.error);
  if (changedPaths(pending.value).length === 0) return ok(undefined);
  const commit = await deps.git.commitAll(worktree, commitMessage(deps.provider, job, trailer), { verify });
  return commit.ok ? ok(undefined) : gitError(commit.error);
}

/** Runs every regenerate rule in the worktree and amends what changed into the job's last commit. */
async function regenerate(
  deps: Deps,
  job: Job,
  worktree: string,
  commit: string,
  verify: boolean,
): Promise<Result<string, AppError>> {
  const paths = deps.store.paths(job.id);
  const env = passEnv(deps, job);
  for (const [i, rule] of (job.brief.regenerate ?? []).entries()) {
    const result = await deps.gates.run(
      worktree,
      { run: rule.run, timeoutMs: DEFAULT_GATE_TIMEOUT_MS },
      env,
      paths.regenerateLog(i),
    );
    if (gateFailed(result))
      return err({ kind: "land_verify_failed", command: result.run, tail: result.tail });
  }
  const changed = await deps.git.changes(worktree, commit);
  if (!changed.ok) return gitError(changed.error);
  if (changedPaths(changed.value).length === 0) return ok(commit);
  const amended = await deps.git.amendAll(worktree, { verify });
  return amended.ok ? ok(amended.value) : gitError(amended.error);
}

/** Verifies the exact commit to land in a fresh detached checkout: the brief's setup, then every gate. A checkout that
 *  is not this commit's could pass for other reasons, so only this one is trusted; either way it is removed. */
async function verifyCommit(deps: Deps, job: Job, commit: string): Promise<Result<void, AppError>> {
  if ((job.brief.setup ?? []).length === 0 && job.brief.gates.length === 0) return ok(undefined);
  const checkout = deps.store.paths(job.id).checkout;
  deps.files.removeTree(checkout);
  const added = await deps.git.addDetachedWorktree(job.workspace.repoRoot, checkout, commit);
  if (!added.ok) return gitError(added.error);
  try {
    const paths = deps.store.paths(job.id);
    const results = await runSetupAndGates(deps, job, checkout, (i) => paths.landCheckLog(i));
    const failed = results.find(gateFailed);
    return failed === undefined
      ? ok(undefined)
      : err({ kind: "land_verify_failed", command: failed.run, tail: failed.tail });
  } finally {
    // Always: a leftover checkout is exactly the kind of state a clean repository should not carry.
    const removed = await deps.git.removeDetachedWorktree(job.workspace.repoRoot, checkout);
    if (!removed.ok) {
      deps.out.error(
        `${deps.provider.name}: job ${job.id}: its temporary checkout could not be removed: ${describeGitError(removed.error)}`,
      );
    }
  }
}

/** Title, the report's summary, and — unless the repository sets `<provider>.trailer: none` — the trailer naming the
 *  model that did the work and the harness it ran in. */
function commitMessage(provider: Provider, job: Job, trailer: "worked-by" | "none"): string {
  const { summary } = reportFacts(job.attempts.at(-1)?.report);
  const workedBy =
    trailer === "none" ? [] : [`Worked-by: ${provider.catalog[job.brief.model].id} via ${provider.harness}`];
  return `${[job.brief.title, ...(summary === undefined ? [] : [summary]), ...workedBy].join("\n\n")}\n`;
}

/** Removes an edit job's worktree and branch once decided; a failure is reported, the decision stands. */
export async function removeWorkspace(deps: Deps, job: Job): Promise<void> {
  const { repoRoot, worktree, branch } = job.workspace;
  if (worktree === undefined || branch === undefined) return;
  const removed = await deps.git.removeWorktree(repoRoot, worktree, branch);
  if (!removed.ok) {
    deps.out.error(
      `${deps.provider.name}: job ${job.id} is ${job.state}, but its worktree could not be removed: ${describeGitError(removed.error)}`,
    );
  }
}
