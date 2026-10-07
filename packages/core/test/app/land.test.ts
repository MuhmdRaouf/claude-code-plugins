/**
 * land() end to end on real temporary git repositories: one test per landing case. The adapters are real, the gates
 * really run, and every failure asserts the repository was left exactly as it was.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createFsStore } from "../../src/adapters/fs-store.ts";
import { createGitCli } from "../../src/adapters/git-cli.ts";
import { createShellGates } from "../../src/adapters/shell-gates.ts";
import { land, removeWorkspace } from "../../src/app/decide-land.ts";
import type { Deps } from "../../src/app/deps.ts";
import type { Brief, Gate } from "../../src/domain/brief.ts";
import { DEFAULT_GATE_TIMEOUT_MS } from "../../src/domain/brief-defaults.ts";
import type { Job } from "../../src/domain/job.ts";
import { err, type Result } from "../../src/domain/result.ts";
import { aBrief, aJob } from "../support/builders.ts";
import { FakeHost, fakeDeps, RecordingOutput } from "../support/fakes.ts";
import { isolateGitConfig, makeRepo, repoAt, type TestRepo, tempDir } from "../support/tmp.ts";
import { isPidAlive } from "../support/wait.ts";

function expectErr<T, E>(result: Result<T, E>): E {
  expect(result.ok).toBe(false);
  return result.ok ? (undefined as never) : result.error;
}

/** The repository's worktree registrations, as paths. */
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

interface LandWorld {
  readonly deps: Deps;
  readonly repo: TestRepo;
  readonly stateRoot: string;
  readonly job: Job;
  readonly worktree: TestRepo;
  readonly base: string;
}

/** A real repository with a real job worktree under zai's state root — the world an accept lands in. */
/** The brief overrides, or the same given where the repositories live (a gate may commit to the user's). */
type BriefOverrides =
  | Partial<Brief>
  | ((where: { readonly repo: string; readonly stateRoot: string }) => Partial<Brief>);

function landWorld(
  setup: {
    readonly files?: Record<string, string>;
    readonly brief?: BriefOverrides;
    readonly trailer?: string;
  } = {},
): LandWorld {
  const stateRoot = tempDir("zai-land-state-");
  const repo = makeRepo();
  const files = Object.entries(setup.files ?? {});
  for (const [path, content] of files) repo.write(path, content);
  const base = files.length > 0 ? repo.commitAll("base") : repo.head();
  if (setup.trailer !== undefined) repo.git("config", "zai.trailer", setup.trailer);
  const worktree = repoAt(join(stateRoot, "worktrees", "j1"));
  repo.git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree.dir, base);
  const job = aJob({
    id: "j1",
    state: "awaiting_review",
    brief: aBrief(
      typeof setup.brief === "function" ? setup.brief({ repo: repo.dir, stateRoot }) : setup.brief,
    ),
    workspace: {
      repoRoot: repo.dir,
      baseSha: base,
      worktree: worktree.dir,
      branch: "zai/j1",
      artifactsDir: join(stateRoot, "jobs", "j1", "artifacts"),
    },
  });
  const deps: Deps = {
    ...fakeDeps().deps,
    git: createGitCli("zai"),
    store: createFsStore(stateRoot, isPidAlive),
    gates: createShellGates("zai"),
    out: new RecordingOutput(),
    host: new FakeHost(stateRoot),
  };
  return { deps, repo, stateRoot, job, worktree, base };
}

const OPTS = { mode: "commit", verify: true } as const;

/** A gate with the domain's timeout default filled in. */
const gate = (run: string): Gate => ({ run, timeoutMs: DEFAULT_GATE_TIMEOUT_MS });

/** Nothing of a landed job survives its accept: no worktree on disk or registered, no branch, no checkout. */
function expectNothingLeftBehind(world: LandWorld): void {
  expect(worktreePaths(world.repo)).toEqual([world.repo.dir]);
  expect(branches(world.repo)).toEqual(["main"]);
  expect(existsSync(world.job.workspace.worktree ?? "")).toBe(false);
  expect(existsSync(join(world.stateRoot, "checkouts", "j1"))).toBe(false);
}

describe("land", () => {
  beforeEach(() => isolateGitConfig());

  it("fast-forwards the repository onto the job's commit when the base is still the tip", async () => {
    const world = landWorld();
    world.worktree.write("feature.txt", "the change\n");

    const landed = await land(world.deps, world.job, OPTS);

    expect(landed.ok).toBe(true);
    if (landed.ok) expect(world.repo.head()).toBe(landed.value);
    expect(world.repo.git("rev-parse", "HEAD~1").trim()).toBe(world.base);
    expect(world.repo.git("log", "-1", "--format=%s").trim()).toBe("Rename the helper");
    expect(world.repo.git("log", "-1", "--format=%B")).toContain("Worked-by: glm-5.3 via zai");
  });

  it("rebases onto a moved tip when nothing overlaps and lands both changes", async () => {
    const world = landWorld({ files: { "user.txt": "base\n" } });
    world.repo.write("user.txt", "user edited\n");
    const tip = world.repo.commitAll("user edits user.txt");
    world.worktree.write("worker.txt", "worker edited\n");

    const landed = await land(world.deps, world.job, OPTS);

    expect(landed.ok).toBe(true);
    expect(world.repo.read("user.txt")).toBe("user edited\n");
    expect(world.repo.read("worker.txt")).toBe("worker edited\n");
    expect(world.repo.git("rev-parse", "HEAD~1").trim()).toBe(tip);
  });

  it("regenerates a file that conflicts with the tip instead of failing", async () => {
    const world = landWorld({
      files: { "generated.txt": "base\n" },
      brief: {
        regenerate: [{ paths: ["generated.txt"], run: "echo regenerated > generated.txt" }],
        gates: [gate('test "$(cat generated.txt)" = regenerated')],
      },
    });
    world.repo.write("generated.txt", "user edited\n");
    const tip = world.repo.commitAll("user edits generated.txt");
    world.worktree.write("generated.txt", "worker edited\n");
    world.worktree.write("code.txt", "the code\n");

    const landed = await land(world.deps, world.job, OPTS);

    expect(landed.ok).toBe(true);
    expect(world.repo.read("generated.txt")).toBe("regenerated\n");
    expect(world.repo.read("code.txt")).toBe("the code\n");
    expect(world.repo.git("rev-parse", "HEAD~1").trim()).toBe(tip);
  });

  it("fails with land_conflict and changes nothing when the conflict is in code", async () => {
    const world = landWorld({ files: { "code.txt": "base\n" } });
    world.repo.write("code.txt", "user edited\n");
    const tip = world.repo.commitAll("user edits code.txt");
    world.worktree.write("code.txt", "worker edited\n");

    const landed = await land(world.deps, world.job, OPTS);

    expect(landed).toStrictEqual(err({ kind: "land_conflict", paths: ["code.txt"] }));
    // Nothing changed: the repository is where it was, and the job's work survives untouched for a retry.
    expect(world.repo.head()).toBe(tip);
    expect(world.repo.read("code.txt")).toBe("user edited\n");
    expect(world.worktree.read("code.txt")).toBe("worker edited\n");
    expect(world.worktree.git("status", "--porcelain")).toBe("");
    expect(existsSync(join(world.stateRoot, "checkouts", "j1"))).toBe(false);
  });

  it("fails with land_verify_failed when a gate needs a file the commit does not carry", async () => {
    const world = landWorld({
      files: { ".gitignore": "ignored.txt\n" },
      brief: { gates: [gate("cat ignored.txt")] },
    });
    world.worktree.write("code.txt", "the code\n");
    world.worktree.write("ignored.txt", "git refuses to commit me\n");

    const landed = await land(world.deps, world.job, OPTS);

    const failure = expectErr(landed);
    expect(failure.kind).toBe("land_verify_failed");
    if (failure.kind === "land_verify_failed") {
      expect(failure.command).toBe("cat ignored.txt");
      expect(failure.tail).toContain("No such file");
    }
    // Nothing landed; the failing gate's log says why, and no checkout is left behind.
    expect(world.repo.head()).toBe(world.base);
    expect(existsSync(join(world.repo.dir, "code.txt"))).toBe(false);
    expect(existsSync(join(world.stateRoot, "jobs", "j1", "land-check-0.log"))).toBe(true);
    expect(existsSync(join(world.stateRoot, "checkouts", "j1"))).toBe(false);
  });

  it("runs the brief's setup in the verification checkout before the gates", async () => {
    const world = landWorld({
      files: { "code.txt": "base\n" },
      brief: {
        setup: ["echo prepared > prepared.txt"],
        gates: [gate('test "$(cat prepared.txt)" = prepared')],
      },
    });
    world.worktree.write("code.txt", "worker edited\n");

    const landed = await land(world.deps, world.job, OPTS);

    // The gate only passes because setup prepared the file it reads — in the checkout, not in the landed commit.
    expect(landed.ok).toBe(true);
    expect(existsSync(join(world.repo.dir, "prepared.txt"))).toBe(false);
    expect(existsSync(join(world.stateRoot, "jobs", "j1", "land-check-0.log"))).toBe(true);
    expect(existsSync(join(world.stateRoot, "checkouts", "j1"))).toBe(false);
  });

  it("retries when the tip moves while the commit is being verified", async () => {
    const world = landWorld({
      brief: (where) => ({
        gates: [
          gate(
            `test -f "${join(where.stateRoot, "moved-once")}" || ` +
              `{ git -C "${where.repo}" commit --allow-empty -q -m "tip moved"; ` +
              `touch "${join(where.stateRoot, "moved-once")}"; }`,
          ),
        ],
      }),
    });
    world.worktree.write("feature.txt", "the change\n");

    const landed = await land(world.deps, world.job, OPTS);

    // The gate moved the tip once, mid-verification; the next round rebased onto it and landed.
    expect(landed.ok).toBe(true);
    expect(world.repo.git("log", "--format=%s").trim().split("\n")).toEqual([
      "Rename the helper",
      "tip moved",
      "init",
    ]);
  });

  it("refuses to land over a dirty user file the change set touches", async () => {
    const world = landWorld({ files: { "code.txt": "base\n" } });
    world.worktree.write("code.txt", "worker edited\n");
    world.repo.write("code.txt", "user is editing\n");

    const landed = await land(world.deps, world.job, OPTS);

    expect(landed).toStrictEqual(err({ kind: "git", error: { kind: "dirty", paths: ["code.txt"] } }));
    expect(world.repo.head()).toBe(world.base);
    expect(world.repo.read("code.txt")).toBe("user is editing\n");
    expect(world.repo.git("status", "--porcelain")).toBe(" M code.txt\n");
  });

  it("omits the Worked-by trailer when the repository sets zai.trailer to none", async () => {
    const world = landWorld({ trailer: "none" });
    world.worktree.write("feature.txt", "the change\n");

    const landed = await land(world.deps, world.job, OPTS);

    expect(landed.ok).toBe(true);
    const message = world.repo.git("log", "-1", "--format=%B");
    expect(message).not.toContain("Worked-by");
    expect(message.trim()).toBe("Rename the helper");
  });

  it("leaves no worktree, branch, or checkout behind once the accept completes", async () => {
    const world = landWorld({ brief: { gates: [gate("true")] } });
    world.worktree.write("feature.txt", "the change\n");

    const landed = await land(world.deps, world.job, OPTS);
    expect(landed.ok).toBe(true);
    // accept continues by recording the decision and removing the workspace
    await removeWorkspace(world.deps, world.job);

    expectNothingLeftBehind(world);
  });

  it("keeps the job's worktree and branch for a retry when landing fails", async () => {
    const world = landWorld({ files: { "code.txt": "base\n" } });
    world.repo.write("code.txt", "user edited\n");
    world.repo.commitAll("user edits code.txt");
    world.worktree.write("code.txt", "worker edited\n");

    const landed = await land(world.deps, world.job, OPTS);

    expect(landed.ok).toBe(false);
    expect(worktreePaths(world.repo)).toContain(world.worktree.dir);
    expect(branches(world.repo)).toContain("zai/j1");
    expect(existsSync(join(world.stateRoot, "checkouts", "j1"))).toBe(false);
  });
});
