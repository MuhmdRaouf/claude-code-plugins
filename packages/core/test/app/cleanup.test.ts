/**
 * cleanupWorkspace against real git repositories and a real store: the leftovers a previous run can leave — a decided
 * job whose worktree survived, a temporary checkout of an interrupted accept — are removed, and only the plugin's own
 * directories and branch prefix are ever touched.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { createFsJobFiles } from "../../src/adapters/fs-job-files.ts";
import { createFsStore } from "../../src/adapters/fs-store.ts";
import { createGitCli } from "../../src/adapters/git-cli.ts";
import { cleanupWorkspace } from "../../src/app/cleanup.ts";
import type { Deps } from "../../src/app/deps.ts";
import type { Job } from "../../src/domain/job.ts";
import type { JobStore } from "../../src/ports/index.ts";
import { aJob } from "../support/builders.ts";
import { FakeHost, fakeDeps, RecordingOutput } from "../support/fakes.ts";
import { isolateGitConfig, makeRepo, type TestRepo, tempDir } from "../support/tmp.ts";
import { isPidAlive } from "../support/wait.ts";

interface CleanupWorld {
  readonly deps: Deps;
  readonly repo: TestRepo;
  readonly stateRoot: string;
  readonly store: JobStore;
}

/** A real repository and a real store rooted together, as a plugin run starts out. */
function cleanupWorld(): CleanupWorld {
  const stateRoot = tempDir("zai-cleanup-state-");
  const repo = makeRepo();
  const store = createFsStore(stateRoot, isPidAlive);
  const deps: Deps = {
    ...fakeDeps().deps,
    git: createGitCli("zai"),
    store,
    files: createFsJobFiles(stateRoot),
    out: new RecordingOutput(),
    host: new FakeHost(stateRoot),
  };
  return { deps, repo, stateRoot, store };
}

function worktreePaths(repo: TestRepo): readonly string[] {
  return repo
    .git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function branches(repo: TestRepo): readonly string[] {
  return repo.git("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
}

/** A decided job whose worktree and branch outlived the decision — the classic leftover. */
async function decidedJobWithWorktree(world: CleanupWorld, state: "accepted" | "discarded"): Promise<string> {
  const worktree = join(world.stateRoot, "worktrees", "j1");
  world.repo.git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree, world.repo.head());
  await world.store.create(jobWithWorkspace(world, state, worktree, "zai/j1"));
  return worktree;
}

function jobWithWorkspace(world: CleanupWorld, state: Job["state"], worktree: string, branch: string): Job {
  return aJob({
    id: "j1",
    state,
    workspace: {
      repoRoot: world.repo.dir,
      baseSha: world.repo.head(),
      worktree,
      branch,
      artifactsDir: join(world.stateRoot, "jobs", "j1", "artifacts"),
    },
  });
}

describe("cleanupWorkspace", () => {
  beforeEach(() => isolateGitConfig());

  it.each(["accepted", "discarded"] as const)(
    "removes the leftover worktree and branch of a %s job",
    async (state) => {
      const world = cleanupWorld();
      const worktree = await decidedJobWithWorktree(world, state);

      await cleanupWorkspace(world.deps);

      expect(existsSync(worktree)).toBe(false);
      expect(worktreePaths(world.repo)).toEqual([world.repo.dir]);
      expect(branches(world.repo)).toEqual(["main"]);
      // The job record itself is not cleanup's to remove.
      expect(existsSync(join(world.stateRoot, "jobs", "j1"))).toBe(true);
    },
  );

  it("keeps the worktree of a job that is still running", async () => {
    const world = cleanupWorld();
    const worktree = join(world.stateRoot, "worktrees", "j1");
    world.repo.git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree, world.repo.head());
    await world.store.create(jobWithWorkspace(world, "running", worktree, "zai/j1"));

    await cleanupWorkspace(world.deps);

    expect(existsSync(worktree)).toBe(true);
    expect(branches(world.repo)).toContain("zai/j1");
  });

  it("keeps a worktree it did not create, even on one of its branches", async () => {
    const world = cleanupWorld();
    const worktree = join(tempDir("zai-user-"), "wt");
    world.repo.git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree, world.repo.head());
    await world.store.create(jobWithWorkspace(world, "accepted", worktree, "zai/j1"));

    await cleanupWorkspace(world.deps);

    expect(existsSync(worktree)).toBe(true);
    expect(worktreePaths(world.repo)).toContain(worktree);
    expect(branches(world.repo)).toContain("zai/j1");
  });

  it("keeps a worktree under its state root whose branch is not one of its own", async () => {
    const world = cleanupWorld();
    const worktree = join(world.stateRoot, "worktrees", "j1");
    world.repo.git("worktree", "add", "-q", "-b", "feature", "--", worktree, world.repo.head());
    await world.store.create(jobWithWorkspace(world, "accepted", worktree, "feature"));

    await cleanupWorkspace(world.deps);

    expect(existsSync(worktree)).toBe(true);
    expect(branches(world.repo)).toContain("feature");
  });

  it("removes the leftover checkout of a job the store no longer knows", async () => {
    const world = cleanupWorld();
    const checkout = join(world.stateRoot, "checkouts", "ghost");
    world.repo.git("worktree", "add", "-q", "--detach", "--", checkout, world.repo.head());

    await cleanupWorkspace(world.deps);

    expect(existsSync(checkout)).toBe(false);
    expect(worktreePaths(world.repo)).toEqual([world.repo.dir]);
  });

  it("removes the leftover checkout of an idle job, and releases its lock", async () => {
    const world = cleanupWorld();
    await world.store.create(
      jobWithWorkspace(world, "running", join(world.stateRoot, "worktrees", "j1"), "zai/j1"),
    );
    const checkout = join(world.stateRoot, "checkouts", "j1");
    world.repo.git("worktree", "add", "-q", "--detach", "--", checkout, world.repo.head());

    await cleanupWorkspace(world.deps);

    expect(existsSync(checkout)).toBe(false);
    expect(worktreePaths(world.repo)).toEqual([world.repo.dir]);
    // The lock was taken only to hold the slot while removing.
    expect((await world.store.lock("j1", process.pid)).ok).toBe(true);
  });

  it("leaves a checkout alone while an accept may still be in flight", async () => {
    const world = cleanupWorld();
    await world.store.create(
      jobWithWorkspace(world, "running", join(world.stateRoot, "worktrees", "j1"), "zai/j1"),
    );
    const checkout = join(world.stateRoot, "checkouts", "j1");
    world.repo.git("worktree", "add", "-q", "--detach", "--", checkout, world.repo.head());
    const holder = spawn("sleep", ["30"]);
    onTestFinished(() => {
      holder.kill();
    });
    await new Promise((resolve) => holder.once("spawn", resolve));
    const lock = await world.store.lock("j1", holder.pid ?? 0);
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    try {
      await cleanupWorkspace(world.deps);
      expect(existsSync(checkout)).toBe(true);
    } finally {
      await lock.value();
    }

    // Once the accept is gone, the same cleanup takes it.
    await cleanupWorkspace(world.deps);
    expect(existsSync(checkout)).toBe(false);
  });

  it("does nothing, quietly, when there is nothing to clean", async () => {
    const world = cleanupWorld();

    await expect(cleanupWorkspace(world.deps)).resolves.toBeUndefined();
    expect(worktreePaths(world.repo)).toEqual([world.repo.dir]);
  });
});
