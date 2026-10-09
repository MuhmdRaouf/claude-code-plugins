import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { drive } from "../../src/app/drive.ts";
import { EXIT } from "../../src/cli/exit.ts";
import { runCli } from "../../src/cli/run.ts";
import type { Job } from "../../src/domain/job.ts";
import { err, ok } from "../../src/domain/result.ts";
import { aBrief, aChangeSet, aGateResult, aJob, anAttempt, aVerification } from "../support/builders.ts";
import { completes, type Fakes, fakeDeps, VALID_CHANGE_REPORT, wire } from "../support/fakes.ts";

const BRIEF = "---\ntitle: Rename foo\ngates: [npm test]\n---\nRename `foo` to `bar`.\n";

function briefFile(fakes: Fakes, text = BRIEF, name = "brief.md"): string {
  const path = join(fakes.root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function reviewable(fakes: Fakes, overrides: Partial<Job> = {}): Job {
  const id = "261006-review";
  const paths = fakes.store.paths(id);
  return fakes.store.put(
    aJob({
      id,
      state: "awaiting_review",
      workspace: {
        repoRoot: "/repo",
        baseSha: "b".repeat(40),
        worktree: paths.worktree,
        branch: `zai/${id}`,
        artifactsDir: paths.artifacts,
      },
      attempts: [
        anAttempt({
          outcome: { kind: "completed" },
          report: VALID_CHANGE_REPORT,
          verification: aVerification({ changes: aChangeSet({ modified: ["src/a.ts"] }) }),
          verdict: "pass",
        }),
      ],
      ...overrides,
    }),
  );
}

async function cli(fakes: Fakes, ...argv: string[]): Promise<number> {
  return runCli(argv, fakes.deps, "/repo");
}

/** The fake spawn drives the job in this process, as the detached `zai drive <id>` would. */
function drivesOnSpawn(fakes: Fakes): void {
  fakes.process.onSpawn = (id) => {
    void drive(fakes.deps, id);
  };
}

/** Runs `then` once, right before the n-th poll sleep. */
function afterSleeps(fakes: Fakes, n: number, then: () => void): void {
  let count = 0;
  const sleep = fakes.clock.sleep.bind(fakes.clock);
  fakes.deps.clock.sleep = async (ms, signal) => {
    count += 1;
    if (count === n) then();
    await sleep(ms, signal);
  };
}

/** `board --watch` loops only on a TTY: runs `run` with stdout's isTTY forced, then restores what was there. */
async function withTty(tty: boolean, run: () => Promise<number>): Promise<number> {
  const had = Object.hasOwn(process.stdout, "isTTY");
  const was = (process.stdout as { isTTY?: boolean }).isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
  try {
    return await run();
  } finally {
    if (had) Object.defineProperty(process.stdout, "isTTY", { value: was, configurable: true });
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

describe("runCli (fakes)", () => {
  it("unknown command or missing args → exit 2 and the synopsis", async () => {
    const fakes = fakeDeps();

    expect(await cli(fakes, "frobnicate")).toBe(EXIT.usage);
    expect(fakes.out.errors[0]).toBe('zai: unknown command "frobnicate"');
    expect(fakes.out.errors.join("\n")).toContain("  run <brief.md|->");
    expect(await cli(fakes)).toBe(EXIT.usage);

    const missing = fakeDeps();
    expect(await cli(missing, "review")).toBe(EXIT.usage);
    expect(missing.out.errors).toEqual([
      "zai: review needs a job id",
      "usage: review <id> [--diff] [--summary] [--json]",
    ]);

    const badFlag = fakeDeps();
    expect(await cli(badFlag, "board", "--bogus")).toBe(EXIT.usage);
    expect(badFlag.out.errors[0]).toMatch(/^zai: Unknown option '--bogus'/);
    expect(badFlag.out.errors[1]).toBe("usage: board [--all] [--watch] [--json]");
  });

  it("help prints every command's synopsis on stdout", async () => {
    const fakes = fakeDeps();

    expect(await cli(fakes, "--help")).toBe(EXIT.ok);
    expect(fakes.out.text).toContain("  accept <id> [--no-commit] [--force] [--no-verify] [--json]");
    expect(fakes.out.text).not.toContain("drive <id>");
  });

  it("run --wait starts a detached driver, follows the job and exits 0 on pass, 3 on any other verdict", async () => {
    const fakes = fakeDeps();
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    drivesOnSpawn(fakes);

    const code = await cli(fakes, "run", briefFile(fakes), "--wait");

    expect(code).toBe(EXIT.ok);
    expect(fakes.process.spawned).toEqual(["261006-job001"]);
    expect(fakes.out.lines[0]).toBe("zai job 261006-job001 started: Rename foo (glm-5.3, edit)");
    expect(fakes.out.lines[1]).toMatch(/^zai job 261006-job001: verdict pass \(awaiting review\)\n/);
    expect(fakes.out.lines[1]).toMatch(/\nNext: \/zai:review 261006-job001 /);
    expect(fakes.out.lines).toHaveLength(2);

    const failing = fakeDeps([{ lines: [wire.result({ report: VALID_CHANGE_REPORT })] }]);
    failing.gates.results.set("npm test", [{ exitCode: 1 }]);
    drivesOnSpawn(failing);
    const failed = await cli(failing, "run", briefFile(failing), "--wait", "--flash");

    expect(failed).toBe(EXIT.notPass);
    expect(failing.out.lines[0]).toBe("zai job 261006-job001 started: Rename foo (glm-5.3-flash, edit)");
    expect(failing.out.lines[1]).toContain("verdict gate_fail");
  });

  it("run --wait on a worker that cannot start prints the summary of the landed job, exit 3", async () => {
    const fakes = fakeDeps([{ startError: { kind: "no_key", message: "no Z.ai key: export ZAI_API_KEY" } }]);
    drivesOnSpawn(fakes);

    const code = await cli(fakes, "run", briefFile(fakes), "--wait");

    expect(code).toBe(EXIT.notPass);
    expect(fakes.out.lines[1]).toContain("verdict worker_error");
  });

  it("run --wait --json prints only the landed job as JSON", async () => {
    const fakes = fakeDeps();
    drivesOnSpawn(fakes);

    await cli(fakes, "run", briefFile(fakes), "--wait", "--json");

    expect(JSON.parse(fakes.out.text)).toMatchObject({ id: "261006-job001", state: "awaiting_review" });
  });

  it("run --wait whose driver dies reports the stale job with the stop/discard advice and exits 6", async () => {
    const fakes = fakeDeps();
    fakes.process.onSpawn = (id) => {
      const job = fakes.store.jobs.get(id);
      if (job !== undefined) fakes.store.put({ ...job, state: "running", attempts: [anAttempt()] });
      fakes.store.holdLock(id, 99_999);
    };

    const code = await cli(fakes, "run", briefFile(fakes), "--wait");

    expect(code).toBe(EXIT.notReady);
    expect(fakes.out.lines).toEqual(["zai job 261006-job001 started: Rename foo (glm-5.3, edit)"]);
    expect(fakes.out.errors).toEqual([
      "zai: job 261006-job001 is running but has no live driver; /zai:board stops it (it moves to review), /zai:review 261006-job001 then discards it.",
    ]);
  });

  it("wait follows an existing job to review and prints the summary", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", process.pid);
    afterSleeps(fakes, 3, () => {
      fakes.store.put({
        ...job,
        state: "awaiting_review",
        attempts: [anAttempt({ verification: aVerification(), verdict: "pass" })],
      });
    });

    expect(await cli(fakes, "wait", "j1")).toBe(EXIT.ok);
    expect(fakes.out.lines).toHaveLength(1);
    expect(fakes.out.lines[0]).toMatch(/^zai job j1: verdict pass \(awaiting review\)\n/);
  });

  it("wait on a job already in review, accepted or discarded prints its summary at once", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);
    let polls = 0;
    afterSleeps(fakes, 1, () => {
      polls += 1;
    });

    expect(await cli(fakes, "wait", "261006-rev")).toBe(EXIT.ok);
    expect(fakes.out.lines[0]).toMatch(/^zai job 261006-review: verdict pass \(awaiting review\)\n/);

    const accepted = fakeDeps();
    reviewable(accepted, { state: "accepted" });
    expect(await cli(accepted, "wait", "261006-review", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(accepted.out.text)).toMatchObject({ id: "261006-review", state: "accepted" });

    const discarded = fakeDeps();
    reviewable(discarded, {
      state: "discarded",
      attempts: [anAttempt({ verdict: "gate_fail", verification: aVerification() })],
    });
    expect(await cli(discarded, "wait", "261006-review")).toBe(EXIT.notPass);
    expect(discarded.out.lines[0]).toMatch(/^zai job 261006-review: verdict gate_fail \(discarded\)\n/);
    expect(polls).toBe(0);
  });

  it("wait on a stale job gives the stop/discard advice and exits 6; --json still prints the job", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", state: "verifying", attempts: [anAttempt()] }));

    expect(await cli(fakes, "wait", "j1")).toBe(EXIT.notReady);
    expect(fakes.out.lines).toEqual([]);
    expect(fakes.out.errors).toEqual([
      "zai: job j1 is verifying but has no live driver; /zai:board stops it (it moves to review), /zai:review j1 then discards it.",
    ]);

    const json = fakeDeps();
    json.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    expect(await cli(json, "wait", "j1", "--json")).toBe(EXIT.notReady);
    expect(JSON.parse(json.out.text)).toMatchObject({ id: "j1", state: "running" });
  });

  it("wait on an unknown id exits 4; without an id it is a usage error", async () => {
    const fakes = fakeDeps();

    expect(await cli(fakes, "wait", "nope")).toBe(EXIT.notFound);
    expect(fakes.out.errors).toEqual(['zai: no zai job matches "nope" (/zai:board lists them)']);
    expect(await cli(fakes, "wait")).toBe(EXIT.usage);
    expect(fakes.out.errors.slice(1)).toEqual([
      "zai: wait needs a job id",
      "usage: wait <id> [<id>…] [--json]",
    ]);
  });

  it("an interrupted follower only detaches: one line on how to wait or stop, exit 130, the job untouched", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const fakes = fakeDeps();
      const job = fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
      fakes.store.holdLock("j1", process.pid);
      afterSleeps(fakes, 2, () => process.emit(signal));

      expect(await cli(fakes, "wait", "j1")).toBe(EXIT.interrupted);
      expect(fakes.out.lines).toEqual([]);
      expect(fakes.out.errors).toEqual([
        "zai job j1 keeps running detached: /zai:board shows it and can stop it, /zai:review j1 once it awaits review.",
      ]);
      expect(fakes.store.jobs.get("j1")).toEqual(job);
      expect(fakes.process.terminated).toEqual([]);
      expect(process.listenerCount(signal)).toBe(0);
    }
  });

  it("wait on many jobs follows them all: one compact line per job as it lands, then a totals line", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);
    reviewable(fakes, {
      id: "j2",
      attempts: [
        anAttempt({
          outcome: { kind: "completed" },
          report: VALID_CHANGE_REPORT,
          usage: {
            turns: 2,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            cacheWriteTokens: 10,
            costUsd: 2,
            durationMs: 1500,
            rateLimitRetries: 0,
          },
          verification: aVerification({
            gates: [aGateResult(), aGateResult({ run: "npm run lint", exitCode: 1 })],
            changes: aChangeSet({ modified: ["src/a.ts"] }),
          }),
          verdict: "gate_fail",
        }),
      ],
    });

    expect(await cli(fakes, "wait", "261006-review", "j2")).toBe(EXIT.notPass);
    // Both jobs land on the first poll, so their lines race (two pid reads answer in either order): one line each,
    // either order, the totals always last.
    expect(fakes.out.lines).toHaveLength(3);
    expect([...fakes.out.lines.slice(0, 2).sort(), fakes.out.lines.at(-1)]).toEqual([
      "261006-review pass Rename the helper gates none est. $0.0000",
      "j2 gate_fail Rename the helper gates 1/2 est. $0.0002",
      "2 jobs: 1 pass, 1 not pass · est. $0.0002",
    ]);

    const json = fakeDeps();
    reviewable(json);
    reviewable(json, { id: "j2" });
    expect(await cli(json, "wait", "261006-review", "j2", "--json")).toBe(EXIT.ok);
    expect(JSON.parse(json.out.text).map((job: Job) => job.id)).toEqual(["261006-review", "j2"]);
  });

  it("wait on a sweep brief counts its items; a stale job among them is reported and fails the wait", async () => {
    const fakes = fakeDeps();
    reviewable(fakes, {
      brief: aBrief({ mode: "exec", report: { kind: "builtin", name: "sweep" }, title: "Sweep call sites" }),
      attempts: [
        anAttempt({
          outcome: { kind: "completed" },
          report: {
            summary: "4 sites swept",
            items: [
              { id: "src/a.ts", status: "ok", detail: "no foo left" },
              { id: "src/b.ts", status: "ok", detail: "" },
              { id: "src/c.ts", status: "fail", detail: "still calls foo" },
              { id: "src/d.ts", status: "gap", detail: "not checked" },
            ],
            open_items: [],
          },
          verification: aVerification(),
          verdict: "gate_fail",
        }),
      ],
    });
    fakes.store.put(aJob({ id: "j-stale", state: "running", attempts: [anAttempt()] }));

    expect(await cli(fakes, "wait", "261006-review", "j-stale")).toBe(EXIT.notPass);
    expect(fakes.out.lines).toEqual([
      "261006-review gate_fail Sweep call sites sweep 2/1/1 est. $0.0000",
      "j-stale stale Rename the helper gates ? est. $0.0000",
      "2 jobs: 0 pass, 2 not pass · est. $0.0000",
    ]);
    expect(fakes.out.errors).toEqual([
      "zai: job j-stale is running but has no live driver; /zai:board stops it (it moves to review), /zai:review j-stale then discards it.",
    ]);
  });

  it("an interrupted multi-wait detaches every job: one line of advice, exit 130, no totals", async () => {
    const fakes = fakeDeps();
    for (const id of ["j1", "j2"]) {
      fakes.store.put(aJob({ id, state: "running", attempts: [anAttempt()] }));
      fakes.store.holdLock(id, process.pid);
    }
    afterSleeps(fakes, 3, () => process.emit("SIGINT"));

    expect(await cli(fakes, "wait", "j1", "j2")).toBe(EXIT.interrupted);
    expect(fakes.out.lines).toEqual([]);
    expect(fakes.out.errors).toEqual([
      "zai job j1 keeps running detached: /zai:board shows it and can stop it, /zai:review j1 once it awaits review.",
    ]);
  });

  it("run --bg submits, spawns a driver, prints the job id, exits 0", async () => {
    const fakes = fakeDeps();

    const code = await cli(fakes, "run", briefFile(fakes), "--mode", "exec");

    expect(code).toBe(EXIT.ok);
    expect(fakes.process.spawned).toEqual(["261006-job001"]);
    expect(fakes.out.lines).toEqual([
      "zai job 261006-job001 started: Rename foo (glm-5.3-flash, exec)",
      "Running detached: /zai:board shows it, /zai:review 261006-job001 once it awaits review.",
    ]);
    expect(fakes.worker.specs).toEqual([]);
  });

  it("run rejects bad input before submitting: an unreadable brief, an invalid one, --wait with --bg, a bad mode", async () => {
    const fakes = fakeDeps();

    expect(await cli(fakes, "run", "/nope/brief.md")).toBe(EXIT.usage);
    expect(fakes.out.errors[0]).toMatch(/^zai: cannot read \/nope\/brief\.md: ENOENT/);
    expect(await cli(fakes, "run", briefFile(fakes, "---\nmode: edit\n---\n\n"))).toBe(EXIT.usage);
    expect(fakes.out.errors.at(-1)).toBe("zai: invalid brief: title: required; the body (the task) is empty");
    expect(await cli(fakes, "run", briefFile(fakes), "--wait", "--bg")).toBe(EXIT.usage);
    expect(await cli(fakes, "run", briefFile(fakes), "--mode", "yolo")).toBe(EXIT.usage);
    expect(fakes.out.errors).toContain("zai: --mode must be edit, exec or readonly");
    expect(fakes.store.jobs.size).toBe(0);
  });

  it("run --json prints the submitted job as JSON", async () => {
    const fakes = fakeDeps();

    await cli(fakes, "run", briefFile(fakes), "--bg", "--json");

    expect(JSON.parse(fakes.out.text)).toMatchObject({ id: "261006-job001", state: "queued" });
  });

  it("review prints the packet; --json prints the ReviewPacket as JSON", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);

    expect(await cli(fakes, "review", "261006-rev", "--diff")).toBe(EXIT.ok);
    expect(fakes.out.text).toMatch(/^zai job 261006-review: Rename the helper\nverdict pass/);
    expect(fakes.out.text).toContain("```diff\ndiff --git a/src/a.ts b/src/a.ts\n+bar\n```");

    const json = fakeDeps();
    const jsonJob = reviewable(json);
    await cli(json, "review", "261006-review", "--json");

    expect(JSON.parse(json.out.text)).toEqual({ job: jsonJob, diffStat: json.git.diffStat });
  });

  it("review --summary prints verdict, gates and report — no diff, changes or next actions", async () => {
    const fakes = fakeDeps();
    reviewable(fakes, {
      attempts: [
        anAttempt({
          outcome: { kind: "completed" },
          report: { ...VALID_CHANGE_REPORT, open_items: ["docs lag"] },
          verification: aVerification({
            gates: [
              aGateResult(),
              aGateResult({ run: "npm run lint", exitCode: 1, tail: "lint: 1 problem\n" }),
            ],
            changes: aChangeSet({ modified: ["src/a.ts"] }),
          }),
          verdict: "gate_fail",
        }),
      ],
    });

    expect(await cli(fakes, "review", "261006-review", "--summary")).toBe(EXIT.ok);
    expect(fakes.out.text).toMatch(
      /^zai job 261006-review: Rename the helper\nverdict gate_fail · glm-5\.3 · edit · attempt 1 \(initial\) · awaiting review\n/,
    );
    expect(fakes.out.text).toContain("Gates (1/2 passed)");
    expect(fakes.out.text).toContain("npm run lint");
    expect(fakes.out.text).toContain("Report");
    expect(fakes.out.text).toContain("- docs lag");
    expect(fakes.out.text).not.toContain("```diff");
    expect(fakes.out.text).not.toContain("Diff stat");
    expect(fakes.out.text).not.toContain("Changes (");
    expect(fakes.out.text).not.toContain("Next");

    expect(await cli(fakes, "review", "261006-review", "--diff", "--summary")).toBe(EXIT.usage);
    expect(fakes.out.errors).toEqual([
      "zai: --diff and --summary exclude each other",
      "usage: review <id> [--diff] [--summary] [--json]",
    ]);
  });

  it("review --summary on a sweep shows only the failing items", async () => {
    const fakes = fakeDeps();
    reviewable(fakes, {
      brief: aBrief({ mode: "exec", report: { kind: "builtin", name: "sweep" }, title: "Sweep call sites" }),
      attempts: [
        anAttempt({
          outcome: { kind: "completed" },
          report: {
            summary: "4 sites swept",
            items: [
              { id: "src/a.ts", status: "ok", detail: "no foo left" },
              { id: "src/b.ts", status: "ok", detail: "" },
              { id: "src/c.ts", status: "fail", detail: "still calls foo" },
              { id: "src/d.ts", status: "gap", detail: "not checked" },
            ],
            open_items: [],
          },
          verification: aVerification(),
          verdict: "gate_fail",
        }),
      ],
    });

    expect(await cli(fakes, "review", "261006-review", "--summary")).toBe(EXIT.ok);
    expect(fakes.out.text).toContain("Sweep (failing only)");
    expect(fakes.out.text).toContain("src/c.ts: fail — still calls foo");
    expect(fakes.out.text).toContain("src/d.ts: gap — not checked");
    expect(fakes.out.text).not.toContain("src/a.ts: ok");
    expect(fakes.out.text).not.toContain("src/b.ts: ok");
  });

  it("accept exits 5 on conflict; return requires feedback text; ids resolve by prefix; unknown id → 4", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    fakes.git.isAncestorResult = ok(false);
    fakes.git.rebaseResult = err({ kind: "conflict", paths: ["src/a.ts"] });

    expect(await cli(fakes, "accept", "261006-r")).toBe(EXIT.conflict);
    expect(fakes.out.errors).toEqual([
      "zai: conflict in src/a.ts: nothing was applied. The worker cannot rebase (it never commits or switches branches): discard the job with /zai:review and run the brief again on the current branch, or merge the job's branch by hand.",
    ]);
    expect(await cli(fakes, "return", "261006-r")).toBe(EXIT.usage);
    expect(await cli(fakes, "return", "261006-r", "Rename", "the", "tests", "too.")).toBe(EXIT.ok);
    expect(fakes.store.jobs.get("261006-review")?.attempts.at(-1)?.feedback).toBe("Rename the tests too.");
    expect(fakes.process.spawned).toEqual(["261006-review"]);
    expect(fakes.out.lines.at(-1)).toBe(
      "zai job 261006-review returned with feedback: attempt 2 runs detached. /zai:review 261006-review once it awaits review again.",
    );
    expect(await cli(fakes, "show", "999")).toBe(EXIT.notFound);
    expect(fakes.out.errors.at(-1)).toBe('zai: no zai job matches "999" (/zai:board lists them)');
  });

  it("accept lands the job and says where; --force accepts a non-pass verdict; --no-verify skips commit hooks", async () => {
    const fakes = fakeDeps();
    reviewable(fakes, { attempts: [anAttempt({ verdict: "gate_fail", verification: aVerification() })] });
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });

    expect(await cli(fakes, "accept", "261006-review")).toBe(EXIT.notPass);
    expect(fakes.out.errors).toEqual([
      "zai: job 261006-review has verdict gate_fail, not pass: accept --force to accept it anyway",
    ]);
    expect(await cli(fakes, "accept", "261006-review", "--force", "--no-verify")).toBe(EXIT.ok);
    expect(fakes.git.called("commitAll")[0]?.[2]).toEqual({ verify: false });
    expect(fakes.out.lines).toEqual([
      "zai job 261006-review accepted: commit cccccccccccc on the current branch of /repo",
    ]);
  });

  it("accept --no-commit applies to the working tree; a failing commit hook explains how to proceed", async () => {
    const applied = fakeDeps();
    reviewable(applied);
    await cli(applied, "accept", "261006-review", "--no-commit");
    expect(applied.out.lines).toEqual([
      "zai job 261006-review accepted: applied to the working tree of /repo, not committed",
    ]);

    const hooked = fakeDeps();
    reviewable(hooked);
    hooked.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    hooked.git.commitResult = err({ kind: "git_failed", command: "git commit", stderr: "lint: 2 problems" });

    expect(await cli(hooked, "accept", "261006-review")).toBe(EXIT.unexpected);
    expect(hooked.out.errors).toEqual([
      "zai: git commit: lint: 2 problems",
      "zai: the job still awaits review. Fix what the commit hook reports, then accept it again.",
    ]);

    const exec = fakeDeps();
    reviewable(exec, { brief: aBrief({ mode: "exec", scope: [] }) });
    await cli(exec, "accept", "261006-review");
    expect(exec.out.lines).toEqual(["zai job 261006-review accepted (exec: nothing to merge)"]);
  });

  it("discard --reason records why; stop asks a live driver and stops an idle job at once", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);

    expect(await cli(fakes, "discard", "261006-review", "--reason", "wrong approach")).toBe(EXIT.ok);
    expect(fakes.store.jobs.get("261006-review")?.decision).toMatchObject({ reason: "wrong approach" });
    expect(fakes.out.lines).toEqual(["zai job 261006-review discarded: wrong approach"]);

    const stops = fakeDeps();
    stops.store.put(aJob({ id: "j-live", state: "running", attempts: [anAttempt()] }));
    stops.store.holdLock("j-live", 4242);
    stops.store.put(aJob({ id: "j-idle", state: "queued" }));
    stops.store.put(aJob({ id: "j-done", state: "accepted" }));

    expect(await cli(stops, "stop", "--all")).toBe(EXIT.ok);
    expect(stops.out.lines).toEqual([
      'zai job j-live: stopping; it will wait for your review as "stopped"',
      "zai job j-idle stopped: awaiting review",
    ]);
    expect(await cli(stops, "stop", "j-done")).toBe(EXIT.usage);
    expect(stops.out.errors).toEqual([
      "zai: job j-done was already accepted; this only works on a job that is queued, is running or is being verified",
    ]);
    expect(await cli(stops, "stop")).toBe(EXIT.usage);
  });

  it("board lists this repository's jobs; board --hook prints one line only when jobs await review or run", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);
    fakes.store.put(aJob({ id: "j-elsewhere", workspace: { ...aJob().workspace, repoRoot: "/other" } }));

    expect(await cli(fakes, "board")).toBe(EXIT.ok);
    expect(fakes.out.text).toMatch(/^KIND +ID/);
    expect(fakes.out.text).not.toContain("j-elsewhere");
    expect(await cli(fakes, "board", "--hook")).toBe(EXIT.ok);
    expect(fakes.out.lines.at(-1)).toBe(
      "zai: 1 job awaits review (/zai:review 261006-review). /zai:board lists them.",
    );

    const quiet = fakeDeps();
    quiet.store.put(aJob({ state: "accepted" }));
    expect(await cli(quiet, "board", "--hook")).toBe(EXIT.ok);
    expect(quiet.out.lines).toEqual([]);

    const broken = fakeDeps();
    broken.deps.store.list = async () => {
      throw new Error("disk on fire");
    };
    expect(await runCli(["board", "--hook"], broken.deps, "/elsewhere")).toBe(EXIT.ok);
    expect(await runCli(["board", "--hook"], broken.deps, "/repo")).toBe(EXIT.ok);
    expect([...broken.out.lines, ...broken.out.errors]).toEqual([]);
  });

  it("board --all and --json; show prints one job; usage prints the ledger after the spool windows", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);
    fakes.store.put(aJob({ id: "j-elsewhere", workspace: { ...aJob().workspace, repoRoot: "/other" } }));

    await cli(fakes, "board", "--all", "--json");
    expect(
      JSON.parse(fakes.out.text).map((row: { kind: string; id: string }) => `${row.kind} ${row.id}`),
    ).toEqual(["job j-elsewhere", "job 261006-review"]);

    const show = fakeDeps();
    reviewable(show);
    expect(await cli(show, "show", "261006-review")).toBe(EXIT.ok);
    expect(show.out.text).toMatch(
      /^zai job 261006-review: Rename the helper\nawaiting review · glm-5\.3 · edit · created just now · updated just now\n/,
    );

    const usage = fakeDeps();
    reviewable(usage, { state: "accepted" });
    expect(await cli(usage, "usage")).toBe(EXIT.ok);
    expect(usage.out.text).toMatch(/^Z\.ai GLM usage\nEst\. cost: today \$/);
    expect(usage.out.text).toContain("\nToday: no agent or /model requests.\n");
    expect(usage.out.text).toContain("\nzai jobs in this repository\n");
    expect(await cli(usage, "usage", "--all")).toBe(EXIT.usage);

    const json = fakeDeps();
    reviewable(json, { state: "accepted" });
    await cli(json, "usage", "--json");
    const parsed = JSON.parse(json.out.text);
    expect(parsed.spool.map((window: { label: string }) => window.label)).toEqual([
      "Today",
      "Last 7 days",
      "Last 30 days",
    ]);
    expect(parsed.jobs).toEqual(expect.any(Array));
  });

  it("board --watch redraws the board every 2 s on a TTY until Ctrl-C; off a TTY it prints once", async () => {
    const fakes = fakeDeps();
    reviewable(fakes);
    afterSleeps(fakes, 3, () => process.emit("SIGINT"));

    expect(await withTty(true, () => cli(fakes, "board", "--watch"))).toBe(EXIT.ok);
    expect(fakes.out.lines).toHaveLength(3);
    for (const board of fakes.out.lines) expect(board).toMatch(/^KIND +ID/);

    const plain = fakeDeps();
    reviewable(plain);
    expect(await withTty(false, () => cli(plain, "board", "--watch"))).toBe(EXIT.ok);
    expect(plain.out.lines).toHaveLength(1);
  });

  it("show --follow prints progress changes until the job leaves running, then the job", async () => {
    const fakes = fakeDeps();
    const job = fakes.store.put(aJob({ id: "j1", state: "running", attempts: [anAttempt()] }));
    fakes.store.holdLock("j1", process.pid);
    let polls = 0;
    const sleep = fakes.clock.sleep.bind(fakes.clock);
    fakes.deps.clock.sleep = async (ms, signal) => {
      polls += 1;
      if (polls === 2)
        writeFileSync(fakes.store.paths("j1").attemptLog(1), `${wire.tool("Bash", { command: "ls" })}\n`);
      if (polls === 4) fakes.store.put({ ...job, state: "awaiting_review" });
      await sleep(ms, signal);
    };

    expect(await cli(fakes, "show", "j1", "--follow")).toBe(EXIT.ok);
    expect(fakes.out.lines.slice(0, 2)).toEqual(["running", "running · tool Bash ls · 1 tool call"]);
    expect(fakes.out.lines.at(-1)).toMatch(/^zai job j1: Rename the helper\nawaiting review/);
  });

  it("batch submits a directory or manifest of briefs, spawning a driver per job; rejected ones exit 2", async () => {
    const fakes = fakeDeps();
    const dir = join(fakes.root, "briefs");
    briefFile(fakes, BRIEF, "briefs/a.md");
    briefFile(fakes, "not a brief", "briefs/b.md");
    briefFile(fakes, "ignored", "briefs/notes.txt");

    expect(await cli(fakes, "batch", dir)).toBe(EXIT.usage);
    expect(fakes.out.lines).toEqual([`submitted 261006-job001: Rename foo (${join(dir, "a.md")})`]);
    expect(fakes.out.errors).toEqual([
      `zai: rejected ${join(dir, "b.md")}: invalid brief: no YAML front matter (start the file with ---)`,
    ]);
    expect(fakes.process.spawned).toEqual(["261006-job001"]);

    const listed = fakeDeps();
    briefFile(listed, BRIEF, "one.md");
    briefFile(listed, BRIEF, "two.md");
    const manifest = briefFile(listed, "# the list\none.md\n\ntwo.md\n", "jobs.txt");
    expect(await cli(listed, "batch", manifest)).toBe(EXIT.ok);
    expect(listed.process.spawned).toHaveLength(2);

    const globbed = fakeDeps();
    briefFile(globbed, BRIEF.replace("title:", "cwd: /repo\ntitle:"), "g1.md");
    expect(await runCli(["batch", "*.md", "--json"], globbed.deps, globbed.root)).toBe(EXIT.ok);
    expect(JSON.parse(globbed.out.text).submitted).toHaveLength(1);

    const empty = fakeDeps();
    expect(await runCli(["batch", "*.md"], empty.deps, empty.root)).toBe(EXIT.usage);
    expect(empty.out.errors).toEqual(["zai: no briefs found for *.md"]);
  });

  it("batch --wait follows every submitted job: submitted lines, one compact line each as they land, then totals", async () => {
    const fakes = fakeDeps();
    fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
    const dir = join(fakes.root, "briefs");
    briefFile(fakes, BRIEF, "briefs/one.md");
    briefFile(fakes, BRIEF, "briefs/two.md");
    drivesOnSpawn(fakes);

    expect(await cli(fakes, "batch", dir, "--wait")).toBe(EXIT.ok);
    // The jobs run concurrently, so their lines come in landing order: compare that middle part as a set.
    const [one, two, ...landed] = fakes.out.lines;
    const totals = landed.pop();
    expect([one, two]).toEqual([
      `submitted 261006-job001: Rename foo (${join(dir, "one.md")})`,
      `submitted 261006-job002: Rename foo (${join(dir, "two.md")})`,
    ]);
    expect(landed.sort()).toEqual([
      "261006-job001 pass Rename foo gates 1/1 est. $0.0002",
      "261006-job002 pass Rename foo gates 1/1 est. $0.0002",
    ]);
    expect(totals).toBe("2 jobs: 2 pass, 0 not pass · est. $0.0005");

    const mixed = fakeDeps();
    const mixedDir = join(mixed.root, "briefs");
    briefFile(mixed, BRIEF, "briefs/one.md");
    briefFile(mixed, "not a brief", "briefs/two.md");
    drivesOnSpawn(mixed);
    expect(await cli(mixed, "batch", mixedDir, "--wait")).toBe(EXIT.usage);
    expect(mixed.out.lines).toEqual([
      `submitted 261006-job001: Rename foo (${join(mixedDir, "one.md")})`,
      "261006-job001 pass Rename foo gates 1/1 est. $0.0002",
      "1 job: 1 pass, 0 not pass · est. $0.0002",
    ]);

    const clashing = fakeDeps();
    expect(await cli(clashing, "batch", "briefs", "--wait", "--json")).toBe(EXIT.usage);
    expect(clashing.out.errors).toEqual([
      "zai: --wait and --json exclude each other",
      "usage: batch <dir|glob|manifest.txt> [--wait] [--json]",
    ]);
  });

  it("brief new prints a path to a fresh template; brief lint reports errors with exit 2", async () => {
    const fakes = fakeDeps();

    expect(await cli(fakes, "brief", "new", "Rename foo/bar!", "--mode", "exec")).toBe(EXIT.ok);
    const [path = ""] = fakes.out.lines;
    expect(path).toBe(join(fakes.root, "briefs", "rename-foo-bar.md"));
    expect(fakes.out.lines).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toContain('title: "Rename foo/bar!"\n# edit:');
    expect(readFileSync(path, "utf8")).toContain("mode: exec");
    await cli(fakes, "brief", "new", "Rename foo/bar!");
    expect(fakes.out.lines[1]).toBe(join(fakes.root, "briefs", "rename-foo-bar-2.md"));

    expect(await cli(fakes, "brief", "lint", path)).toBe(EXIT.usage);
    expect(fakes.out.lines.slice(2)).toEqual([`${path}: the body still has the TODO placeholder`]);
    expect(await cli(fakes, "brief", "lint", briefFile(fakes, "---\nmodel: gpt\n---\n"))).toBe(EXIT.usage);
    expect(fakes.out.lines.slice(3)).toEqual([
      `${join(fakes.root, "brief.md")}: title: required`,
      `${join(fakes.root, "brief.md")}: model: must be one of glm, glm-5.3, flash, glm-5.3-flash`,
      `${join(fakes.root, "brief.md")}: the body (the task) is empty`,
    ]);
    expect(await cli(fakes, "brief", "lint", briefFile(fakes))).toBe(EXIT.ok);
    expect(fakes.out.lines.at(-1)).toBe("ok: Rename foo (glm-5.3, edit, 1 gate)");
    expect(await cli(fakes, "brief", "frob")).toBe(EXIT.usage);
  });

  it("setup reports the runtime, binary, version, key present (never the value), state dir, cap; exit 6 when not ready", async () => {
    const fakes = fakeDeps(undefined, { ZAI_API_KEY: "sk-zai-secret" });

    expect(await cli(fakes, "setup")).toBe(EXIT.ok);
    expect(fakes.out.text).toBe(
      [
        "zai setup: ready. GLM 5.3 and GLM 5.3 Flash are in /model; zai:glm-5.3 and zai:glm-5.3-flash run on them.",
        "  runtime:  bun 1.3.14 (/usr/local/bin/bun)",
        "  claude:   /usr/local/bin/claude (2.1.289 (Claude Code))",
        "  key:      present (ZAI_API_KEY)",
        "  ping:     ok: glm-5.3-flash answered (2 turns, est. $0.0000)",
        "  router:   running on http://127.0.0.1:18787 (pid 4242)",
        "  models:   glm-5.3, glm-5.3-flash",
        `  settings: ${join(fakes.root, "home", ".claude", "settings.json")} (updated: added GLM 5.3 (glm-5.3) to /model; added GLM 5.3 Flash (glm-5.3-flash) to /model; set GLM 5.3 default effort to xhigh; set GLM 5.3 Flash default effort to xhigh; pointed ANTHROPIC_BASE_URL at http://127.0.0.1:18787; turned on MCP tool search)`,
        "Restart Claude Code now. This session keeps talking to Anthropic until it restarts; GLM 5.3 in /model and the zai agents work from the next session.",
      ].join("\n"),
    );
    expect(fakes.out.text).not.toContain("sk-zai-secret");

    const broken = fakeDeps();
    broken.host.version = err("spawn claude ENOENT");
    broken.host.keyResult = err({ kind: "no_key", message: "no Z.ai key: export ZAI_API_KEY" });

    expect(await cli(broken, "setup", "--json")).toBe(EXIT.notReady);
    expect(JSON.parse(broken.out.text)).toMatchObject({
      ready: false,
      runtime: "bun 1.3.14 (/usr/local/bin/bun)",
      claude: { ok: false, error: "spawn claude ENOENT" },
      key: { ok: false, error: "no Z.ai key: export ZAI_API_KEY" },
    });
  });

  it("setup --ping makes one tiny readonly flash call and reports it", async () => {
    const fakes = fakeDeps([completes({ summary: "pong", findings: [], open_items: [] })]);

    expect(await cli(fakes, "setup", "--ping")).toBe(EXIT.ok);
    expect(fakes.worker.specs).toHaveLength(1);
    expect(fakes.worker.specs[0]).toMatchObject({
      model: { tier: "flash" },
      access: "readonly",
      cwd: fakes.root,
      passEnv: {},
    });
    expect(fakes.out.text).toContain("  ping:     ok: glm-5.3-flash answered (2 turns, est. $0.0000)");

    const failing = fakeDeps([{ lines: [wire.result({ isError: true, text: "API Error: 401 bad key" })] }]);
    expect(await cli(failing, "setup", "--ping")).toBe(EXIT.notReady);
    expect(failing.out.text).toContain("  ping:     FAILED: API error: API Error: 401 bad key");
  });

  it("drive runs a queued job to review (the detached driver's entry)", async () => {
    const fakes = fakeDeps();
    fakes.store.put(aJob({ id: "j1", workspace: { ...aJob().workspace, worktree: join(fakes.root, "wt") } }));

    expect(await cli(fakes, "drive", "j1")).toBe(EXIT.ok);
    expect(fakes.store.jobs.get("j1")?.state).toBe("awaiting_review");
    expect(await cli(fakes, "drive", "j1")).toBe(EXIT.usage);
  });

  it("an unexpected failure is one line on stderr and exit 1", async () => {
    const fakes = fakeDeps();
    fakes.deps.store.find = async () => {
      throw new Error("disk on fire");
    };

    expect(await cli(fakes, "show", "x")).toBe(EXIT.unexpected);
    expect(fakes.out.errors).toEqual(["zai: unexpected error: disk on fire"]);
  });
});
