import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { OpenCodeWorker } from "../../../../src/adapters/engines/opencode/worker.ts";
import { checkReport } from "../../../../src/domain/reports.ts";
import { ok } from "../../../../src/domain/result.ts";
import type { WorkerEvent } from "../../../../src/domain/worker-events.ts";
import type { WorkerRun, WorkerSpec } from "../../../../src/ports/worker.ts";
import { REFERENCE_PROVIDER } from "../../../support/provider.ts";
import { isPidAlive as isAlive, until, untilGone } from "../../../support/wait.ts";

const FAKE_OPENCODE = join(import.meta.dirname, "../../../fixtures/engines/fake-opencode.ts");
const FIXTURES = join(import.meta.dirname, "../../../fixtures/engines/opencode");
/** The environment the orchestrator runs in: the user's own (HOME, the user's own XDG dirs and a key for opencode's
 *  own provider) plus what the plugin and the Claude Code session added (the plugin's key and knobs, the router URL). */
const PARENT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: "/home/user/.config",
  OPENROUTER_API_KEY: "users-own-key",
  ZAI_API_KEY: "plugin-provider-key",
  ZAI_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:18787",
  ANTHROPIC_AUTH_TOKEN: "router-token",
};
/** The plugin's provider variables, as engine-wire withholds them. */
const WITHHELD = (name: string): boolean => name === "ZAI_API_KEY" || name.startsWith("ZAI_");
/** The orchestrator's session key; the engine's own id only ever appears in events. */
const NEW_SESSION = "00000000-0000-7000-8000-000000000001";
/** The report prompt the adapter builds for `jobSpec` (its schema is `{type: "object"}`). */
const REPORT_PROMPT = [
  "Rename foo.ts to bar.ts.",
  "",
  "## Final report",
  "",
  "Your final message must contain only the report as one JSON object, and nothing else.",
  "The report must satisfy this JSON schema:",
  "",
  "```json",
  JSON.stringify({ type: "object" }, null, 2),
  "```",
].join("\n");
/** The result a happy single-step run synthesizes (fixture timestamps, so the numbers are exact). */
const HAPPY_RESULT = {
  type: "result",
  isError: false,
  text: '{"kind":"file"}',
  structuredOutput: { kind: "file" },
  turns: 1,
  durationMs: 581,
  costUsd: 0.0002,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
  apiErrorStatus: null,
};
const FENCED_TEXT = 'Here is the rename report:\n```json\n{"kind":"file"}\n```';
const PROSE_TEXT = 'Done! {"kind":"file"} — everything moved.';
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The fake's one fixed knob: the fixture it replays. */
function fixture(name: string): Record<string, string> {
  return { FAKE_OPENCODE_FIXTURE: join(FIXTURES, name) };
}

/** A fresh directory removed after the current test. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-test-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newWorker(overrides: { bin?: string } = {}): OpenCodeWorker {
  return new OpenCodeWorker({
    bin: overrides.bin ?? FAKE_OPENCODE,
    parentEnv: PARENT_ENV,
    withheld: WITHHELD,
    stopGraceMs: 2_000,
  });
}

/** The knobs the adapter tests turn; absent optionals stay absent (exactOptionalPropertyTypes). */
interface SpecOverrides {
  readonly access?: WorkerSpec["access"];
  readonly effort?: string;
  readonly addDirs?: readonly string[];
  readonly session?: WorkerSpec["session"];
  readonly timeoutMs?: number;
}

function jobSpec(
  passEnv: Record<string, string> = {},
  overrides: SpecOverrides = {},
): { spec: WorkerSpec; dir: string } {
  const dir = tempDir();
  const spec: WorkerSpec = {
    cwd: dir,
    model: REFERENCE_PROVIDER.catalog.main,
    access: overrides.access ?? "write",
    ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
    prompt: "Rename foo.ts to bar.ts.",
    session: overrides.session ?? { kind: "new", key: NEW_SESSION },
    report: {
      name: "change.json",
      jsonSchema: { type: "object" },
      validate: (value) => checkReport(value, { kind: "file" }),
    },
    addDirs: overrides.addDirs ?? [],
    passEnv,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    logPath: join(dir, "attempt-0001.jsonl"),
  };
  return { spec, dir };
}

async function startRun(spec: WorkerSpec): Promise<WorkerRun> {
  const started = await newWorker().start(spec);
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const run = started.value;
  onTestFinished(async () => {
    if (isAlive(run.pid)) await run.interrupt("stopped");
  });
  return run;
}

/** Pumps events eagerly; `done` resolves only once the queue closes (after the engine_result line is appended). */
function collectEvents(run: WorkerRun): { seen: WorkerEvent[]; done: Promise<void> } {
  const seen: WorkerEvent[] = [];
  const done = (async () => {
    for await (const event of run.events) seen.push(event);
  })();
  return { seen, done };
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** Resolves with the first event matching `predicate`, failing the test after 10 s. */
function waitForEvent(seen: WorkerEvent[], predicate: (event: WorkerEvent) => boolean): Promise<WorkerEvent> {
  return until(() => seen.find(predicate), { message: "event did not arrive" });
}

/** One full run with the argv/env recorders on; throws unless the fake exited 0. */
async function recordRun(passEnv: Record<string, string> = {}, overrides: SpecOverrides = {}) {
  const logs = tempDir();
  const { spec, dir } = jobSpec(
    {
      ...fixture("happy.jsonl"),
      FAKE_OPENCODE_ARGV_LOG: join(logs, "argv.json"),
      FAKE_OPENCODE_ENV_LOG: join(logs, "env.json"),
      ...passEnv,
    },
    overrides,
  );
  const run = await startRun(spec);
  const { done } = collectEvents(run);
  const exit = await run.exit;
  await done;
  if (exit.code !== 0) throw new Error(`fake opencode exited ${exit.code}: ${exit.stderrTail}`);
  const env = JSON.parse(readFileSync(join(logs, "env.json"), "utf8")) as Record<string, string>;
  return {
    argv: JSON.parse(readFileSync(join(logs, "argv.json"), "utf8")) as string[],
    env,
    config: JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "") as Record<string, unknown>,
    jobDir: dir,
  };
}

/** A run driven to its end (exit seen, events queue drained), for the tests that do not record argv. */
async function finishRun(
  spec: WorkerSpec,
): Promise<{ seen: WorkerEvent[]; exit: Awaited<WorkerRun["exit"]> }> {
  const run = await startRun(spec);
  const { seen, done } = collectEvents(run);
  const exit = await run.exit;
  await done;
  return { seen, exit };
}

const WRITING_ACCESSES: readonly WorkerSpec["access"][] = ["write", "exec"];

describe("OpenCodeWorker", () => {
  it("starts a readonly run on opencode's own setup: no model in argv, only the job's permissions added", async () => {
    const run = await recordRun(
      {
        // The brief's env cannot re-route opencode or smuggle a key in: reserved names are dropped.
        ZAI_API_KEY: "brief-supplied",
        OTHER_API_KEY: "other",
        OPENCODE_LOG_LEVEL: "debug",
        XDG_DATA_HOME: "/elsewhere",
        GREETING: "hi",
      },
      { access: "readonly" },
    );
    expect(run.argv).toEqual(["run", "--format", "json", REPORT_PROMPT]);
    // The user's own environment, their own config dirs included, reaches opencode.
    expect(run.env).toMatchObject({
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: "/home/user/.config",
      OPENROUTER_API_KEY: "users-own-key",
      GREETING: "hi",
    });
    for (const name of [
      "ZAI_API_KEY",
      "ZAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "OTHER_API_KEY",
      "OPENCODE_LOG_LEVEL",
      "XDG_DATA_HOME",
      "OPENCODE_DISABLE_AUTOUPDATE",
    ])
      expect(run.env).not.toHaveProperty(name);
    // The one thing the plugin adds is the job's access; no provider, model, endpoint or key.
    expect(run.config).toEqual({ permission: { edit: "deny", bash: "deny" } });
    expect(JSON.stringify([run.argv, run.env])).not.toMatch(
      /plugin-provider-key|brief-supplied|api\.z\.ai|18787/,
    );
    expect(existsSync(join(run.jobDir, "engine"))).toBe(false);
  });

  it.each(WRITING_ACCESSES)("opens %s: --auto approves what the config leaves", async (access) => {
    const run = await recordRun({}, { access });
    expect(run.argv).toContain("--auto");
    expect(run.config.permission).toEqual(
      access === "exec" ? { edit: "deny", bash: "allow" } : { edit: "allow", bash: "allow" },
    );
  });

  it("takes effort and a resume, and has nothing to do with addDirs", async () => {
    const run = await recordRun(
      {},
      {
        access: "readonly",
        effort: "high",
        addDirs: ["/refs/one", "/refs/two"],
        session: { kind: "resume", key: "ses_00000001" },
      },
    );
    expect(run.argv).toEqual([
      "run",
      "--format",
      "json",
      "--variant",
      "high",
      "--session",
      "ses_00000001",
      REPORT_PROMPT,
    ]);
  });

  it("folds a happy run: the session, the final text as the report, then the result", async () => {
    const worker = newWorker();
    const { spec } = jobSpec(fixture("happy.jsonl"));
    const { seen, exit } = await finishRun(spec);
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000001" },
      { type: "assistant_text", text: '{"kind":"file"}' },
      HAPPY_RESULT,
    ]);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
    // The synthetic engine_result line folds back into the same result event.
    const logged = lines(spec.logPath);
    expect(logged).toHaveLength(4);
    expect(worker.parseLine(logged[3] ?? "")).toEqual([HAPPY_RESULT]);
    await worker.dispose();
  });

  it("folds a tool run: the call and its outcome, a second step, usage summed over both", async () => {
    const { seen, exit } = await finishRun(jobSpec(fixture("tool-run.jsonl")).spec);
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000002" },
      { type: "tool_use", name: "bash", summary: "echo hi" },
      { type: "tool_result", isError: false },
      { type: "session", sessionId: "ses_00000002" },
      { type: "assistant_text", text: '{"kind":"file"}' },
      {
        type: "result",
        isError: false,
        text: '{"kind":"file"}',
        structuredOutput: { kind: "file" },
        turns: 2,
        durationMs: 950,
        costUsd: expect.closeTo(0.003),
        usage: { inputTokens: 140, outputTokens: 24, cacheReadTokens: 500, cacheWriteTokens: 4 },
        apiErrorStatus: null,
      },
    ]);
    expect(exit.code).toBe(0);
  });

  it("reports the stream's own error event and fails the run with its message", async () => {
    const failure = "Unexpected server error. Check server logs for details.";
    const { seen, exit } = await finishRun(
      jobSpec({ ...fixture("error-event.jsonl"), FAKE_OPENCODE_EXIT: "1" }).spec,
    );
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000003" },
      { type: "assistant_text", text: "I will check the directory first." },
      { type: "error", message: failure, status: null },
      {
        type: "result",
        isError: true,
        text: failure,
        structuredOutput: null,
        turns: 0,
        durationMs: 300,
        costUsd: 0,
        usage: ZERO_USAGE,
        apiErrorStatus: null,
      },
    ]);
    expect(exit).toEqual({ code: 1, signal: null, stderrTail: "", forced: null, sessionMissing: false });
  });

  it("fails a run that exits without a finished step, even on exit 0", async () => {
    const failure = "opencode exited without a finished step (exit 0)";
    const { seen, exit } = await finishRun(jobSpec(fixture("no-step-finish.jsonl")).spec);
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000004" },
      { type: "assistant_text", text: '{"kind":"file"}' },
      { type: "error", message: failure, status: null },
      {
        type: "result",
        isError: true,
        text: failure,
        structuredOutput: null,
        turns: 0,
        durationMs: 200,
        costUsd: 0,
        usage: ZERO_USAGE,
        apiErrorStatus: null,
      },
    ]);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
  });

  it("skips lines that are not events and keeps them in the raw log", async () => {
    const { spec } = jobSpec(fixture("malformed.jsonl"));
    const { seen, exit } = await finishRun(spec);
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000001" },
      { type: "assistant_text", text: '{"kind":"file"}' },
      HAPPY_RESULT,
    ]);
    expect(exit.code).toBe(0);
    // Six fixture lines and the engine_result line; the junk survives verbatim.
    expect(lines(spec.logPath)).toHaveLength(7);
    expect(lines(spec.logPath)).toContain("this line is not json");
  });

  it("reads the report out of a ```json fence", async () => {
    const { seen } = await finishRun(jobSpec(fixture("fenced-report.jsonl")).spec);
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000005" },
      { type: "assistant_text", text: FENCED_TEXT },
      {
        type: "result",
        isError: false,
        text: FENCED_TEXT,
        structuredOutput: { kind: "file" },
        turns: 1,
        durationMs: 450,
        costUsd: 0.0001,
        usage: { inputTokens: 90, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 0 },
        apiErrorStatus: null,
      },
    ]);
  });

  it("salvages the report out of prose around it", async () => {
    const { seen } = await finishRun(jobSpec(fixture("prose-report.jsonl")).spec);
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000006" },
      { type: "assistant_text", text: PROSE_TEXT },
      {
        type: "result",
        isError: false,
        text: PROSE_TEXT,
        structuredOutput: { kind: "file" },
        turns: 1,
        durationMs: 450,
        costUsd: 0.0001,
        usage: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 0 },
        apiErrorStatus: null,
      },
    ]);
  });

  it("has no structured output to salvage when the final text is plain prose", async () => {
    const { seen } = await finishRun(jobSpec(fixture("plain-text.jsonl")).spec);
    expect(seen).toEqual([
      { type: "session", sessionId: "ses_00000007" },
      { type: "assistant_text", text: "The rename is complete." },
      {
        type: "result",
        isError: false,
        text: "The rename is complete.",
        structuredOutput: null,
        turns: 1,
        durationMs: 300,
        costUsd: 0.00005,
        usage: { inputTokens: 60, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 },
        apiErrorStatus: null,
      },
    ]);
  });

  it('times a hanging run out: the exit is forced "timeout" and no result is invented', async () => {
    // The wall clock starts at spawn, so it must outlast the fake's boot: the two events the fixture prints before it
    // hangs have to be out before the timeout, or the event list would be shorter on a loaded box.
    const { spec } = jobSpec(
      { ...fixture("no-step-finish.jsonl"), FAKE_OPENCODE_HANG: "1" },
      { timeoutMs: 2_000 },
    );
    const run = await startRun(spec);
    const { seen, done } = collectEvents(run);
    const exit = await run.exit;
    await done;
    expect(exit.forced).toBe("timeout");
    expect(exit.code).toBe(null);
    expect(seen.map((event) => event.type)).toEqual(["session", "assistant_text"]);
    expect(isAlive(run.pid)).toBe(false);
  });

  it('stops on request: the exit is forced "stopped" and the group dies', async () => {
    const { spec } = jobSpec({ ...fixture("no-step-finish.jsonl"), FAKE_OPENCODE_HANG: "1" });
    const run = await startRun(spec);
    const { seen, done } = collectEvents(run);
    await waitForEvent(seen, (event) => event.type === "assistant_text");
    await run.interrupt("stopped");
    const exit = await run.exit;
    await done;
    expect(exit.forced).toBe("stopped");
    expect(exit.signal).toBe("SIGTERM");
    expect(seen.map((event) => event.type)).toEqual(["session", "assistant_text"]);
    expect(isAlive(run.pid)).toBe(false);
  });

  it("reaps the server child the run leaves behind", async () => {
    const logs = tempDir();
    const { spec } = jobSpec({
      ...fixture("happy.jsonl"),
      FAKE_OPENCODE_CHILD_PIDFILE: join(logs, "child.pid"),
    });
    const { exit } = await finishRun(spec);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
    const child = Number(readFileSync(join(logs, "child.pid"), "utf8"));
    expect(child).toSatisfy((pid: number) => Number.isInteger(pid) && pid > 1);
    await untilGone(child);
  });

  it("flags a resume the engine does not know as sessionMissing", async () => {
    const failure = "opencode exited without a finished step (exit 1)";
    const { seen, exit } = await finishRun(
      jobSpec(
        { ...fixture("happy.jsonl"), FAKE_OPENCODE_RESUME_MISSING: "1" },
        { session: { kind: "resume", key: "ses_99999999" } },
      ).spec,
    );
    expect(seen).toEqual([
      { type: "error", message: failure, status: null },
      {
        type: "result",
        isError: true,
        text: failure,
        structuredOutput: null,
        turns: 0,
        durationMs: 0,
        costUsd: 0,
        usage: ZERO_USAGE,
        apiErrorStatus: null,
      },
    ]);
    expect(exit.code).toBe(1);
    expect(exit.sessionMissing).toBe(true);
    expect(exit.stderrTail).toContain("Session not found");
  });

  it("preflight needs nothing of the plugin's: opencode brings its own login", async () => {
    expect(await newWorker().preflight()).toEqual(ok(undefined));
  });

  it("reports a missing binary as spawn_failed", async () => {
    const { spec } = jobSpec(fixture("happy.jsonl"));
    const started = await newWorker({ bin: "/no/such/opencode" }).start(spec);
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "spawn_failed", message: expect.stringContaining("ENOENT") },
    });
  });
});

describe("OpenCodeWorker.parseLine", () => {
  const worker = newWorker();

  it("folds only what it knows", () => {
    expect(worker.parseLine("this line is not json")).toEqual([]);
    expect(worker.parseLine(JSON.stringify({ type: "step_finish", part: {} }))).toEqual([]);
    expect(worker.parseLine(JSON.stringify({ type: "reasoning", part: {} }))).toEqual([]);
    expect(worker.parseLine(JSON.stringify({ type: "text", part: { type: "text", text: 42 } }))).toEqual([]);
    expect(worker.parseLine(JSON.stringify({ type: "text", part: { type: "text", text: "" } }))).toEqual([]);
  });

  it("folds the session id off step_start only", () => {
    expect(
      worker.parseLine(
        JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
      ),
    ).toEqual([{ type: "session", sessionId: "ses_1" }]);
    expect(worker.parseLine(JSON.stringify({ type: "step_start", part: { type: "step-start" } }))).toEqual(
      [],
    );
  });

  it("folds a tool call once it can say what it is about, and its outcome when it has one", () => {
    const tool = (state: Record<string, unknown>, toolName?: string) =>
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", ...(toolName === undefined ? {} : { tool: toolName }), state },
      });
    expect(worker.parseLine(tool({ status: "pending", input: { command: "ls -la" } }, "bash"))).toEqual([
      { type: "tool_use", name: "bash", summary: "ls -la" },
    ]);
    expect(worker.parseLine(tool({ status: "running" }, "edit"))).toEqual([
      { type: "tool_use", name: "edit", summary: "" },
    ]);
    expect(worker.parseLine(tool({ status: "completed", title: "read package.json" }, "read"))).toEqual([
      { type: "tool_use", name: "read", summary: "read package.json" },
      { type: "tool_result", isError: false },
    ]);
    expect(worker.parseLine(tool({ status: "error", title: "grep main" }, "grep"))).toEqual([
      { type: "tool_use", name: "grep", summary: "grep main" },
      { type: "tool_result", isError: true },
    ]);
    // Without a tool name there is nothing to report, whatever the state says.
    expect(worker.parseLine(tool({ status: "completed", title: "orphan" }))).toEqual([]);
  });

  it("unwraps the error's message, then its name, then gives up", () => {
    const error = (payload: Record<string, unknown>) => JSON.stringify({ type: "error", error: payload });
    expect(worker.parseLine(error({ data: { message: "boom" } }))).toEqual([
      { type: "error", message: "boom", status: null },
    ]);
    expect(worker.parseLine(error({ name: "ProviderError" }))).toEqual([
      { type: "error", message: "ProviderError", status: null },
    ]);
    expect(worker.parseLine(error({}))).toEqual([
      { type: "error", message: "opencode reported an error", status: null },
    ]);
  });

  it("folds the appended engine_result line back into the result event", () => {
    expect(worker.parseLine(JSON.stringify({ type: "engine_result" }))).toEqual([
      {
        type: "result",
        isError: false,
        text: "",
        structuredOutput: null,
        turns: 0,
        durationMs: 0,
        costUsd: 0,
        usage: ZERO_USAGE,
        apiErrorStatus: null,
      },
    ]);
  });
});
