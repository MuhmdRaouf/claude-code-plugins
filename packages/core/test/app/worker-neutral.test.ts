import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Deps } from "../../src/app/deps.ts";
import { drive } from "../../src/app/drive.ts";
import { jobRow } from "../../src/app/queries.ts";
import type { Brief } from "../../src/domain/brief.ts";
import type { Attempt, Job } from "../../src/domain/job.ts";
import { autoFixPrompt, DEFAULT_LIMITS, selfContainedPrompt } from "../../src/domain/prompt.ts";
import { ok } from "../../src/domain/result.ts";
import type { WorkerEvent } from "../../src/domain/worker-events.ts";
import type { Worker } from "../../src/ports/index.ts";
import { aBrief, aChangeSet, aJob, anAttempt } from "../support/builders.ts";
import {
  EVENT_FIXTURES,
  type Fakes,
  type FakeWorld,
  fakeDeps,
  VALID_CHANGE_REPORT,
  type WorkerDialect,
  type WorkerScript,
} from "../support/fakes.ts";
import { ACME_PROVIDER, ACME_WORKER } from "../support/provider.ts";

const ID = "261006-acme1";
const GATED: Partial<Brief> = { gates: [{ run: "npm test", timeoutMs: 60_000 }] };

// ── acmebot: a worker whose wire and terms share nothing with Claude Code ────────────────────────────────────────────

/** acmebot's wire: one `key=value` line per event, the value running to the end of the line. */
const kv = {
  init: (sessionKey: string, modelId: string): string => `session=${sessionKey} model=${modelId}`,
  text: (text: string): string => `text=${text}`,
  tool: (name: string, summary: string): string => `tool=${name} ${summary}`,
  result: (report: unknown): string => `result=${JSON.stringify(report)}`,
};

/** acmebot's result line carries the report; the rest of its run summary is fixed in this stand-in. */
function kvResult(report: unknown): WorkerEvent {
  return {
    type: "result",
    isError: false,
    text: "done",
    structuredOutput: report,
    turns: 2,
    durationMs: 1500,
    costUsd: 0.01,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
    apiErrorStatus: null,
  };
}

/** A line acmebot cannot read yields no events, the way a worker skips what it cannot parse. */
function parseKvLine(text: string): readonly WorkerEvent[] {
  const eq = text.indexOf("=");
  if (eq === -1) return [];
  const key = text.slice(0, eq);
  const value = text.slice(eq + 1);
  switch (key) {
    case "session": {
      const [sessionId = "", rest = ""] = value.split(" ");
      return [{ type: "init", sessionId, model: /model=(\S+)/.exec(rest)?.[1] ?? "" }];
    }
    case "engine-session":
      return [{ type: "session", sessionId: value }];
    case "text":
      return [{ type: "assistant_text", text: value }];
    case "tool": {
      const [name = "", ...summary] = value.split(" ");
      return [{ type: "tool_use", name, summary: summary.join(" ") }];
    }
    case "result":
      try {
        return [kvResult(JSON.parse(value))];
      } catch {
        return [];
      }
    default:
      return [];
  }
}

const ACMEBOT: WorkerDialect = {
  // acmebot stands in for an engine whose sessions the caller keys, like pi.
  caps: { name: "pi-rpc", sessionKey: "caller", nativeSchema: false, ...ACME_WORKER },
  parseLine: parseKvLine,
  init: kv.init,
  sessionMissing: () => false,
  fixtures: EVENT_FIXTURES,
};

/** The whole world in acme's names: no zai, claude or GLM string reaches the engine from anywhere. */
const ACME_WORLD: FakeWorld = { provider: ACME_PROVIDER, dialect: ACMEBOT };

/** A completed acmebot run with a valid change report. */
function acmeCompletes(): WorkerScript {
  return { lines: [kv.text("working"), kv.result(VALID_CHANGE_REPORT)] };
}

// ── session ownership: the same wire, three ways of keying a session ────────────────────────────────────────────────

/** The id an engine-keyed worker announces for the caller's `000…1` placeholder. */
const ENGINE_SESSION = "01a11109-0000-7000-8000-000000000001";

/** The same kv wire, keyed the way omp keys its sessions: the engine assigns the id and announces it. */
const OMPE: WorkerDialect = {
  caps: { name: "omp-rpc", sessionKey: "engine", nativeSchema: false, ...ACME_WORKER },
  parseLine: parseKvLine,
  init: kv.init,
  sessionMissing: () => false,
  fixtures: EVENT_FIXTURES,
};

/** A completed omp-style run: the engine announces its session id before it finishes with the report. */
function engineCompletes(): WorkerScript {
  return { lines: [`engine-session=${ENGINE_SESSION}`, kv.text("working"), kv.result(VALID_CHANGE_REPORT)] };
}

/** The same kv wire, keyed the way opencode does: no session of its own to resume. */
const SESSIONLESS: WorkerDialect = {
  caps: { name: "opencode", sessionKey: "none", nativeSchema: false, ...ACME_WORKER },
  parseLine: parseKvLine,
  init: kv.init,
  sessionMissing: () => false,
  fixtures: EVENT_FIXTURES,
};

// ── the usual drive-test helpers, over the acme world ───────────────────────────────────────────────────────────────

function setup(scripts: WorkerScript[] = [], world: FakeWorld = ACME_WORLD): Fakes {
  const fakes = fakeDeps(scripts, {}, world);
  fakes.git.changeSet = aChangeSet({ modified: ["src/a.ts"] });
  return fakes;
}

/** A queued edit job in the fake store, its workspace in the acme provider's names. */
function queued(fakes: Fakes, brief: Partial<Brief> = {}): Job {
  const paths = fakes.store.paths(ID);
  return fakes.store.put(
    aJob({
      id: ID,
      brief: aBrief(brief),
      workspace: {
        repoRoot: "/repo",
        baseSha: "b".repeat(40),
        worktree: paths.worktree,
        branch: `acme-jobs/${ID}`,
        artifactsDir: paths.artifacts,
      },
    }),
  );
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

describe("the engine drives a worker that is not claude", () => {
  it("re-runs a resume whose session the worker reports missing — empty stderr and all — in a fresh session", async () => {
    // The middle script exits sessionMissing with nothing on stderr: only the worker's own flag says so.
    const fakes = setup([
      acmeCompletes(),
      { bare: true, lines: [], exit: { code: 1, sessionMissing: true } },
      acmeCompletes(),
    ]);
    fakes.gates.failOnce("npm test");
    const job = queued(fakes, GATED);

    const result = await drive(fakes.deps, ID);

    expect(result).toEqual({ ok: true, value: stored(fakes) });
    expect(fakes.worker.specs).toHaveLength(3);
    const [initial, resume, fresh] = fakes.worker.specs;
    expect(initial?.session).toEqual({ kind: "new", key: "00000000-0000-4000-8000-000000000001" });
    expect(resume?.session).toEqual({ kind: "resume", key: initial?.session.key });
    // FakeIds burned one on the auto_fix attempt before the fresh session took the next.
    expect(fresh?.session).toEqual({ kind: "new", key: "00000000-0000-4000-8000-000000000003" });
    expect(fresh?.prompt).toBe(
      selfContainedPrompt(
        job.brief,
        [attempt(fakes, 1)],
        autoFixPrompt(job.brief, attempt(fakes, 1), DEFAULT_LIMITS),
        job.workspace.artifactsDir,
        ACME_PROVIDER,
      ),
    );
    expect(stored(fakes).attempts.map((a) => [a.kind, a.verdict])).toEqual([
      ["initial", "gate_fail"],
      ["auto_fix", "pass"],
    ]);
    expect(stored(fakes).state).toBe("awaiting_review");
  });

  it("the board folds a running attempt's log with the worker's own line reader", async () => {
    const fakes = setup();
    const paths = fakes.store.paths(ID);
    fakes.store.put(
      aJob({
        id: ID,
        brief: aBrief(),
        state: "running",
        workspace: {
          repoRoot: "/repo",
          baseSha: "b".repeat(40),
          worktree: paths.worktree,
          branch: `acme-jobs/${ID}`,
          artifactsDir: paths.artifacts,
        },
        attempts: [anAttempt({ sessionId: "acme-session-1" })],
      }),
    );
    // No driver snapshot for this attempt, so the fold of the raw log is the board's only source.
    writeFileSync(
      paths.attemptLog(1),
      [
        kv.init("acme-session-1", ACME_PROVIDER.catalog.main.id),
        kv.text("compiling the list"),
        kv.tool("Bash", "npm test"),
        kv.text("almost there"),
        "",
      ].join("\n"),
    );

    const row = await jobRow(fakes.deps, ID);

    expect(row.ok && row.value.progress).toEqual({
      sessionId: "acme-session-1",
      phase: "thinking",
      turns: 0,
      lastTool: "Bash npm test",
      lastText: "almost there",
      rateLimitRetries: 0,
      toolCalls: 1,
      toolErrors: 0,
    });
  });

  it("a stop asks the worker's run to interrupt itself; the engine never signals the process group", async () => {
    const fakes = setup([{ lines: [kv.text("working")], hang: true }]);
    const scripted = fakes.worker;
    const interrupts: string[] = [];
    // acmebot stops its own child when asked; it records the ask instead of anyone terminating the group.
    const worker: Worker = {
      caps: scripted.caps,
      preflight: () => scripted.preflight(),
      parseLine: (line) => scripted.parseLine(line),
      dispose: () => scripted.dispose(),
      start: async (spec) => {
        const started = await scripted.start(spec);
        if (!started.ok) return started;
        const run = started.value;
        return ok({
          ...run,
          interrupt: async (reason) => {
            interrupts.push(reason);
            fakes.process.onTerminate.get(run.pid)?.();
          },
        });
      },
    };
    const deps: Deps = { ...fakes.deps, worker };
    queued(fakes);
    const controller = new AbortController();

    const driving = drive(deps, ID, controller.signal);
    await expect.poll(() => scripted.specs.length).toBe(1);
    controller.abort();
    const result = await driving;

    expect(result.ok).toBe(true);
    expect(interrupts).toEqual(["stopped"]);
    expect(fakes.process.terminated).toEqual([]);
    expect(attempt(fakes, 1)).toMatchObject({ outcome: { kind: "stopped" }, verdict: "stopped" });
    expect(stored(fakes).state).toBe("awaiting_review");
  });
});

describe("the engine drives a worker whose sessions the engine keys", () => {
  it("stores the engine's session id and resumes the fix attempt under it, not the caller's placeholder", async () => {
    const fakes = setup([engineCompletes(), engineCompletes()], { provider: ACME_PROVIDER, dialect: OMPE });
    fakes.gates.failOnce("npm test");
    queued(fakes, GATED);

    const result = await drive(fakes.deps, ID);

    expect(result).toEqual({ ok: true, value: stored(fakes) });
    expect(fakes.worker.specs).toHaveLength(2);
    const [initial, resume] = fakes.worker.specs;
    expect(initial?.session).toEqual({ kind: "new", key: "00000000-0000-4000-8000-000000000001" });
    expect(resume?.session).toEqual({ kind: "resume", key: ENGINE_SESSION });
    // Both stored attempts carry the engine's id: the announced one, then the one the fix resumed.
    expect(stored(fakes).attempts.map((a) => a.sessionId)).toEqual([ENGINE_SESSION, ENGINE_SESSION]);
  });
});

describe("the engine drives a worker with no session to resume", () => {
  it("a fix attempt runs as a self-contained fresh session instead of a resume the worker must refuse", async () => {
    const fakes = setup([acmeCompletes(), acmeCompletes()], {
      provider: ACME_PROVIDER,
      dialect: SESSIONLESS,
    });
    fakes.gates.failOnce("npm test");
    const job = queued(fakes, GATED);

    const result = await drive(fakes.deps, ID);

    expect(result).toEqual({ ok: true, value: stored(fakes) });
    expect(fakes.worker.specs).toHaveLength(2);
    const [initial, fix] = fakes.worker.specs;
    expect(initial?.session).toEqual({ kind: "new", key: "00000000-0000-4000-8000-000000000001" });
    expect(fix?.session).toEqual({ kind: "new", key: "00000000-0000-4000-8000-000000000003" });
    expect(fix?.prompt).toBe(
      selfContainedPrompt(
        job.brief,
        [attempt(fakes, 1)],
        autoFixPrompt(job.brief, attempt(fakes, 1), DEFAULT_LIMITS),
        job.workspace.artifactsDir,
        ACME_PROVIDER,
      ),
    );
    expect(stored(fakes).attempts.map((a) => [a.kind, a.verdict])).toEqual([
      ["initial", "gate_fail"],
      ["auto_fix", "pass"],
    ]);
  });
});
