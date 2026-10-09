import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createGitCli } from "../../src/adapters/git-cli.ts";
import { chompNewline, splitNul, unmergedPaths } from "../../src/adapters/git-parse.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import {
  git as gitSync,
  isolateGitConfig,
  makeRepo,
  repoAt,
  type TestRepo,
  tempDir,
} from "../support/tmp.ts";

const VERIFY = { verify: true } as const;

/** Points the repository at a hooks directory whose pre-commit hook prints and exits with `code`. */
function installPreCommit(repo: TestRepo, code: number): string {
  const hooks = join(tempDir(), "hooks");
  mkdirSync(hooks);
  const marker = join(hooks, "ran");
  writeFileSync(
    join(hooks, "pre-commit"),
    `#!/bin/sh\ntouch "${marker}"\necho "lint: 2 problems in README.md" >&2\nexit ${code}\n`,
    { mode: 0o755 },
  );
  repo.git("config", "core.hooksPath", hooks);
  return marker;
}

// Integration: every test builds a throwaway repo under os.tmpdir().
describe("git adapter", () => {
  beforeEach(() => {
    isolateGitConfig();
  });

  it("root resolves the top level from a subdirectory; not_a_repo outside one", async () => {
    const repo = makeRepo();
    const sub = join(repo.dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    const outside = tempDir();
    const git = createGitCli(REFERENCE_PROVIDER.name);

    expect(await git.root(sub)).toEqual({ ok: true, value: repo.dir });
    expect(await git.root(outside)).toEqual({ ok: false, error: { kind: "not_a_repo", path: outside } });
    expect(await git.root(join(outside, "missing"))).toEqual({
      ok: false,
      error: { kind: "not_a_repo", path: join(outside, "missing") },
    });
  });
  it("resolve returns the sha for HEAD/branch; bad_ref for nonsense", async () => {
    const repo = makeRepo();
    const head = repo.head();
    repo.git("branch", "feature");
    const git = createGitCli(REFERENCE_PROVIDER.name);

    expect(await git.resolve(repo.dir, "HEAD")).toEqual({ ok: true, value: head });
    expect(await git.resolve(repo.dir, "feature")).toEqual({ ok: true, value: head });
    expect(await git.resolve(repo.dir, head.slice(0, 8))).toEqual({ ok: true, value: head });
    for (const ref of ["no-such-branch", "--output=/tmp/x", "HEAD~5"]) {
      expect(await git.resolve(repo.dir, ref)).toEqual({ ok: false, error: { kind: "bad_ref", ref } });
    }
  });
  it("currentBranch names the checked-out branch; a detached HEAD is an error", async () => {
    const repo = makeRepo();
    const git = createGitCli(REFERENCE_PROVIDER.name);
    expect(await git.currentBranch(repo.dir)).toEqual({ ok: true, value: "main" });

    repo.git("switch", "-q", "--detach");
    const detached = await git.currentBranch(repo.dir);
    expect(detached.ok ? "ok" : detached.error.kind).toBe("git_failed");
  });

  it("addWorktree creates the worktree on a new branch at baseSha; removeWorktree removes both", async () => {
    const repo = makeRepo();
    const base = repo.head();
    repo.write("later.txt", "after base\n");
    repo.commitAll("later");
    const path = join(tempDir(), "nested dir", "wt-1");
    const git = createGitCli(REFERENCE_PROVIDER.name);

    expect(await git.addWorktree(repo.dir, path, "zai/job-1", base)).toEqual({ ok: true, value: undefined });
    expect(await git.resolve(path, "HEAD")).toEqual({ ok: true, value: base });
    expect(await git.currentBranch(path)).toEqual({ ok: true, value: "zai/job-1" });
    expect(existsSync(join(path, "later.txt"))).toBe(false);
    writeFileSync(join(path, "scratch.txt"), "uncommitted work\n");

    expect(await git.removeWorktree(repo.dir, path, "zai/job-1")).toEqual({ ok: true, value: undefined });
    expect(existsSync(path)).toBe(false);
    expect(repo.git("branch", "--list", "zai/job-1")).toBe("");
    expect(repo.git("worktree", "list", "--porcelain")).not.toContain("wt-1");
    // Removing again (e.g. a retried discard) is a no-op.
    expect(await git.removeWorktree(repo.dir, path, "zai/job-1")).toEqual({ ok: true, value: undefined });
  });

  it("addWorktree fails when the branch already exists", async () => {
    const repo = makeRepo();
    repo.git("branch", "zai/taken");
    const result = await createGitCli(REFERENCE_PROVIDER.name).addWorktree(
      repo.dir,
      join(tempDir(), "wt"),
      "zai/taken",
      repo.head(),
    );
    expect(result.ok ? "ok" : result.error.kind).toBe("git_failed");
  });
  it("changes lists added, modified, deleted and untracked paths against baseSha (rename = delete + add)", async () => {
    const repo = makeRepo();
    repo.write("src/keep.ts", "keep\n");
    repo.write("src/edit.ts", "v1\n");
    repo.write("src/gone.ts", "gone\n");
    repo.write("src/old-name.ts", "a file long enough to be detected as a rename by default\n");
    repo.write(".gitignore", "build/\n");
    const base = repo.commitAll("base");
    repo.write("src/edit.ts", "v2\n");
    repo.remove("src/gone.ts");
    repo.git("mv", "src/old-name.ts", "src/new-name.ts");
    repo.write("src/staged-new.ts", "new\n");
    repo.git("add", "src/staged-new.ts");
    repo.write("notes/untracked.md", "fresh\n");
    repo.write("build/out.js", "ignored\n");
    repo.git("config", "diff.renames", "copies");

    expect(await createGitCli(REFERENCE_PROVIDER.name).changes(repo.dir, base)).toEqual({
      ok: true,
      value: {
        added: ["src/new-name.ts", "src/staged-new.ts"],
        modified: ["src/edit.ts"],
        deleted: ["src/gone.ts", "src/old-name.ts"],
        untracked: ["notes/untracked.md"],
      },
    });
  });

  it("changes handles paths with spaces and unicode (NUL-separated parsing)", async () => {
    const repo = makeRepo();
    const odd = ["with space.txt", "ünïcødé/日本語.md", "tab\there.txt", "new\nline.txt", '"quoted".txt'];
    for (const path of odd) repo.write(path, "v1\n");
    const base = repo.commitAll("odd names");
    for (const path of odd) repo.write(path, "v2\n");
    repo.write("untracked dir/ça va?.txt", "x\n");

    expect(await createGitCli(REFERENCE_PROVIDER.name).changes(repo.dir, base)).toEqual({
      ok: true,
      value: { added: [], modified: [...odd].sort(), deleted: [], untracked: ["untracked dir/ça va?.txt"] },
    });
  });

  it("changes reports a bad base as an error", async () => {
    const repo = makeRepo();
    const result = await createGitCli(REFERENCE_PROVIDER.name).changes(repo.dir, "0".repeat(40));
    expect(result.ok ? "ok" : result.error.kind).toBe("git_failed");
  });
  it("statusFingerprint changes when a file changes and is stable otherwise", async () => {
    const repo = makeRepo();
    repo.write("dirty.txt", "v1\n");
    repo.write("gone.txt", "tracked\n");
    repo.commitAll("dirty");
    repo.write("dirty.txt", "v2\n");
    repo.write("scratch.txt", "s1\n");
    repo.remove("gone.txt");
    symlinkSync("dirty.txt", join(repo.dir, "link"));
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const fingerprint = async () => {
      const result = await git.statusFingerprint(repo.dir);
      if (!result.ok) throw new Error(result.error.kind);
      return result.value;
    };
    const before = await fingerprint();

    expect(await fingerprint()).toBe(before);
    // An already-modified file modified again keeps the same porcelain line: the content must still count.
    repo.write("dirty.txt", "v3\n");
    const edited = await fingerprint();
    expect(edited).not.toBe(before);
    repo.write("scratch.txt", "s2\n");
    const scratched = await fingerprint();
    expect(scratched).not.toBe(edited);
    repo.remove("link");
    symlinkSync("scratch.txt", join(repo.dir, "link"));
    const relinked = await fingerprint();
    expect(relinked).not.toBe(scratched);
    repo.write("dirty.txt", "v1\n");
    repo.write("gone.txt", "tracked\n");
    repo.remove("scratch.txt");
    repo.remove("link");
    const clean = await fingerprint();
    expect(clean).not.toBe(scratched);
    // A commit leaves a clean status before and after: HEAD itself is part of the fingerprint.
    repo.git("commit", "-q", "--allow-empty", "-m", "moved");
    const moved = await fingerprint();
    expect(moved).not.toBe(clean);
    repo.git("switch", "-q", "--detach");
    expect(await fingerprint()).not.toBe(moved);
  });

  it("statusFingerprint works before the first commit", async () => {
    const dir = tempDir();
    gitSync(dir, "init", "-q", "-b", "main");
    const empty = await createGitCli(REFERENCE_PROVIDER.name).statusFingerprint(dir);
    writeFileSync(join(dir, "first.txt"), "x\n");
    const one = await createGitCli(REFERENCE_PROVIDER.name).statusFingerprint(dir);
    expect(empty).toMatchObject({ ok: true, value: expect.any(String) });
    expect(one).toMatchObject({ ok: true, value: expect.any(String) });
    expect(one.ok && one.value).not.toBe(empty.ok && empty.value);
  });

  it("statusFingerprint reports not_a_repo outside a repository", async () => {
    const outside = tempDir();
    expect(await createGitCli(REFERENCE_PROVIDER.name).statusFingerprint(outside)).toEqual({
      ok: false,
      error: { kind: "not_a_repo", path: outside },
    });
  });
  it("diff --stat and full diff include untracked files", async () => {
    const repo = makeRepo();
    const base = repo.head();
    repo.write("README.md", "# test repo\nedited\n");
    repo.write("docs/new file.md", "brand new line\n");
    const git = createGitCli(REFERENCE_PROVIDER.name);

    const stat = await git.diff(repo.dir, base, { stat: true });
    const full = await git.diff(repo.dir, base, { stat: false });

    expect(stat).toEqual({ ok: true, value: expect.stringContaining("2 files changed, 2 insertions(+)") });
    expect(stat.ok && stat.value).toContain("docs/new file.md | 1 +");
    expect(stat.ok && stat.value).toContain("README.md        | 1 +");
    // git terminates a ---/+++ name that contains a space with a tab.
    expect(full.ok && full.value).toContain("+++ b/docs/new file.md\t\n@@ -0,0 +1 @@\n+brand new line\n");
    expect(full.ok && full.value).toContain("+edited\n");
    // The worktree's own index is untouched: the new file is still untracked, not staged.
    expect(await git.changes(repo.dir, base)).toEqual({
      ok: true,
      value: { added: [], modified: ["README.md"], deleted: [], untracked: ["docs/new file.md"] },
    });
  });
  it("diff sees a same-size edit whose stat info matches the index (a racily clean entry stays racy in the snapshot)", async () => {
    const repo = makeRepo();
    const past = new Date("2026-01-01T00:00:00Z");
    repo.write("value.txt", "wrong\n");
    utimesSync(join(repo.dir, "value.txt"), past, past);
    repo.commitAll("value");
    const base = repo.head();
    // Same size, same mtime as recorded in the index, and the index itself no newer: only the content differs, which
    // git checks because the entry is racy (its mtime is not older than the index file's).
    repo.write("value.txt", "right\n");
    utimesSync(join(repo.dir, "value.txt"), past, past);
    utimesSync(join(repo.dir, ".git", "index"), past, past);
    const git = createGitCli(REFERENCE_PROVIDER.name);

    const full = await git.diff(repo.dir, base, { stat: false });

    expect(full.ok && full.value).toContain("-wrong\n+right\n");
  });
  it("commitAll stages everything including deletions and returns the new sha", async () => {
    const repo = makeRepo();
    repo.write("doomed.txt", "bye\n");
    const base = repo.commitAll("base");
    const worktree = join(tempDir(), "wt");
    const git = createGitCli(REFERENCE_PROVIDER.name);
    await git.addWorktree(repo.dir, worktree, "zai/commit", base);
    const wt = repoAt(worktree);
    wt.write("README.md", "# changed\n");
    wt.write("added/new.txt", "new\n");
    wt.remove("doomed.txt");
    const message = "Do the thing\n\n# Summary heading kept\n\nWorked-by: glm-5.3 via zai";

    const sha = await git.commitAll(worktree, message, VERIFY);

    expect(sha).toEqual({ ok: true, value: wt.head() });
    expect(sha.ok && sha.value).not.toBe(base);
    expect(wt.git("log", "-1", "--format=%B").trimEnd()).toBe(message);
    expect(wt.git("show", "--name-status", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual([
      "A\tadded/new.txt",
      "D\tdoomed.txt",
      "M\tREADME.md",
    ]);
    expect(wt.git("status", "--porcelain")).toBe("");
    expect(repo.head()).toBe(base);
  });

  it("commitAll runs the repository's commit hooks: a failing hook is git_failed with its output, nothing committed", async () => {
    const repo = makeRepo();
    const base = repo.head();
    const marker = installPreCommit(repo, 1);
    repo.write("README.md", "# changed\n");

    const result = await createGitCli(REFERENCE_PROVIDER.name).commitAll(repo.dir, "change", VERIFY);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "git_failed",
        command: expect.stringContaining("commit"),
        stderr: expect.stringContaining("lint: 2 problems in README.md"),
      },
    });
    expect(existsSync(marker)).toBe(true);
    expect(repo.head()).toBe(base);
  });

  it("commitAll with verify false skips the commit hooks", async () => {
    const repo = makeRepo();
    const marker = installPreCommit(repo, 1);
    repo.write("README.md", "# changed\n");

    const result = await createGitCli(REFERENCE_PROVIDER.name).commitAll(repo.dir, "change", {
      verify: false,
    });

    expect(result).toEqual({ ok: true, value: repo.head() });
    expect(existsSync(marker)).toBe(false);
  });

  it("commitAll with nothing to commit is an error", async () => {
    const repo = makeRepo();
    const result = await createGitCli(REFERENCE_PROVIDER.name).commitAll(repo.dir, "empty", VERIFY);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "git_failed",
        command: expect.stringContaining("commit"),
        stderr: expect.stringContaining("nothing to commit"),
      },
    });
  });
  it("trailer reads <provider>.trailer: worked-by unless set to none; an unknown value is an error, not a guess", async () => {
    const repo = makeRepo();
    const git = createGitCli(REFERENCE_PROVIDER.name);

    expect(await git.trailer(repo.dir)).toEqual({ ok: true, value: "worked-by" });
    repo.git("config", "zai.trailer", "none");
    expect(await git.trailer(repo.dir)).toEqual({ ok: true, value: "none" });
    repo.git("config", "zai.trailer", "signed-off-by");
    expect(await git.trailer(repo.dir)).toEqual({
      ok: false,
      error: {
        kind: "git_failed",
        command: "git config --get zai.trailer",
        stderr: '"signed-off-by" is not worked-by or none',
      },
    });
  });

  it("isAncestor: true when the first commit contains the second's history, false the other way", async () => {
    const repo = makeRepo();
    const base = repo.head();
    repo.write("later.txt", "later\n");
    const tip = repo.commitAll("later");
    const git = createGitCli(REFERENCE_PROVIDER.name);

    expect(await git.isAncestor(repo.dir, base, tip)).toEqual({ ok: true, value: true });
    expect(await git.isAncestor(repo.dir, tip, base)).toEqual({ ok: true, value: false });
  });

  it("rebaseJobBranch replays the job branch onto the tip, taking the tip's side for regenerated paths", async () => {
    const repo = makeRepo();
    repo.write("other.txt", "other\n");
    repo.write("generated.txt", "base\n");
    repo.write("code.txt", "base\n");
    const base = repo.commitAll("base");
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const wt = repoAt(join(tempDir(), "wt"));
    await git.addWorktree(repo.dir, wt.dir, "zai/job", base);
    wt.write("job.txt", "by job\n");
    wt.write("generated.txt", "regenerated by job\n");
    wt.write("code.txt", "by job\n");
    wt.commitAll("job");
    repo.write("other.txt", "other, by user\n");
    repo.write("generated.txt", "regenerated by user\n");
    const tip = repo.commitAll("user moved on");

    expect(await git.rebaseJobBranch(wt.dir, tip, ["generated.txt", "dist/**"])).toEqual({
      ok: true,
      value: undefined,
    });

    expect(wt.git("rev-parse", "HEAD~1").trim()).toBe(tip);
    expect(wt.git("log", "-1", "--format=%s").trim()).toBe("job");
    expect(wt.read("other.txt")).toBe("other, by user\n");
    expect(wt.read("generated.txt")).toBe("regenerated by user\n");
    expect(wt.read("code.txt")).toBe("by job\n");
    expect(wt.git("status", "--porcelain")).toBe("");
  });

  it("rebaseJobBranch aborts on a conflict outside the regenerated paths, listing every unmerged path", async () => {
    const repo = makeRepo();
    repo.write("code.txt", "line\n");
    repo.write("generated.txt", "base\n");
    const base = repo.commitAll("base");
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const wt = repoAt(join(tempDir(), "wt"));
    await git.addWorktree(repo.dir, wt.dir, "zai/job", base);
    wt.write("code.txt", "line by job\n");
    wt.write("generated.txt", "regenerated by job\n");
    const jobHead = wt.commitAll("job");
    repo.write("code.txt", "line by user\n");
    repo.write("generated.txt", "regenerated by user\n");
    const tip = repo.commitAll("user moved on");

    expect(await git.rebaseJobBranch(wt.dir, tip, ["generated.txt"])).toEqual({
      ok: false,
      error: { kind: "conflict", paths: ["code.txt", "generated.txt"] },
    });

    expect(wt.head()).toBe(jobHead);
    expect(wt.git("status", "--porcelain")).toBe("");
    expect(wt.read("code.txt")).toBe("line by job\n");
    expect(wt.read("generated.txt")).toBe("regenerated by job\n");
  });

  it("fastForward lands onto the expected tip; a moved tip or a dirty overlapping file lands nothing", async () => {
    const repo = makeRepo();
    const base = repo.head();
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const wt = repoAt(join(tempDir(), "wt"));
    await git.addWorktree(repo.dir, wt.dir, "zai/job", base);
    wt.write("job.txt", "by job\n");
    const sha = await git.commitAll(wt.dir, "job", VERIFY);
    if (!sha.ok) throw new Error(sha.error.kind);

    expect(await git.fastForward(repo.dir, sha.value, base)).toEqual({ ok: true, value: "landed" });
    expect(repo.head()).toBe(sha.value);
    expect(repo.read("job.txt")).toBe("by job\n");

    repo.git("reset", "-q", "--hard", base);
    repo.write("job.txt", "user's uncommitted file in the way\n");
    expect(await git.fastForward(repo.dir, sha.value, base)).toEqual({
      ok: false,
      error: { kind: "dirty", paths: ["job.txt"] },
    });
    expect(repo.head()).toBe(base);

    repo.remove("job.txt");
    repo.write("user.txt", "user moved on\n");
    const moved = repo.commitAll("user");
    expect(await git.fastForward(repo.dir, sha.value, base)).toEqual({ ok: true, value: "moved" });
    expect(repo.head()).toBe(moved);
    expect(existsSync(join(repo.dir, "job.txt"))).toBe(false);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("applyToWorkingTree applies changes without committing; dirty overlapping files → dirty error, nothing applied", async () => {
    const repo = makeRepo();
    repo.write("edit.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    repo.write("delete.txt", "bye\n");
    repo.write("old/deep/only.txt", "the only file in old/\n");
    repo.write("mixed/stay.txt", "stays\n");
    repo.write("mixed/go.txt", "goes\n");
    repo.write("bin.dat", "\u0000\u0001binary\u0002");
    const base = repo.commitAll("base");
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const wt = repoAt(join(tempDir(), "wt"));
    await git.addWorktree(repo.dir, wt.dir, "zai/apply", base);
    wt.write("edit.txt", "1\n2\n3\n4\n5\n6\n7\n8 by job\n");
    wt.remove("delete.txt");
    wt.remove("old");
    wt.remove("mixed/go.txt");
    wt.write("new dir/ünï.txt", "from job\n");
    wt.write("bin.dat", "\u0000\u0003binary by job\u0004");
    // The user moved on with a non-overlapping edit to the same file: the 3-way merge keeps both.
    repo.write("edit.txt", "1 by user\n2\n3\n4\n5\n6\n7\n8\n");
    const userHead = repo.commitAll("user");
    repo.write("unrelated.txt", "user's own scratch\n");
    repo.write("delete.txt", "user's uncommitted edit\n");

    expect(await git.applyToWorkingTree(repo.dir, wt.dir, base)).toEqual({
      ok: false,
      error: { kind: "dirty", paths: ["delete.txt"] },
    });
    expect(repo.read("edit.txt")).toBe("1 by user\n2\n3\n4\n5\n6\n7\n8\n");
    expect(existsSync(join(repo.dir, "new dir"))).toBe(false);

    repo.git("checkout", "--", "delete.txt");
    expect(await git.applyToWorkingTree(repo.dir, wt.dir, base)).toEqual({ ok: true, value: undefined });
    expect(repo.head()).toBe(userHead);
    expect(repo.read("edit.txt")).toBe("1 by user\n2\n3\n4\n5\n6\n7\n8 by job\n");
    expect(repo.read("new dir/ünï.txt")).toBe("from job\n");
    expect(repo.read("bin.dat")).toBe("\u0000\u0003binary by job\u0004");
    expect(existsSync(join(repo.dir, "delete.txt"))).toBe(false);
    expect(existsSync(join(repo.dir, "old"))).toBe(false);
    expect(existsSync(join(repo.dir, "mixed/go.txt"))).toBe(false);
    expect(repo.read("mixed/stay.txt")).toBe("stays\n");
    // Nothing staged: the real index still matches HEAD.
    expect(repo.git("diff", "--cached", "--name-only")).toBe("");
    expect(repo.read("unrelated.txt")).toBe("user's own scratch\n");
  });

  it("applyToWorkingTree on a conflicting change returns the conflict paths and touches nothing", async () => {
    const repo = makeRepo();
    repo.write("clash.txt", "original\n");
    repo.write("fine.txt", "original\n");
    const base = repo.commitAll("base");
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const wt = repoAt(join(tempDir(), "wt"));
    await git.addWorktree(repo.dir, wt.dir, "zai/clash", base);
    wt.write("clash.txt", "job\n");
    wt.write("fine.txt", "job\n");
    repo.write("clash.txt", "user\n");
    repo.commitAll("user");
    const status = repo.git("status", "--porcelain=v1", "--untracked-files=all");

    expect(await git.applyToWorkingTree(repo.dir, wt.dir, base)).toEqual({
      ok: false,
      error: { kind: "conflict", paths: ["clash.txt"] },
    });
    expect(repo.git("status", "--porcelain=v1", "--untracked-files=all")).toBe(status);
    expect(repo.read("fine.txt")).toBe("original\n");
  });

  it("applyToWorkingTree applies a change set that only deletes", async () => {
    const repo = makeRepo();
    repo.write("a.txt", "a\n");
    const base = repo.commitAll("base");
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const wt = repoAt(join(tempDir(), "wt"));
    await git.addWorktree(repo.dir, wt.dir, "zai/delete", base);
    wt.remove("a.txt");

    expect(await git.applyToWorkingTree(repo.dir, wt.dir, base)).toEqual({ ok: true, value: undefined });
    expect(repo.git("status", "--porcelain")).toBe(" D a.txt\n");
  });

  it("applyToWorkingTree with no changes is a no-op", async () => {
    const repo = makeRepo();
    const base = repo.head();
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const wt = join(tempDir(), "wt");
    await git.addWorktree(repo.dir, wt, "zai/noop", base);
    expect(await git.applyToWorkingTree(repo.dir, wt, base)).toEqual({ ok: true, value: undefined });
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("amendAll folds the pending work into the last commit and returns its sha", async () => {
    const repo = makeRepo();
    repo.write("a.txt", "v1\n");
    repo.write("doomed.txt", "bye\n");
    const first = repo.commitAll("first");
    repo.write("a.txt", "v2\n");
    repo.write("added/new.txt", "new\n");
    repo.remove("doomed.txt");

    const sha = await createGitCli(REFERENCE_PROVIDER.name).amendAll(repo.dir, VERIFY);

    expect(sha).toEqual({ ok: true, value: repo.head() });
    expect(sha.ok && sha.value).not.toBe(first);
    expect(repo.git("log", "-1", "--format=%s").trim()).toBe("first");
    // Both a.txt and doomed.txt were introduced by the amended commit, so its diff against the older parent is two
    // additions with the final content — v2 and gone.
    expect(repo.git("show", "--name-status", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual(
      ["A\ta.txt", "A\tadded/new.txt"],
    );
    expect(repo.read("a.txt")).toBe("v2\n");
    expect(existsSync(join(repo.dir, "doomed.txt"))).toBe(false);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("amendAll runs the repository's commit hooks unless verify is false", async () => {
    const repo = makeRepo();
    repo.write("a.txt", "v1\n");
    repo.commitAll("first");
    const marker = installPreCommit(repo, 1);
    repo.write("a.txt", "v2\n");
    const git = createGitCli(REFERENCE_PROVIDER.name);

    const blocked = await git.amendAll(repo.dir, VERIFY);

    expect(blocked.ok ? "ok" : blocked.error.kind).toBe("git_failed");
    expect(existsSync(marker)).toBe(true);
    expect(repo.git("log", "-1", "--format=%s").trim()).toBe("first");
    expect((await git.amendAll(repo.dir, { verify: false })).ok).toBe(true);
    expect(repo.read("a.txt")).toBe("v2\n");
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("addDetachedWorktree checks the sha out with no branch; removeDetachedWorktree removes it and its registration", async () => {
    const repo = makeRepo();
    repo.write("a.txt", "v1\n");
    repo.commitAll("base");
    repo.write("a.txt", "v2\n");
    const later = repo.commitAll("later");
    const checkout = join(tempDir(), "land-checkout");
    const git = createGitCli(REFERENCE_PROVIDER.name);

    expect(await git.addDetachedWorktree(repo.dir, checkout, later)).toEqual({ ok: true, value: undefined });
    expect(await git.resolve(checkout, "HEAD")).toEqual({ ok: true, value: later });
    const branch = await git.currentBranch(checkout);
    expect(branch.ok ? "ok" : branch.error.kind).toBe("git_failed");
    expect(repoAt(checkout).read("a.txt")).toBe("v2\n");

    expect(await git.removeDetachedWorktree(repo.dir, checkout)).toEqual({ ok: true, value: undefined });
    expect(existsSync(checkout)).toBe(false);
    expect(repo.git("worktree", "list", "--porcelain")).not.toContain("land-checkout");
    // Removing again (a cleanup that lost the race) only prunes a stale registration.
    expect(await git.removeDetachedWorktree(repo.dir, checkout)).toEqual({ ok: true, value: undefined });
  });

  it("applyToWorkingTree with an unknown base fails", async () => {
    const repo = makeRepo();
    const result = await createGitCli(REFERENCE_PROVIDER.name).applyToWorkingTree(
      repo.dir,
      repo.dir,
      "0".repeat(40),
    );
    expect(result.ok ? "ok" : result.error.kind).toBe("git_failed");
  });

  it("operations outside a repository report not_a_repo; removeWorktree never deletes a non-worktree", async () => {
    const repo = makeRepo();
    const outside = tempDir();
    writeFileSync(join(outside, "precious.txt"), "keep\n");
    const git = createGitCli(REFERENCE_PROVIDER.name);
    const notARepo = { ok: false, error: { kind: "not_a_repo", path: outside } };

    expect(await git.changes(outside, "HEAD")).toEqual(notARepo);
    expect(await git.diff(outside, "HEAD", { stat: true })).toEqual(notARepo);
    expect(await git.commitAll(outside, "message", VERIFY)).toEqual(notARepo);
    expect(await git.fastForward(outside, "HEAD", "0".repeat(40))).toEqual(notARepo);
    expect(await git.removeDetachedWorktree(outside, outside)).toEqual(notARepo);
    expect(await git.resolve(outside, "HEAD")).toEqual(notARepo);
    expect(await git.currentBranch(outside)).toEqual(notARepo);
    expect(await git.applyToWorkingTree(repo.dir, outside, repo.head())).toEqual(notARepo);
    repo.write("README.md", "changed so there is something to apply\n");
    expect(await git.applyToWorkingTree(outside, repo.dir, repo.head())).toEqual(notARepo);
    const removed = await git.removeWorktree(repo.dir, outside, "zai/none");
    expect(removed.ok ? "ok" : removed.error.kind).toBe("git_failed");
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });
});

describe("git output parsing", () => {
  it("splitNul drops only the terminator; chompNewline drops only one trailing newline", () => {
    expect(splitNul("")).toEqual([]);
    expect(splitNul("a\0b c\0")).toEqual(["a", "b c"]);
    expect(splitNul("a\0unterminated")).toEqual(["a", "unterminated"]);
    expect(chompNewline("/path/ends with space \n")).toBe("/path/ends with space ");
    expect(chompNewline("no newline")).toBe("no newline");
  });

  it("unmergedPaths lists each conflicted path once, sorted", () => {
    const stages = [
      "100644 aaa 1\tz.txt",
      "100644 bbb 2\tz.txt",
      "100644 ccc 3\tz.txt",
      "100644 ddd 2\ta\tb.txt",
    ];
    expect(unmergedPaths(`${stages.join("\0")}\0`)).toEqual(["a\tb.txt", "z.txt"]);
  });
});
