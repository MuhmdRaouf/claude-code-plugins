import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  finalizeWorker,
  INITIAL_PROGRESS,
  type Progress,
  reduceProgress,
  type WorkerEvent,
} from "../../src/domain/worker-events.ts";
import { EVENT_FIXTURES } from "../support/fakes.ts";

/** A recorded run's events (test/fixtures/events/: what the claude worker read from its stream-json fixtures). */
function fixtureEvents(name: string): WorkerEvent[] {
  return readFileSync(new URL(name, EVENT_FIXTURES), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as WorkerEvent);
}

function resultEvent(overrides: Partial<Extract<WorkerEvent, { type: "result" }>> = {}): WorkerEvent {
  return {
    type: "result",
    isError: false,
    text: "",
    structuredOutput: null,
    turns: 1,
    durationMs: 10,
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    apiErrorStatus: null,
    ...overrides,
  };
}

const CLEAN_EXIT: Parameters<typeof finalizeWorker>[1] = { code: 0, signal: null, stderrTail: "" };

describe("reduceProgress", () => {
  it("INITIAL_PROGRESS is starting, with no text, no session and zero counters", () => {
    expect(INITIAL_PROGRESS).toEqual({
      phase: "starting",
      turns: 0,
      lastText: "",
      rateLimitRetries: 0,
      toolCalls: 0,
      toolErrors: 0,
    });
  });

  it("init sets sessionId and phase thinking", () => {
    const progress = reduceProgress(INITIAL_PROGRESS, { type: "init", sessionId: "s-1", model: "glm-5.3" });

    expect(progress).toEqual({ ...INITIAL_PROGRESS, sessionId: "s-1", phase: "thinking" });
  });

  it("session sets sessionId and nothing else — an engine-keyed id replacing the caller's placeholder", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, sessionId: "caller-key", phase: "thinking", turns: 3 };

    const progress = reduceProgress(thinking, { type: "session", sessionId: "engine-id-1" });

    expect(progress).toEqual({ ...thinking, sessionId: "engine-id-1" });
  });

  it("error leaves progress unchanged (same object): the worker's own report of a failed call", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking", lastText: "x" };

    expect(reduceProgress(thinking, { type: "error", message: "provider 529", status: 529 })).toBe(thinking);
  });
  it("api_retry with status 429 sets phase rate_limited and increments rateLimitRetries", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking", rateLimitRetries: 2 };

    const progress = reduceProgress(thinking, { type: "api_retry", attempt: 3, maxRetries: 10, status: 429 });

    expect(progress).toEqual({ ...thinking, phase: "rate_limited", rateLimitRetries: 3 });
  });

  it("api_retry for anything but 429 (overload, network) is not rate-limit pressure: progress unchanged", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking" };

    expect(reduceProgress(thinking, { type: "api_retry", attempt: 1, maxRetries: 10, status: 529 })).toBe(
      thinking,
    );
    expect(reduceProgress(thinking, { type: "api_retry", attempt: 1, maxRetries: 10, status: null })).toBe(
      thinking,
    );
  });
  it("text_delta accumulates lastText, capped to the last 500 chars; assistant_text replaces it", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking" };
    const delta = (text: string): WorkerEvent => ({ type: "text_delta", text });

    const started = reduceProgress(thinking, delta("Hello, "));
    const continued = reduceProgress(started, delta("world"));
    const long = reduceProgress(continued, delta("y".repeat(600)));
    const completed = reduceProgress(long, { type: "assistant_text", text: "Hello, world" });

    expect(started).toEqual({ ...thinking, phase: "writing", lastText: "Hello, " });
    expect(continued.lastText).toBe("Hello, world");
    expect(long.lastText).toBe("y".repeat(500));
    expect(completed).toEqual({ ...long, phase: "thinking", lastText: "Hello, world" });
  });

  it("assistant_text keeps only the last 500 chars of a long message", () => {
    const progress = reduceProgress(INITIAL_PROGRESS, {
      type: "assistant_text",
      text: `${"a".repeat(10)}${"b".repeat(500)}`,
    });

    expect(progress.lastText).toBe("b".repeat(500));
  });

  it("the first text_delta of a new message resets lastText (deltas accumulate per message)", () => {
    const afterMessage: Progress = { ...INITIAL_PROGRESS, phase: "thinking", lastText: "previous message" };

    const progress = reduceProgress(afterMessage, { type: "text_delta", text: "Next" });

    expect(progress).toEqual({ ...afterMessage, phase: "writing", lastText: "Next" });
  });
  it("tool_use sets phase tool, lastTool, increments toolCalls; tool_result with error increments toolErrors", () => {
    const writing: Progress = { ...INITIAL_PROGRESS, phase: "writing", toolCalls: 1, toolErrors: 1 };

    const calling = reduceProgress(writing, { type: "tool_use", name: "Bash", summary: "npm test" });
    const failed = reduceProgress(calling, { type: "tool_result", isError: true });
    const succeeded = reduceProgress(failed, { type: "tool_result", isError: false });

    expect(calling).toEqual({ ...writing, phase: "tool", lastTool: "Bash npm test", toolCalls: 2 });
    expect(failed).toEqual({ ...calling, phase: "thinking", toolErrors: 2 });
    expect(succeeded).toEqual(failed);
  });

  it("lastTool is the bare tool name when the input has nothing to summarize", () => {
    const progress = reduceProgress(INITIAL_PROGRESS, { type: "tool_use", name: "TodoWrite", summary: "" });

    expect(progress.lastTool).toBe("TodoWrite");
  });
  it("result sets phase done and turns", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking" };
    const result: WorkerEvent = {
      type: "result",
      isError: false,
      text: "done",
      structuredOutput: null,
      turns: 7,
      durationMs: 1000,
      costUsd: 0.5,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      apiErrorStatus: null,
    };

    expect(reduceProgress(thinking, result)).toEqual({ ...thinking, phase: "done", turns: 7 });
  });
  it("other events leave progress unchanged (same object)", () => {
    const thinking: Progress = { ...INITIAL_PROGRESS, phase: "thinking", lastText: "x" };

    expect(reduceProgress(thinking, { type: "other", raw: '{"type": "system", "subtype": "status"}' })).toBe(
      thinking,
    );
  });
});

describe("finalizeWorker", () => {
  it("result with is_error false → completed, report = structured_output", () => {
    const finished = finalizeWorker(fixtureEvents("success-edit.jsonl"), CLEAN_EXIT, null);

    expect(finished.outcome).toEqual({ kind: "completed" });
    expect(finished.report).toEqual({
      summary: "Fixed the off-by-one in range()",
      files: [{ path: "src/range.ts", why: "end bound was exclusive" }],
      root_cause: "loop used < instead of <=",
      tests_added: [],
      open_items: [],
    });
  });
  it("result with is_error true → api_error with the result text; status 429 when the text contains (429)", () => {
    const limited = "API Error: Request rejected (429) · [1302][Rate limit reached for requests]";
    const plain = "API Error: Connection error.";

    const rateLimited = finalizeWorker([resultEvent({ isError: true, text: limited })], CLEAN_EXIT, null);
    const other = finalizeWorker([resultEvent({ isError: true, text: plain })], CLEAN_EXIT, null);

    expect(rateLimited.outcome).toEqual({ kind: "api_error", message: limited, status: 429 });
    expect(other.outcome).toEqual({ kind: "api_error", message: plain });
  });

  it.each([
    [
      "Z.ai 1113",
      'API Error: 429 {"error":{"code":"1113","message":"Insufficient balance or no resource package"}}',
      429,
    ],
    ["Z.ai 1316", 'API Error: 429 {"error":{"code":"1316","message":"usage cap reached"}}', 429],
    [
      "Moonshot",
      'API Error: 429 {"error":{"type":"exceeded_current_quota_error","message":"Your account is suspended"}}',
      429,
    ],
    ["DeepSeek", "API Error: 402 Insufficient Balance", 402],
    [
      "MiniMax 1008",
      'API Error: 500 {"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}',
      500,
    ],
    ["DashScope", 'API Error: 400 {"code":"Arrearage","message":"Access denied"}', 400],
  ])("a provider's out-of-balance answer (%s) is a quota api_error", (_, text, status) => {
    const run = finalizeWorker(
      [resultEvent({ isError: true, text, apiErrorStatus: status })],
      CLEAN_EXIT,
      null,
    );
    expect(run.outcome).toEqual({ kind: "api_error", message: text, status, quota: true });
  });

  it("a rate limit is not out of balance, nor is a code that only looks like one in prose", () => {
    const limited = "API Error: Request rejected (429) · [1302][Rate limit reached for requests]";
    const prose = "API Error: 500 the request id 1113 failed";
    expect(
      finalizeWorker([resultEvent({ isError: true, text: limited })], CLEAN_EXIT, null).outcome,
    ).not.toHaveProperty("quota");
    expect(
      finalizeWorker([resultEvent({ isError: true, text: prose })], CLEAN_EXIT, null).outcome,
    ).not.toHaveProperty("quota");
  });

  it("an api_error with no status found carries no status key at all", () => {
    const failed = finalizeWorker(
      [resultEvent({ isError: true, text: "API Error: Connection error." })],
      CLEAN_EXIT,
      null,
    );

    expect(failed.outcome).toStrictEqual({ kind: "api_error", message: "API Error: Connection error." });
  });
  it("prefers the result's apiErrorStatus over a status found in the text", () => {
    const text = "API Error: Request rejected (429) · upstream said (503)";

    const live = finalizeWorker(
      [resultEvent({ isError: true, text, apiErrorStatus: 529 })],
      CLEAN_EXIT,
      null,
    );
    const fromText = finalizeWorker([resultEvent({ isError: true, text })], CLEAN_EXIT, null);

    expect(live.outcome).toEqual({ kind: "api_error", message: text, status: 529 });
    expect(fromText.outcome).toEqual({ kind: "api_error", message: text, status: 429 });
  });
  it("the rate-limited-429 fixture → api_error status 429 with rateLimitRetries 10", () => {
    const finished = finalizeWorker(
      fixtureEvents("rate-limited-429.jsonl"),
      { ...CLEAN_EXIT, code: 1 },
      null,
    );

    expect(finished.outcome).toEqual({
      kind: "api_error",
      message:
        "API Error: Request rejected (429) · [1302][Rate limit reached for requests][202610060644290fbcd9bc36024c65]",
      status: 429,
    });
    expect(finished.usage.rateLimitRetries).toBe(10);
  });
  it("forced timeout/stopped wins over any result", () => {
    const completed = fixtureEvents("success-edit.jsonl");
    const killed = { code: null, signal: "SIGTERM", stderrTail: "" };

    expect(finalizeWorker(completed, killed, "timeout").outcome).toEqual({ kind: "timeout" });
    expect(finalizeWorker(completed, killed, "stopped").outcome).toEqual({ kind: "stopped" });
    expect(finalizeWorker([], killed, "stopped").outcome).toEqual({ kind: "stopped" });
  });
  it("no result event and non-zero exit → crashed with code, signal and stderr tail", () => {
    const exit = { code: 137, signal: "SIGKILL", stderrTail: "FATAL ERROR: heap out of memory" };

    const finished = finalizeWorker(fixtureEvents("crash-no-result.jsonl"), exit, null);

    expect(finished.outcome).toEqual({
      kind: "crashed",
      exitCode: 137,
      signal: "SIGKILL",
      stderrTail: "FATAL ERROR: heap out of memory",
    });
    expect(finished.report).toBeNull();
  });
  it("no result event and exit 0 → crashed (a run must end with a result)", () => {
    const finished = finalizeWorker(fixtureEvents("crash-no-result.jsonl"), CLEAN_EXIT, null);

    expect(finished.outcome).toEqual({ kind: "crashed", exitCode: 0, signal: null, stderrTail: "" });
  });
  it("usage sums tokens from the last result and counts api_retry events", () => {
    // Only 429s count: rateLimitRetries feeds the AIMD limiter, and an overloaded (529) or network retry is not
    // pressure on the shared Z.ai request budget.
    const retry = (status: number | null): WorkerEvent => ({
      type: "api_retry",
      attempt: 1,
      maxRetries: 10,
      status,
    });
    const events: WorkerEvent[] = [
      retry(429),
      resultEvent({
        turns: 1,
        usage: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 },
      }),
      retry(529),
      retry(null),
      retry(429),
      resultEvent({
        turns: 4,
        durationMs: 5000,
        costUsd: 0.25,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 },
      }),
    ];

    expect(finalizeWorker(events, CLEAN_EXIT, null).usage).toEqual({
      turns: 4,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
      costUsd: 0.25,
      rateLimitRetries: 2,
      durationMs: 5000,
    });
  });

  it("usage is all zeros but the retry count when no result arrived", () => {
    const events: WorkerEvent[] = [{ type: "api_retry", attempt: 1, maxRetries: 10, status: 429 }];

    expect(finalizeWorker(events, CLEAN_EXIT, null).usage).toEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      rateLimitRetries: 1,
      durationMs: 0,
    });
  });
  it("sessionId comes from init, and the first session event beats it — an engine-keyed session announces its own id", () => {
    const withInit = finalizeWorker(fixtureEvents("success-edit.jsonl"), CLEAN_EXIT, null);
    const withoutInit = finalizeWorker([resultEvent()], CLEAN_EXIT, null);
    const engineKeyed = finalizeWorker(
      [
        { type: "init", sessionId: "caller-key", model: "glm-5.3" },
        { type: "session", sessionId: "engine-id-1" },
        { type: "session", sessionId: "engine-id-2" },
        resultEvent(),
      ],
      CLEAN_EXIT,
      null,
    );
    const sessionOnly = finalizeWorker(
      [{ type: "session", sessionId: "engine-id-1" }, resultEvent()],
      CLEAN_EXIT,
      null,
    );

    expect(withInit.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(withoutInit).not.toHaveProperty("sessionId");
    expect(engineKeyed.sessionId).toBe("engine-id-1");
    expect(sessionOnly.sessionId).toBe("engine-id-1");
  });
});
