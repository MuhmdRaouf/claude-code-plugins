import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { drive } from "../../src/app/drive.ts";
import type { Brief } from "../../src/domain/brief.ts";
import type { Attempt, Job } from "../../src/domain/job.ts";
import { autoFixPrompt, DEFAULT_LIMITS, initialPrompt, reviewFixPrompt } from "../../src/domain/prompt.ts";
import { err } from "../../src/domain/result.ts";
import { aBrief, aChangeSet, aJob, anAttempt, aVerification } from "../support/builders.ts";
import {
  completes,
  type Fakes,
  fakeDeps,
  VALID_CHANGE_REPORT,
  type WorkerScript,
  wire,
} from "../support/fakes.ts";
import { REFERENCE_PROVIDER } from "../support/provider.ts";
import { until } from "../support/wait.ts";

const ID = "261006-drive1";
const GATED: Partial<Brief> = { gates: [{ run: "npm test", timeoutMs: 60_000 }] };

/** A queued job in the fake store, its artifacts dir under the fake state root. */
function queued(fakes: Fakes, brief: Partial<Brief> = {}, overrides: Partial<Job> = {}): Job {
  const paths = fakes.store.paths(ID);
  const edit = (brief.mode ?? "edit") === "edit";
  return fakes.store.put(
    aJob({
      id: ID,
      brief: aBrief(brief),
      workspace: {
        repoRoot: "/repo",
        baseSha: "b".repeat(40),
        ...(edit ? { worktree: paths.worktree, branch: `zai/${ID}` } : {}),
        artifactsDir: paths.artifacts,
      },
      ...overrides,
    }),
  );
}

function setup(scripts?: WorkerScript[], env: Record<string, string> = {}): Fakes {
  const fakes = fakeDeps(scripts, env);
  fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
  return fakes;
}

function stored(fakes: Fakes): Job {
  const job = fakes.store.jobs.get(ID);
  if (job === undefined) throw new Error("job not stored");
  return job;
}

function attempt(fakes: Fakes, n: number): Attempt {
  const found = stored(fakes).attempts[n - 1];
  if (found === undefined) throw new Error(`no attempt ${n}`);
  return found;
}

describe("drive", () => {
  it("happy path: queued → running → verifying → awaiting_review with verdict pass, one attempt persisted", async () => {
    const fakes = setup();
    const job = queued(fakes, GATED);

    const result = await drive(fakes.deps, ID);

    expect(result).toEqual({ ok: true, value: stored(fakes) });
    expect(stored(fakes).state).toBe("awaiting_review");
    expect(stored(fakes).attempts).toHaveLength(1);
    expect(attempt(fakes, 1)).toMatchObject({
      n: 1,
      kind: "initial",
      prompt: initialPrompt(job.brief, job.workspace.artifactsDir, REFERENCE_PROVIDER),
      sessionId: "00000000-0000-4000-8000-000000000001",
      outcome: { kind: "completed" },
      usage: { turns: 2, inputTokens: 100, outputTokens: 20, costUsd: 0.01, rateLimitRetries: 0 },
      report: { summary: "Renamed foo to bar" },
      verification: {
        gates: [{ run: "npm test", exitCode: 0 }],
        changes: aChangeSet({ modified: ["src/a.ts"] }),
        scope: { outOfScope: [], forbidden: [], repoChanged: false },
        report: { present: true, valid: true, problems: [] },
      },
      verdict: "pass",
    });
    expect(attempt(fakes, 1).endedAt).toBeDefined();
    expect(fakes.worker.specs[0]).toMatchObject({
      cwd: job.workspace.worktree,
      model: { tier: "main", id: "glm-5.3" },
      access: "write",
      session: { kind: "new", key: "00000000-0000-4000-8000-000000000001" },
      logPath: fakes.store.paths(ID).attemptLog(1),
      timeoutMs: job.brief.timeoutMs,
    });
    expect(fakes.gates.calls).toMatchObject([
      { cwd: job.workspace.worktree, run: "npm test", logPath: fakes.store.paths(ID).gateLog(1, 0) },
    ]);
  });

  it("persists state transitions in order (store sees running before verifying before awaiting_review)", async () => {
    const fakes = setup();
    queued(fakes, GATED);

    await drive(fakes.deps, ID);

    expect(fakes.store.states(ID)).toEqual(["running", "verifying", "awaiting_review"]);
    expect(fakes.store.writes.map((job) => job.version)).toEqual([1, 2, 3]);
  });

  it("gate failure with fix budget → second attempt kind auto_fix resuming the same session with autoFixPrompt", async () => {
    const fakes = setup([completes(), completes()]);
    fakes.gates.failOnce("npm test", "expected 2, got 1");
    const job = queued(fakes, GATED);

    await drive(fakes.deps, ID);

    const [first, second] = fakes.worker.specs;
    expect(stored(fakes).attempts.map((a) => [a.kind, a.verdict])).toEqual([
      ["initial", "gate_fail"],
      ["auto_fix", "pass"],
    ]);
    expect(second?.session).toEqual({ kind: "resume", key: first?.session.key });
    expect(second?.prompt).toBe(autoFixPrompt(job.brief, attempt(fakes, 1), DEFAULT_LIMITS));
    expect(second?.prompt).toContain("expected 2, got 1");
    expect(fakes.store.states(ID)).toEqual([
      "running",
      "verifying",
      "running",
      "verifying",
      "awaiting_review",
    ]);
  });

  it("fix budget exhausted → awaiting_review with gate_fail", async () => {
    const fakes = setup();
    fakes.gates.results.set("npm test", [{ exitCode: 1, tail: "still failing" }]);
    queued(fakes, { ...GATED, retries: { fix: 1, infra: 2 } });

    await drive(fakes.deps, ID);

    expect(stored(fakes).state).toBe("awaiting_review");
    expect(stored(fakes).attempts.map((a) => [a.kind, a.verdict])).toEqual([
      ["initial", "gate_fail"],
      ["auto_fix", "gate_fail"],
    ]);
  });

  it("api_error (429 exhausted) → infra_retry with a NEW session and the initial prompt, then pass", async () => {
    const fakes = setup([{ fixture: "rate-limited-429.jsonl", exit: { code: 1 } }, completes()]);
    const job = queued(fakes);

    await drive(fakes.deps, ID);

    const [first, second] = fakes.worker.specs;
    expect(attempt(fakes, 1)).toMatchObject({
      kind: "initial",
      verdict: "worker_error",
      outcome: { kind: "api_error", status: 429 },
    });
    expect(attempt(fakes, 2)).toMatchObject({ kind: "infra_retry", verdict: "pass" });
    expect(second?.session.kind).toBe("new");
    expect(second?.session.key).not.toBe(first?.session.key);
    expect(second?.prompt).toBe(initialPrompt(job.brief, job.workspace.artifactsDir, REFERENCE_PROVIDER));
  });

  it("hands the worker the brief's report contract and releases the worker when the driver is done", async () => {
    const fakes = setup();
    queued(fakes);

    await drive(fakes.deps, ID);

    const report = fakes.worker.specs[0]?.report;
    expect(report?.name).toBe("change");
    expect(report?.jsonSchema).toMatchObject({ required: expect.arrayContaining(["summary", "files"]) });
    expect(report?.validate({})).toMatchObject({ present: true, valid: false });
    expect(report?.validate(VALID_CHANGE_REPORT)).toEqual({ present: true, valid: true, problems: [] });
    expect(fakes.worker.disposed).toBe(1);
  });

  it("every 429 api_retry event is reported to the limiter", async () => {
    const fakes = setup([
      { lines: [wire.retry(429, 1), wire.retry(529, 2), wire.retry(429, 3), wire.result({ report: {} })] },
    ]);
    queued(fakes, { retries: { fix: 0, infra: 0 } });

    await drive(fakes.deps, ID);

    expect(fakes.limiter.rateLimitedAt).toHaveLength(2);
    expect(attempt(fakes, 1).usage?.rateLimitRetries).toBe(2);
  });

  it("skips gates when the worker did not complete", async () => {
    const fakes = setup([{ lines: [wire.text("thinking")], exit: { code: 1, stderrTail: "boom" } }]);
    queued(fakes, { ...GATED, retries: { fix: 1, infra: 0 } });

    await drive(fakes.deps, ID);

    expect(fakes.gates.calls).toEqual([]);
    expect(attempt(fakes, 1)).toMatchObject({
      outcome: { kind: "crashed", exitCode: 1, stderrTail: "boom" },
      verification: { gates: [] },
      verdict: "worker_error",
    });
  });

  it("exec mode: repository fingerprint change → scope_violation", async () => {
    const fakes = setup();
    fakes.git.fingerprints = ["fp-before", "fp-after"];
    fakes.git.changeSet = aChangeSet({ modified: ["README.md"] });
    const job = queued(fakes, { mode: "exec", scope: [], retries: { fix: 0, infra: 0 }, report: sweep() });

    await drive(fakes.deps, ID);

    expect(fakes.git.called("statusFingerprint")).toEqual([["/repo"], ["/repo"]]);
    expect(attempt(fakes, 1)).toMatchObject({
      verification: {
        changes: aChangeSet({ modified: ["README.md"] }),
        scope: { outOfScope: [], forbidden: [], repoChanged: true },
      },
      verdict: "scope_violation",
    });
    expect(fakes.worker.specs[0]).toMatchObject({
      cwd: "/repo",
      access: "exec",
      addDirs: [job.workspace.artifactsDir],
      passEnv: { ZAI_ARTIFACTS: job.workspace.artifactsDir },
    });
  });

  it("readonly mode: an unchanged repository passes; the worker runs in plan mode", async () => {
    const fakes = setup([completes({ summary: "found it", findings: [], open_items: [] })]);
    fakes.git.fingerprints = ["fp-same"];
    queued(fakes, { mode: "readonly", scope: [], report: { kind: "builtin", name: "notes" } });

    await drive(fakes.deps, ID);

    expect(fakes.worker.specs[0]?.access).toBe("readonly");
    expect(attempt(fakes, 1)).toMatchObject({
      verification: { changes: aChangeSet(), scope: { repoChanged: false } },
      verdict: "pass",
    });
    expect(fakes.git.called("changes")).toEqual([]);
  });

  it("a returned job runs a review_fix attempt with reviewFixPrompt and the reviewer's feedback", async () => {
    const fakes = setup();
    const brief = aBrief(GATED);
    const reviewed = anAttempt({ sessionId: "s-earlier", verification: aVerification(), verdict: "pass" });
    const feedback = "Also rename the test file.";
    const pending = anAttempt({
      n: 2,
      kind: "review_fix",
      feedback,
      prompt: reviewFixPrompt(brief, reviewed, feedback),
      sessionId: "s-earlier",
    });
    queued(fakes, GATED, { attempts: [reviewed, pending] });

    await drive(fakes.deps, ID);

    expect(fakes.worker.specs[0]).toMatchObject({
      session: { kind: "resume", key: "s-earlier" },
      prompt: pending.prompt,
      logPath: fakes.store.paths(ID).attemptLog(2),
    });
    expect(stored(fakes).attempts).toHaveLength(2);
    expect(attempt(fakes, 2)).toMatchObject({ kind: "review_fix", feedback, verdict: "pass" });
  });

  it("stop signal mid-run terminates the worker and ends with verdict stopped", async () => {
    const fakes = setup([{ lines: [wire.text("working")], hang: true }]);
    queued(fakes, { retries: { fix: 1, infra: 2 } });
    const controller = new AbortController();

    const driving = drive(fakes.deps, ID, controller.signal);
    await expect.poll(() => fakes.worker.specs.length).toBe(1);
    controller.abort();
    const result = await driving;

    expect(result.ok).toBe(true);
    expect(fakes.process.terminated).toEqual([50_000]);
    expect(stored(fakes).state).toBe("awaiting_review");
    expect(stored(fakes).attempts).toHaveLength(1);
    expect(attempt(fakes, 1)).toMatchObject({ outcome: { kind: "stopped" }, verdict: "stopped" });
  });

  it("a stop file (zai stop) ends the run the same way and is consumed", async () => {
    const fakes = setup([{ lines: [wire.text("working")], hang: true }]);
    queued(fakes);

    const driving = drive(fakes.deps, ID);
    await expect.poll(() => fakes.worker.specs.length).toBe(1);
    await fakes.deps.files.requestStop(fakes.store.paths(ID));
    await driving;

    expect(attempt(fakes, 1).verdict).toBe("stopped");
    expect(existsSync(`${fakes.store.paths(ID).dir}/stop`)).toBe(false);
  });

  it("a stop while waiting for a slot ends in awaiting_review with verdict stopped, no worker started", async () => {
    const fakes = setup();
    fakes.semaphore.blocked = true;
    queued(fakes);
    const controller = new AbortController();

    const driving = drive(fakes.deps, ID, controller.signal);
    await until(() => fakes.semaphore.waiting > 0);
    controller.abort();
    await driving;

    expect(fakes.worker.specs).toEqual([]);
    expect(fakes.store.states(ID)).toEqual(["awaiting_review"]);
    expect(stored(fakes).attempts).toMatchObject([{ n: 1, kind: "initial", outcome: { kind: "stopped" } }]);
    expect(attempt(fakes, 1).verdict).toBe("stopped");
  });

  it("a stop requested during verification lands the verdict without starting a retry", async () => {
    const fakes = setup([completes(), completes()]);
    queued(fakes, GATED);
    fakes.gates.run = async (cwd, gate) => {
      // No grace period: the driver must see a stop requested any time before it decides, not only once its watcher polls.
      await fakes.deps.files.requestStop(fakes.store.paths(ID));
      return { run: gate.run, exitCode: 1, timedOut: false, durationMs: 1, tail: cwd };
    };

    await drive(fakes.deps, ID);

    expect(fakes.worker.specs).toHaveLength(1);
    expect(stored(fakes).state).toBe("awaiting_review");
    expect(attempt(fakes, 1).verdict).toBe("gate_fail");
    // The honoured request is consumed, so a later return is not stopped on arrival.
    expect(await fakes.deps.files.stopRequested(fakes.store.paths(ID))).toBe(false);
  });

  it("refuses a job that another live driver holds (locked)", async () => {
    const fakes = setup();
    queued(fakes);
    fakes.store.holdLock(ID, 4242);

    const result = await drive(fakes.deps, ID);

    expect(result).toEqual(err({ kind: "store", error: { kind: "locked", id: ID, holderPid: 4242 } }));
    expect(fakes.worker.specs).toEqual([]);
    expect(fakes.semaphore.acquired).toEqual([]);
  });

  it("releases the semaphore slot and the lock on every exit path, including errors", async () => {
    const fakes = setup();
    queued(fakes, GATED);
    fakes.gates.run = async () => {
      throw new Error("gate runner exploded");
    };

    await expect(drive(fakes.deps, ID)).rejects.toThrow("gate runner exploded");

    expect(fakes.semaphore.released).toEqual([ID]);
    expect(fakes.store.locks.size).toBe(0);
    const ok = setup();
    queued(ok);
    await drive(ok.deps, ID);
    expect(ok.semaphore.released).toEqual([ID]);
    expect(ok.store.locks.size).toBe(0);
  });

  it("a failing dispose is reported and still releases the lock; the run's result stands", async () => {
    const fakes = setup();
    queued(fakes, GATED);
    fakes.worker.dispose = async () => {
      throw new Error("pool drained mid-shutdown");
    };

    const result = await drive(fakes.deps, ID);

    expect(result).toEqual({ ok: true, value: stored(fakes) });
    expect(stored(fakes).state).toBe("awaiting_review");
    expect(fakes.store.locks.size).toBe(0);
    expect(fakes.out.errors).toEqual([
      `zai: job ${ID} finished, but its worker could not be disposed: pool drained mid-shutdown`,
    ]);
  });

  it("resolves brief env names from deps.env into passEnv for worker and gates; never writes values to the job", async () => {
    const fakes = setup(undefined, { NPM_TOKEN: "s3cret-token", OTHER: "unrelated" });
    const job = queued(fakes, { ...GATED, env: ["NPM_TOKEN"] });

    await drive(fakes.deps, ID);

    const passEnv = { NPM_TOKEN: "s3cret-token", ZAI_ARTIFACTS: job.workspace.artifactsDir };
    expect(fakes.worker.specs[0]?.passEnv).toEqual(passEnv);
    expect(fakes.gates.calls[0]?.passEnv).toEqual(passEnv);
    expect(JSON.stringify(fakes.store.writes)).not.toContain("s3cret-token");
  });

  it("a worker that cannot start (no key) lands the job in awaiting_review with worker_error, no retry", async () => {
    const fakes = setup([{ startError: { kind: "no_key", message: "no Z.ai key: export ZAI_API_KEY" } }]);
    queued(fakes);

    const result = await drive(fakes.deps, ID);

    expect(result).toEqual(
      err({ kind: "worker", error: { kind: "no_key", message: "no Z.ai key: export ZAI_API_KEY" } }),
    );
    expect(stored(fakes).state).toBe("awaiting_review");
    expect(stored(fakes).attempts).toHaveLength(1);
    expect(attempt(fakes, 1)).toMatchObject({
      outcome: {
        kind: "crashed",
        exitCode: null,
        signal: null,
        stderrTail: "no Z.ai key: export ZAI_API_KEY",
      },
      verdict: "worker_error",
    });
  });

  it("only a queued job can be driven", async () => {
    const fakes = setup();
    queued(fakes, {}, { state: "awaiting_review" });

    expect(await drive(fakes.deps, ID)).toEqual(
      err({ kind: "wrong_state", id: ID, state: "awaiting_review", allowed: ["queued"] }),
    );
    expect(await drive(fakes.deps, "261006-nope")).toEqual(
      err({ kind: "store", error: { kind: "not_found", id: "261006-nope" } }),
    );
  });

  it("persists a progress snapshot of the running attempt", async () => {
    const fakes = setup([
      { lines: [wire.tool("Bash", { command: "npm test" }), wire.result({ report: {} })] },
    ]);
    queued(fakes, { retries: { fix: 0, infra: 0 } });

    await drive(fakes.deps, ID);

    const snapshot = JSON.parse(readFileSync(`${fakes.store.paths(ID).dir}/progress.json`, "utf8"));
    expect(snapshot).toMatchObject({
      attempt: 1,
      progress: { phase: "done", lastTool: "Bash npm test", toolCalls: 1, turns: 2 },
    });
  });

  it("a version conflict re-applies the step while the job is still in the expected state, else stops", async () => {
    const fakes = setup();
    queued(fakes);
    let raced = false;
    fakes.store.beforeUpdate = (job) => {
      if (raced || job.state !== "running") return;
      raced = true;
      const current = fakes.store.jobs.get(ID);
      if (current !== undefined) fakes.store.jobs.set(ID, { ...current, version: current.version + 1 });
    };

    const result = await drive(fakes.deps, ID);

    expect(result.ok).toBe(true);
    expect(stored(fakes).state).toBe("awaiting_review");

    const moved = setup();
    queued(moved);
    moved.store.beforeUpdate = (job) => {
      const current = moved.store.jobs.get(ID);
      if (job.state === "verifying" && current?.state === "running") {
        moved.store.jobs.set(ID, { ...current, state: "discarded", version: current.version + 1 });
      }
    };

    const stopped = await drive(moved.deps, ID);

    expect(stopped).toEqual(err({ kind: "wrong_state", id: ID, state: "discarded", allowed: ["running"] }));
  });
});

function sweep(): Brief["report"] {
  return { kind: "builtin", name: "sweep" };
}
