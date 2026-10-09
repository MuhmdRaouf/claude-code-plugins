import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { PiRpcWorker } from "../../../../src/adapters/engines/pi-rpc/worker.ts";
import { checkReport } from "../../../../src/domain/reports.ts";
import { ok } from "../../../../src/domain/result.ts";
import type { WorkerEvent } from "../../../../src/domain/worker-events.ts";
import type { WorkerRun, WorkerSpec } from "../../../../src/ports/worker.ts";
import { REFERENCE_PROVIDER } from "../../../support/provider.ts";
import { until } from "../../../support/wait.ts";
import { FAKE_PI, FIXTURES, isAlive, tempDir } from "./harness.ts";

/** The environment the orchestrator runs in: the user's own (HOME, a key of the user's own for pi's own provider) plus
 *  what the plugin and the Claude Code session added (the plugin's key and knobs, the router URL). */
const PARENT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  OPENROUTER_API_KEY: "users-own-key",
  ZAI_API_KEY: "plugin-provider-key",
  ZAI_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:18787",
  CLAUDE_CODE_ENTRYPOINT: "cli",
};
/** The plugin's provider variables, as engine-wire withholds them. */
const WITHHELD = (name: string): boolean => name === "ZAI_API_KEY" || name.startsWith("ZAI_");
/** The session key the caller assigns (pi owns nothing: --session-id creates it when missing). */
const NEW_SESSION = "00000000-0000-7000-8000-000000000001";
const RESUME_SESSION = "00000000-0000-7000-8000-0000000000a4";
/** A space-free report so the fake streams it as one text delta. */
const REPORT = { summary: "renamed-foo.ts-to-bar.ts", files: [], tests_added: [], open_items: [] };

function newWorker(overrides: { bin?: string; handshakeTimeoutMs?: number } = {}): PiRpcWorker {
  return new PiRpcWorker({
    bin: overrides.bin ?? FAKE_PI,
    parentEnv: PARENT_ENV,
    withheld: WITHHELD,
    stopGraceMs: 2_000,
    handshakeTimeoutMs: overrides.handshakeTimeoutMs ?? 30_000,
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

/** One full run with the argv/env recorders on; throws unless the fake exited 0. */
async function recordRun(passEnv: Record<string, string> = {}, overrides: SpecOverrides = {}) {
  const logs = tempDir();
  const { spec, dir } = jobSpec(
    {
      FAKE_PI_ARGV_LOG: join(logs, "argv.json"),
      FAKE_PI_ENV_LOG: join(logs, "env.json"),
      ...passEnv,
    },
    overrides,
  );
  const run = await startRun(spec);
  const { done } = collectEvents(run);
  const exit = await run.exit;
  await done;
  if (exit.code !== 0) throw new Error(`fake pi exited ${exit.code}: ${exit.stderrTail}`);
  return {
    argv: JSON.parse(readFileSync(join(logs, "argv.json"), "utf8")) as string[],
    env: JSON.parse(readFileSync(join(logs, "env.json"), "utf8")) as Record<string, string>,
    jobDir: dir,
    spec,
  };
}

/** The prompts the run sent, read back from the frames log (the commands log stores prompts as a $ref). */
function promptsSent(spec: WorkerSpec): string[] {
  return lines(spec.logPath)
    .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown[] } })
    .filter((frame) => frame.type === "message_end" && frame.message?.role === "user")
    .map((frame) =>
      (frame.message?.content ?? [])
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join(""),
    );
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

describe("PiRpcWorker", () => {
  it("readonly runs with narrowed tools; pi keeps its own model, setup and environment", async () => {
    const run = await recordRun(
      { ZAI_API_KEY: "brief-supplied", PI_CODING_AGENT_DIR: "/elsewhere", GREETING: "hi" },
      { access: "readonly" },
    );
    expect(run.argv).toEqual(["--mode", "rpc", "--tools", "read,grep,find,ls", "--session-id", NEW_SESSION]);
    expect(run.env).toMatchObject({
      HOME: process.env.HOME,
      OPENROUTER_API_KEY: "users-own-key",
      GREETING: "hi",
    });
    for (const name of [
      "ZAI_API_KEY",
      "ZAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_ENTRYPOINT",
      "PI_CODING_AGENT_DIR",
    ])
      expect(run.env).not.toHaveProperty(name);
    expect(JSON.stringify([run.argv, run.env])).not.toMatch(/plugin-provider-key|api\.z\.ai|18787/);
    expect(readdirSync(run.jobDir)).not.toContain("engine");
  });

  it.each(WRITING_ACCESSES)("%s runs with pi's own default toolset", async (access) => {
    const run = await recordRun({}, { access });
    expect(run.argv).toEqual(["--mode", "rpc", "--session-id", NEW_SESSION]);
  });

  it("passes effort and the caller's session key as their own flags, and drops addDirs", async () => {
    const run = await recordRun(
      {},
      {
        access: "readonly",
        effort: "low",
        addDirs: ["/refs/one", "/refs/two"],
        session: { kind: "resume", key: RESUME_SESSION },
      },
    );
    expect(run.argv).toEqual([
      "--mode",
      "rpc",
      "--thinking",
      "low",
      "--tools",
      "read,grep,find,ls",
      "--session-id",
      RESUME_SESSION,
    ]);
    expect(run.argv.join(" ")).not.toContain("/refs/");
  });

  it("a completed run yields session, text and a result with usage and report, logged as engine_result", async () => {
    const finalText = JSON.stringify(REPORT);
    const { spec } = jobSpec({ FAKE_PI_FINAL_TEXT: finalText });
    const { seen, exit } = await finishRun(spec);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
    // The fake streams "Working on it." as 3 deltas (it splits after each space) and the report as 1.
    expect(seen.map((event) => event.type)).toEqual([
      "session",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_delta",
      "assistant_text",
      "result",
    ]);
    expect(seen[0]).toEqual({ type: "session", sessionId: NEW_SESSION });
    expect(seen.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("")).toBe(
      `Working on it.${finalText}`,
    );
    const result = seen.at(-1);
    expect(result).toEqual({
      type: "result",
      isError: false,
      text: finalText,
      structuredOutput: REPORT,
      turns: 1,
      durationMs: expect.any(Number),
      costUsd: 0.0001,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 },
      apiErrorStatus: null,
      // The model pi's own setup ran on, as pi names it.
      model: "zai/glm-5.3",
    });
    const logged = lines(spec.logPath).at(-1) ?? "";
    expect(JSON.parse(logged).type).toBe("engine_result");
    expect(newWorker().parseLine(logged)).toEqual([result]);
    const commands = lines(spec.logPath.replace(/\.jsonl$/, ".rpc-in.jsonl")).map((line) => JSON.parse(line));
    expect(commands.filter((command) => command.type === "prompt")).toHaveLength(1);
  });

  it("an invalid report draws up to two correction prompts in the same session, and the result carries the problems", async () => {
    // The fake's default final text is "done": no JSON, so every turn's report is missing.
    const { spec } = jobSpec();
    const { seen, exit } = await finishRun(spec);
    expect(exit.code).toBe(0);
    const prompts = promptsSent(spec);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("## Final report");
    for (const correction of prompts.slice(1)) {
      expect(correction).toContain("Your report was invalid: no structured report");
      expect(correction).toContain("Reply with only the corrected JSON object.");
    }
    expect(seen.at(-1)).toMatchObject({
      type: "result",
      isError: false,
      text: "done",
      structuredOutput: null,
      turns: 3,
      usage: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 150, cacheWriteTokens: 0 },
    });
    expect((seen.at(-1) as { costUsd: number }).costUsd).toBeCloseTo(0.0003);
  });

  it("extracts the report from a ```json fence when the final text is not pure JSON", async () => {
    const { spec } = jobSpec({
      FAKE_PI_FINAL_TEXT: `Here you go:\n\`\`\`json\n${JSON.stringify(REPORT)}\n\`\`\``,
    });
    const { seen, exit } = await finishRun(spec);
    expect(exit.code).toBe(0);
    expect(seen.at(-1)).toMatchObject({ type: "result", isError: false, structuredOutput: REPORT, turns: 1 });
  });

  it("extracts the report from the outermost braces in prose", async () => {
    const { spec } = jobSpec({ FAKE_PI_FINAL_TEXT: `Sure! ${JSON.stringify(REPORT)} — done.` });
    const { seen, exit } = await finishRun(spec);
    expect(exit.code).toBe(0);
    expect(seen.at(-1)).toMatchObject({ type: "result", isError: false, structuredOutput: REPORT, turns: 1 });
  });

  it("recovers the report with get_last_assistant_text when the final message ends textless", async () => {
    const { spec } = jobSpec({ FAKE_PI_FINAL_TEXT: JSON.stringify(REPORT), FAKE_PI_TEXTLESS: "1" });
    const { seen, exit } = await finishRun(spec);
    expect(exit.code).toBe(0);
    expect(seen.map((event) => event.type)).not.toContain("assistant_text");
    expect(seen.at(-1)).toMatchObject({ type: "result", isError: false, structuredOutput: REPORT, turns: 1 });
    const commands = lines(spec.logPath.replace(/\.jsonl$/, ".rpc-in.jsonl")).map((line) => JSON.parse(line));
    expect(commands.filter((command) => command.type === "get_last_assistant_text")).toHaveLength(1);
  });

  it("a prompt that ran no agent ends without a final message, and the result says so", async () => {
    const { spec } = jobSpec({ FAKE_PI_NO_AGENT: "1" });
    const { seen, exit } = await finishRun(spec);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
    expect(seen.at(-1)).toMatchObject({
      type: "result",
      isError: true,
      text: "worker stopped without finishing (stopReason )",
      structuredOutput: null,
      turns: 0,
    });
  });

  it("a provider failure arrives on the message stream: an error event and a result with its status", async () => {
    const { spec } = jobSpec({ FAKE_PI_SCENARIO: "error" });
    const { seen, exit } = await finishRun(spec);
    expect(exit).toEqual({ code: 0, signal: null, stderrTail: "", forced: null, sessionMissing: false });
    expect(seen.map((event) => event.type)).toEqual(["session", "error", "result"]);
    expect(seen[1]).toEqual({
      type: "error",
      message: '401 {"error":{"message":"token expired or incorrect"}}',
      status: null,
    });
    expect(seen.at(-1)).toMatchObject({
      type: "result",
      isError: true,
      text: '401 {"error":{"message":"token expired or incorrect"}}',
      turns: 1,
      apiErrorStatus: 401,
    });
    const commands = lines(spec.logPath.replace(/\.jsonl$/, ".rpc-in.jsonl")).map((line) => JSON.parse(line));
    // The failure is not correctable: no second prompt is sent.
    expect(commands.filter((command) => command.type === "prompt")).toHaveLength(1);
  });

  it("interrupt mid-tool stops the run and leaves no process behind", async () => {
    const { spec } = jobSpec({ FAKE_PI_SCENARIO: "sleep" });
    const run = await startRun(spec);
    const { seen, done } = collectEvents(run);
    // The exit is racy by design (the soft abort races the group kill), so only the forced reason is asserted.
    await until(() => seen.some((event) => event.type === "tool_use" && event.name === "bash"));
    await run.interrupt("stopped");
    const exit = await run.exit;
    await done;
    expect(exit.forced).toBe("stopped");
    expect(isAlive(run.pid)).toBe(false);
  });

  it("the wall clock times the run out and the group dies", async () => {
    // The wall clock starts at spawn, before the fake has even booted: 2 s leaves a loaded box room to boot and
    // handshake, and the sleep scenario still runs far longer than that.
    const { spec } = jobSpec({ FAKE_PI_SCENARIO: "sleep" }, { timeoutMs: 2_000 });
    const run = await startRun(spec);
    const { done } = collectEvents(run);
    const exit = await run.exit;
    await done;
    expect(exit.forced).toBe("timeout");
    expect(isAlive(run.pid)).toBe(false);
  });

  it("a crashed run emits no result", async () => {
    const { spec } = jobSpec({ FAKE_PI_SCENARIO: "crash" });
    const { seen, exit } = await finishRun(spec);
    expect(seen.map((event) => event.type)).toEqual(["session"]);
    expect(exit).toEqual({
      code: 1,
      signal: null,
      stderrTail: "fake pi: simulated crash\n",
      forced: null,
      sessionMissing: false,
    });
  });

  it("parseLine folds a recorded transcript into the expected event kinds", () => {
    const events = (name: string): WorkerEvent[] => {
      const worker = newWorker();
      return readFileSync(join(FIXTURES, name, "stdout.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .flatMap((line) => [...worker.parseLine(line)]);
    };
    expect(events("success-readonly").map((event) => event.type)).toEqual([
      "session",
      "tool_use",
      "tool_result",
      "text_delta",
      "text_delta",
      "text_delta",
      "assistant_text",
    ]);
    expect(events("error-after-success").map((event) => event.type)).toEqual(["session", "error"]);
    expect(events("abort-mid-run").map((event) => event.type)).toEqual([
      "session",
      "tool_use",
      "tool_result",
      "error",
    ]);
  });

  it("preflight needs nothing of the plugin's: pi brings its own login", async () => {
    expect(await newWorker().preflight()).toEqual(ok(undefined));
  });

  it("reports a missing binary as spawn_failed", async () => {
    const { spec } = jobSpec();
    const started = await newWorker({ bin: "/nonexistent/pi" }).start(spec);
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "spawn_failed", message: expect.stringContaining("ENOENT") },
    });
  });

  it("reports a get_state answer without a sessionId as protocol", async () => {
    const { spec } = jobSpec({ FAKE_PI_NO_SESSION_ID: "1" });
    const started = await newWorker().start(spec);
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "protocol", message: expect.stringContaining("sessionId") },
    });
  });

  it("reports a handshake that never answers as protocol", async () => {
    const { spec } = jobSpec({ FAKE_PI_SLOW_STATE_MS: "5000" });
    const started = await newWorker({ handshakeTimeoutMs: 300 }).start(spec);
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "protocol", message: expect.stringContaining("handshake") },
    });
  });
});

describe("parseLine over crafted frames", () => {
  /** One frame through the fold, as parseLine would read it from a log. */
  function fold(frame: unknown): readonly WorkerEvent[] {
    return newWorker().parseLine(JSON.stringify(frame));
  }

  it("returns nothing for a line that is not JSON or a frame the fold does not know", () => {
    expect(newWorker().parseLine("this is not json")).toEqual([]);
    expect(fold({ type: "notice" })).toEqual([]);
    expect(fold({ type: "agent_settled" })).toEqual([]);
  });

  it("folds responses: the get_state session, refusals, and quiet successes", () => {
    expect(fold({ type: "response" })).toEqual([]);
    expect(fold({ type: "response", command: "get_state", success: true, data: {} })).toEqual([]);
    expect(
      fold({ type: "response", command: "get_state", success: true, data: { sessionId: "s1" } }),
    ).toEqual([{ type: "session", sessionId: "s1" }]);
    expect(
      fold({
        type: "response",
        command: "get_last_assistant_text",
        success: true,
        data: { sessionId: "s1" },
      }),
    ).toEqual([]);
    expect(
      fold({ type: "response", command: "frobnicate", success: false, error: "no such command" }),
    ).toEqual([{ type: "error", message: "no such command", status: null }]);
    expect(fold({ type: "response", command: "frobnicate", success: false })).toEqual([
      { type: "error", message: "pi refused frobnicate", status: null },
    ]);
  });

  it("folds message updates: only string text deltas", () => {
    expect(
      fold({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }),
    ).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(fold({ type: "message_update", assistantMessageEvent: { type: "tool_call" } })).toEqual([]);
    expect(fold({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 3 } })).toEqual(
      [],
    );
    expect(fold({ type: "message_update" })).toEqual([]);
  });

  it("folds assistant message ends, including their error stops", () => {
    expect(
      fold({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
          stopReason: "stop",
        },
      }),
    ).toEqual([{ type: "assistant_text", text: "ab" }]);
    expect(
      fold({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "u" }] } }),
    ).toEqual([]);
    expect(
      fold({ type: "message_end", message: { role: "assistant", content: "not parts", stopReason: "stop" } }),
    ).toEqual([]);
    expect(
      fold({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "boom" },
      }),
    ).toEqual([{ type: "error", message: "boom", status: null }]);
    expect(fold({ type: "message_end", message: { role: "assistant", stopReason: "error" } })).toEqual([
      { type: "error", message: "pi ended an assistant message in error", status: null },
    ]);
    expect(
      fold({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          stopReason: "error",
          errorMessage: "boom",
        },
      }),
    ).toEqual([
      { type: "assistant_text", text: "partial" },
      { type: "error", message: "boom", status: null },
    ]);
  });

  it("folds tool starts and results: a name, then a summary from the first string argument or nothing", () => {
    expect(fold({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep 600" } })).toEqual([
      { type: "tool_use", name: "bash", summary: "sleep 600" },
    ]);
    expect(fold({ type: "tool_execution_start", toolName: "grep", args: { pattern: 3 } })).toEqual([
      { type: "tool_use", name: "grep", summary: "" },
    ]);
    expect(fold({ type: "tool_execution_start", toolName: "grep" })).toEqual([
      { type: "tool_use", name: "grep", summary: "" },
    ]);
    expect(fold({ type: "tool_execution_start" })).toEqual([]);
    expect(fold({ type: "tool_execution_end", isError: true })).toEqual([
      { type: "tool_result", isError: true },
    ]);
    expect(fold({ type: "tool_execution_end" })).toEqual([{ type: "tool_result", isError: false }]);
  });

  it("folds retries: a leading 3-digit status, and counts that may be missing", () => {
    expect(
      fold({ type: "auto_retry_start", errorMessage: "429 High concurrency", attempt: 2, maxAttempts: 5 }),
    ).toEqual([{ type: "api_retry", attempt: 2, maxRetries: 5, status: 429 }]);
    expect(
      fold({ type: "auto_retry_start", errorMessage: "provider hiccup", attempt: "soon", maxAttempts: "5" }),
    ).toEqual([{ type: "api_retry", attempt: 0, maxRetries: 0, status: null }]);
    expect(fold({ type: "auto_retry_start" })).toEqual([
      { type: "api_retry", attempt: 0, maxRetries: 0, status: null },
    ]);
  });

  it("rebuilds a logged engine_result, defaulting every missing field", () => {
    expect(fold({ type: "engine_result", apiErrorStatus: 503 })).toEqual([
      {
        type: "result",
        isError: false,
        text: "",
        structuredOutput: null,
        turns: 0,
        durationMs: 0,
        costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        apiErrorStatus: 503,
      },
    ]);
    expect(
      fold({ type: "engine_result", isError: true, structuredOutput: { a: 1 }, turns: "3" }),
    ).toMatchObject([{ isError: true, structuredOutput: { a: 1 }, turns: 0, apiErrorStatus: null }]);
    expect(fold({ type: "engine_result", usage: { writeTokens: 7 } })).toMatchObject([
      { usage: { cacheWriteTokens: 7 } },
    ]);
    expect(fold({ type: "engine_result", usage: { cacheWriteTokens: 9 } })).toMatchObject([
      { usage: { cacheWriteTokens: 9 } },
    ]);
  });
});
