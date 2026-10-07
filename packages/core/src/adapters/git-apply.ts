import { rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../domain/result.ts";
import type { GitError } from "../ports/index.ts";
import { parseNameStatus, unmergedPaths } from "./git-parse.ts";
import { gitError, gitText, gitVoid, runGit } from "./git-run.ts";
import { snapshotTree, withTempIndex } from "./git-snapshot.ts";
import { blockingPaths } from "./git-status.ts";

/** Removes a deleted file and the directories it leaves empty, as git would. */
async function removeFile(repo: string, path: string): Promise<void> {
  await rm(join(repo, path), { force: true });
  for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
    const removed = await rmdir(join(repo, dir)).then(
      () => true,
      () => false,
    );
    if (!removed) return;
  }
}

type Env = Readonly<Record<string, string>>;

/** 3-way applies the patch to the (private) index in env; conflicts come back with their paths. */
async function mergeIntoIndex(repo: string, patch: Buffer, env: Env): Promise<Result<void, GitError>> {
  const args = ["apply", "--cached", "--3way", "--whitespace=nowarn"];
  const applied = await runGit(repo, args, { input: patch, env });
  if (applied.ok) return ok(undefined);
  const unmerged = await gitText(repo, ["ls-files", "--unmerged", "-z"], { env });
  const paths = unmerged.ok ? unmergedPaths(unmerged.value) : [];
  return err(paths.length > 0 ? { kind: "conflict", paths } : gitError(repo, args, applied));
}

/** Writes the merged files from the index in env to repo's working tree, and removes the deleted ones. */
async function writeMerged(
  repo: string,
  written: readonly string[],
  deleted: readonly string[],
  env: Env,
): Promise<Result<void, GitError>> {
  if (written.length > 0) {
    const input = `${written.join("\0")}\0`;
    const checkedOut = await gitVoid(repo, ["checkout-index", "--force", "-z", "--stdin"], { input, env });
    if (!checkedOut.ok) return checkedOut;
  }
  for (const path of deleted) await removeFile(repo, path);
  return ok(undefined);
}

/**
 * Applies the worktree's change set (everything `add -A` would see, against baseSha) to repo's working tree only.
 * The 3-way merge runs first in a private copy of repo's index, so a conflict leaves repo untouched; the merged files
 * are then written with `checkout-index` from that copy, so repo's own index (what the user has staged) never changes.
 */
export async function applyToWorkingTree(
  repo: string,
  worktree: string,
  baseSha: string,
  provider: string,
): Promise<Result<void, GitError>> {
  const tree = await snapshotTree(worktree, provider);
  if (!tree.ok) return tree;
  const range = ["--no-renames", "--end-of-options", baseSha, tree.value, "--"];
  // Diffs run in the worktree (proven a repository by the snapshot; objects are shared with repo): outside a
  // repository `git diff` would fall back to --no-index.
  const listed = await gitText(worktree, ["diff", "--name-status", "-z", ...range]);
  if (!listed.ok) return listed;
  const { added, modified, deleted } = parseNameStatus(listed.value);
  const written = [...added, ...modified];
  if (written.length + deleted.length === 0) return ok(undefined);

  const blocked = await blockingPaths(repo, [...written, ...deleted], { stagedAnywhere: false });
  if (!blocked.ok) return blocked;
  if (blocked.value.length > 0) return err({ kind: "dirty", paths: blocked.value });

  const patchArgs = ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", ...range];
  const patch = await runGit(worktree, patchArgs);
  if (!patch.ok) return err(gitError(worktree, patchArgs, patch));

  return withTempIndex(repo, provider, async (env) => {
    const merged = await mergeIntoIndex(repo, patch.stdout, env);
    return merged.ok ? writeMerged(repo, written, deleted, env) : merged;
  });
}
