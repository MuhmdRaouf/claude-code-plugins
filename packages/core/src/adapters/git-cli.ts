import { existsSync } from "node:fs";
import { err, ok, type Result } from "../domain/result.ts";
import type { Git, GitError } from "../ports/index.ts";
import { applyToWorkingTree } from "./git-apply.ts";
import { fingerprint } from "./git-fingerprint.ts";
import {
  addDetachedWorktree,
  amendAll,
  fastForward,
  isAncestor,
  readTrailer,
  rebaseJobBranch,
  removeDetachedWorktree,
} from "./git-land.ts";
import { parseNameStatus, parseStatus, splitNul } from "./git-parse.ts";
import { gitText, gitValue, gitVoid, runGit } from "./git-run.ts";
import { snapshotTree } from "./git-snapshot.ts";
import { STATUS_ARGS } from "./git-status.ts";

async function headSha(dir: string): Promise<Result<string, GitError>> {
  return gitValue(dir, ["rev-parse", "--verify", "HEAD"]);
}

/** `git` via runTool (no shell), `-c core.quotepath=off`, NUL-separated outputs. `provider` names its temp index dirs. */
export function createGitCli(provider: string): Git {
  return {
    async root(cwd) {
      const top = await gitValue(cwd, ["rev-parse", "--show-toplevel"]);
      return top.ok ? top : err({ kind: "not_a_repo", path: cwd });
    },
    async resolve(repo, ref) {
      const sha = await gitValue(repo, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${ref}^{commit}`,
      ]);
      return sha.ok || sha.error.kind === "not_a_repo" ? sha : err({ kind: "bad_ref", ref });
    },
    async currentBranch(repo) {
      const branch = await gitValue(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (branch.ok || branch.error.kind !== "git_failed") return branch;
      return err({ ...branch.error, stderr: "HEAD is detached" });
    },

    async addWorktree(repo, path, branch, baseSha) {
      return gitVoid(repo, ["worktree", "add", "--quiet", "-b", branch, "--", path, baseSha]);
    },

    async removeWorktree(repo, path, branch) {
      const removed = await gitVoid(repo, ["worktree", "remove", "--force", "--force", "--", path]);
      // Already gone (a retried discard, or deleted by hand): only the stale registration is left to prune.
      if (!removed.ok && existsSync(path)) return removed;
      const pruned = await gitVoid(repo, ["worktree", "prune"]);
      if (!pruned.ok) return pruned;
      const exists = await runGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return exists.ok ? gitVoid(repo, ["branch", "-D", "--", branch]) : ok(undefined);
    },
    async changes(dir, baseSha) {
      const [tracked, untracked] = await Promise.all([
        gitText(dir, ["diff", "--name-status", "-z", "--no-renames", "--end-of-options", baseSha, "--"]),
        gitText(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      // ls-files first: outside a repository `git diff` silently falls back to --no-index and fails confusingly.
      if (!untracked.ok) return untracked;
      if (!tracked.ok) return tracked;
      return ok({ ...parseNameStatus(tracked.value), untracked: splitNul(untracked.value).sort() });
    },
    async statusFingerprint(dir) {
      const [status, sha, ref] = await Promise.all([
        gitText(dir, STATUS_ARGS),
        runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]),
        runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]),
      ]);
      if (!status.ok) return status;
      const head = `${sha.ok ? sha.stdout.toString("utf8") : "unborn"}\0${ref.ok ? ref.stdout.toString("utf8") : "detached"}`;
      return ok(
        await fingerprint(
          dir,
          head,
          status.value,
          parseStatus(status.value).map((entry) => entry.path),
        ),
      );
    },
    async diff(dir, baseSha, opts) {
      const tree = await snapshotTree(dir, provider);
      if (!tree.ok) return tree;
      const format = opts.stat ? ["--stat=200"] : [];
      return gitText(dir, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        ...format,
        "--end-of-options",
        baseSha,
        tree.value,
        "--",
      ]);
    },
    async commitAll(dir, message, opts) {
      const staged = await gitVoid(dir, ["add", "-A"]);
      if (!staged.ok) return staged;
      // The repository's hooks run unless the caller opts out; a failing hook fails the commit with its output.
      // --cleanup=whitespace keeps `#` lines (markdown headings) in the message.
      const verify = opts.verify ? [] : ["--no-verify"];
      const commit = ["commit", "--quiet", ...verify, "--cleanup=whitespace", "--file=-"];
      const committed = await gitVoid(dir, commit, { input: message });
      return committed.ok ? headSha(dir) : committed;
    },
    trailer: (repo) => readTrailer(provider, repo),
    isAncestor,
    rebaseJobBranch,
    amendAll,
    addDetachedWorktree,
    removeDetachedWorktree,
    fastForward,
    applyToWorkingTree: (repo, worktree, baseSha) => applyToWorkingTree(repo, worktree, baseSha, provider),
  };
}
