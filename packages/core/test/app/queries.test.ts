import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { batch } from "../../src/app/batch.ts";
import { board, reviewPacket, usage } from "../../src/app/queries.ts";
import type { Job } from "../../src/domain/job.ts";
import { err, ok } from "../../src/domain/result.ts";
import { summarizeUsage } from "../../src/domain/usage.ts";
import { INITIAL_PROGRESS } from "../../src/domain/worker-events.ts";
import { aBrief, aJob, anAttempt } from "../support/builders.ts";
import { type Fakes, fakeDeps, wire } from "../support/fakes.ts";

function put(fakes: Fakes, id: string, overrides: Partial<Job> = {}): Job {
  return fakes.store.put(aJob({ id, createdAt: `2026-10-06T00:00:0${id.at(-1)}.000Z`, ...overrides }));
}

describe("board", () => {
  it("lists repo jobs newest first; --all includes other repos", async () => {
    const fakes = fakeDeps();
    put(fakes, "j1");
    put(fakes, "j2", { workspace: { ...aJob().workspace, repoRoot: "/other" } });
    put(fakes, "j3");

    const repo = await board(fakes.deps, { repoRoot: "/repo", all: false });
    const all = await board(fakes.deps, { repoRoot: "/repo", all: true });

    expect(repo.map((row) => row.job.id)).toEqual(["j3", "j1"]);
    expect(all.map((row) => row.job.id)).toEqual(["j3", "j2", "j1"]);
    expect(repo.map((row) => ({ progress: row.progress, live: row.live }))).toEqual([
      { progress: undefined, live: false },
      { progress: undefined, live: false },
    ]);
  });

  it("folds progress from the running attempt's log", async () => {
    const fakes = fakeDeps();
    put(fakes, "j1", { state: "running", attempts: [anAttempt(), anAttempt({ n: 2, kind: "auto_fix" })] });
    writeFileSync(
      fakes.store.paths("j1").attemptLog(2),
      [wire.init("s-2"), wire.tool("Bash", { command: "npm test" }), wire.retry(429), "{torn"].join("\n"),
    );

    const [row] = await board(fakes.deps, { repoRoot: "/repo", all: false });

    expect(row?.progress).toEqual({
      ...INITIAL_PROGRESS,
      sessionId: "s-2",
      phase: "rate_limited",
      lastTool: "Bash npm test",
      toolCalls: 1,
      rateLimitRetries: 1,
    });
  });

  it("prefers the driver's progress snapshot of the running attempt over its log", async () => {
    const fakes = fakeDeps();
    put(fakes, "j1", { state: "running", attempts: [anAttempt()] });
    const paths = fakes.store.paths("j1");
    writeFileSync(paths.attemptLog(1), `${wire.init("s-1")}\n`);
    await fakes.deps.files.writeProgress(paths, 1, {
      ...INITIAL_PROGRESS,
      phase: "writing",
      lastText: "almost",
      turns: 3,
    });

    const [row] = await board(fakes.deps, { all: true });

    expect(row?.progress).toEqual({ ...INITIAL_PROGRESS, phase: "writing", lastText: "almost", turns: 3 });
  });

  it("marks running/verifying jobs without a live driver as live=false", async () => {
    const fakes = fakeDeps();
    put(fakes, "j1", { state: "running", attempts: [anAttempt()] });
    put(fakes, "j2", { state: "verifying", attempts: [anAttempt()] });
    put(fakes, "j3", { state: "queued" });
    fakes.store.holdLock("j1", 4242);
    fakes.process.alive.add(4242);
    fakes.store.holdLock("j2", 4343);

    const rows = await board(fakes.deps, { repoRoot: "/repo", all: false });

    expect(rows.map((row) => [row.job.id, row.live])).toEqual([
      ["j3", false],
      ["j2", false],
      ["j1", true],
    ]);
    expect(rows[2]?.progress).toBeUndefined();
  });
});

describe("reviewPacket", () => {
  it("includes diff stat always and the full diff only on request, truncated to maxDiffChars with a marker", async () => {
    const fakes = fakeDeps();
    const job = put(fakes, "j1", { state: "awaiting_review" });
    fakes.git.diffText = "x".repeat(30);

    const plain = await reviewPacket(fakes.deps, "j1", { diff: false, maxDiffChars: 10 });
    const full = await reviewPacket(fakes.deps, "j1", { diff: true, maxDiffChars: 100 });
    const cut = await reviewPacket(fakes.deps, "j1", { diff: true, maxDiffChars: 10 });

    expect(plain).toEqual(ok({ job, diffStat: fakes.git.diffStat }));
    expect(full).toEqual(ok({ job, diffStat: fakes.git.diffStat, diff: "x".repeat(30) }));
    expect(cut.ok && cut.value.diff).toBe(`${"x".repeat(10)}\n[diff truncated: 20 more characters]\n`);
    expect(fakes.git.called("diff")[0]).toEqual([
      job.workspace.worktree,
      job.workspace.baseSha,
      { stat: true },
    ]);
  });

  it("has no diff for exec/readonly jobs or decided jobs whose worktree is gone", async () => {
    const fakes = fakeDeps();
    const exec = put(fakes, "j1", {
      brief: aBrief({ mode: "exec", scope: [] }),
      workspace: { repoRoot: "/repo", baseSha: "b".repeat(40), artifactsDir: "/state/jobs/j1/artifacts" },
    });
    const accepted = put(fakes, "j2", { state: "accepted" });

    expect(await reviewPacket(fakes.deps, "j1", { diff: true, maxDiffChars: 10 })).toEqual(ok({ job: exec }));
    expect(await reviewPacket(fakes.deps, "j2", { diff: true, maxDiffChars: 10 })).toEqual(
      ok({ job: accepted }),
    );
    expect(fakes.git.called("diff")).toEqual([]);
  });

  it("not_found for an unknown id", async () => {
    const fakes = fakeDeps();

    expect(await reviewPacket(fakes.deps, "nope", { diff: false, maxDiffChars: 10 })).toEqual(
      err({ kind: "store", error: { kind: "not_found", id: "nope" } }),
    );
  });
});

describe("batch", () => {
  it("submits valid briefs, reports invalid ones with their errors, spawns one driver per submitted job", async () => {
    const fakes = fakeDeps();
    const good = (title: string) => `---\ntitle: ${title}\n---\nDo it.\n`;

    const outcome = await batch(
      fakes.deps,
      [
        { path: "/briefs/a.md", text: good("A") },
        { path: "/briefs/bad.md", text: "no front matter" },
        { path: "/briefs/b.md", text: good("B") },
      ],
      "/repo",
    );

    expect(outcome.submitted.map((job) => job.brief.title)).toEqual(["A", "B"]);
    expect(outcome.rejected).toEqual([
      { path: "/briefs/bad.md", error: { kind: "brief", errors: [{ kind: "no_front_matter" }] } },
    ]);
    expect(fakes.process.spawned).toEqual(outcome.submitted.map((job) => job.id));
  });
});

describe("usage", () => {
  it("summarizes the store's jobs via domain summarizeUsage, repo-filtered unless all", async () => {
    const fakes = fakeDeps();
    const here = put(fakes, "j1", { state: "accepted", attempts: [anAttempt({ verdict: "pass" })] });
    const there = put(fakes, "j2", {
      brief: aBrief({ model: "flash" }),
      workspace: { ...aJob().workspace, repoRoot: "/other" },
    });

    expect(await usage(fakes.deps, { repoRoot: "/repo", all: false })).toEqual(summarizeUsage([here]));
    expect(await usage(fakes.deps, { repoRoot: "/repo", all: true })).toEqual(summarizeUsage([there, here]));
  });
});
