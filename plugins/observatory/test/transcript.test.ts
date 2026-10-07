import { describe, expect, it } from "vitest";
import {
  type FileIdentity,
  feedTranscriptLine,
  identifyFile,
  newTranscriptState,
  type TranscriptState,
} from "../src/ingest/transcript.ts";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const T1 = T0 + 1_000;
const T2 = T0 + 3_000;
const MAIN: FileIdentity = { sessionId: "s1", agentId: null, kind: "main" };

function feed(state: TranscriptState, raw: unknown, file: FileIdentity = MAIN) {
  return feedTranscriptLine(state, file, typeof raw === "string" ? raw : JSON.stringify(raw));
}

const EMPTY_EMIT = { requests: [], toolCalls: [], agents: [], session: null, apiErrors: [], interrupts: [] };

describe("identifyFile", () => {
  it("reads session and agent off the path", () => {
    expect(identifyFile("/h/.claude/projects/-Users-w-app/abc123.jsonl")).toEqual({
      sessionId: "abc123",
      agentId: null,
      kind: "main",
    });
    expect(identifyFile("/h/.claude/projects/-Users-w-app/abc123/subagents/worker-1.jsonl")).toEqual({
      sessionId: "abc123",
      agentId: "worker-1",
      kind: "subagent",
    });
    expect(identifyFile("bare-name")).toEqual({ sessionId: "bare-name", agentId: null, kind: "main" });
  });
});

describe("feedTranscriptLine rejects junk", () => {
  it("returns the shared empty emit for bad JSON, non-objects and missing timestamps", () => {
    const state = newTranscriptState();
    const first = feed(state, "{not json");
    expect(first).toEqual(EMPTY_EMIT);
    expect(feed(state, "[1,2]")).toEqual(EMPTY_EMIT);
    expect(feed(state, '"text"')).toEqual(EMPTY_EMIT);
    expect(feed(state, {})).toEqual(EMPTY_EMIT); // no timestamp
    expect(feed(state, { timestamp: 123 })).toEqual(EMPTY_EMIT); // not a string
    expect(feed(state, { timestamp: "not-a-date" })).toEqual(EMPTY_EMIT); // unparseable
    expect(feed(state, "{not json")).toBe(first); // same frozen object, not a fresh one
  });
});

describe("feedTranscriptLine happy path", () => {
  it("emits the main agent once and the session meta on every line that carries it", () => {
    const state = newTranscriptState();
    const first = feed(state, {
      type: "user",
      timestamp: iso(T0),
      cwd: "/w/app",
      version: "2.0.0",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    expect(first.agents).toEqual([
      { sessionId: "s1", id: "main", parentId: null, kind: "main", name: "main" },
    ]);
    expect(first.session).toEqual({ id: "s1", cwd: "/w/app", ccVersion: "2.0.0" });

    const second = feed(state, { type: "user", timestamp: iso(T1), cwd: "/w/app" });
    expect(second.agents).toEqual([]);
    expect(second.session).toEqual({ id: "s1", cwd: "/w/app" }); // ccVersion absent when not a string
  });

  it("builds a request per assistant message with latency from the previous turn boundary", () => {
    const state = newTranscriptState();
    feed(state, { type: "user", timestamp: iso(T0) });
    const emit = feed(state, assistantLine({}));
    expect(emit.requests).toEqual([
      {
        id: "req_9",
        sessionId: "s1",
        agentId: "main",
        model: "claude-sonnet-5-5",
        upstream: "",
        ts: T1,
        latencyMs: 1_000,
        tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
        stopReason: "end_turn",
        provider: "Anthropic",
      },
    ]);
  });

  it("falls back to msg:<uuid> or msg:<ts> as the request id and drops model-less messages", () => {
    const state = newTranscriptState();
    const withUuid = feed(state, assistantLine({ requestId: null, uuid: "u-7" }));
    expect(withUuid.requests[0]?.id).toBe("msg:u-7");
    const noUuid = feed(state, assistantLine({ requestId: null, timestamp: iso(T2) }));
    expect(noUuid.requests[0]?.id).toBe(`msg:${T2}`);
    const bare = feed(state, assistantLine({ requestId: null, model: null, timestamp: iso(T2) }));
    expect(bare.requests).toEqual([]);
  });

  it("yields no latency without a prior boundary or when timestamps go backwards", () => {
    const state = newTranscriptState();
    const cold = feed(state, assistantLine({ timestamp: iso(T2) }));
    expect(cold.requests[0]?.latencyMs).toBeNull();
    feed(state, { type: "user", timestamp: iso(T2) });
    const backwards = feed(state, assistantLine({ timestamp: iso(T0) }));
    expect(backwards.requests[0]?.latencyMs).toBeNull();
  });

  it("reads zero for absent or non-numeric usage fields", () => {
    const state = newTranscriptState();
    const garbage = feed(state, assistantLine({ usage: { input_tokens: "x", output_tokens: "y" } }));
    expect(garbage.requests[0]?.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const absent = feed(state, assistantLine({ usage: null, requestId: "r2", timestamp: iso(T2) }));
    expect(absent.requests[0]?.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("pairs tool_use with its tool_result for a duration, marking failures", () => {
    const state = newTranscriptState();
    feed(state, assistantLine({ timestamp: iso(T0) }));
    const done = feed(state, {
      type: "user",
      timestamp: iso(T2),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1" }] },
    });
    expect(done.toolCalls).toEqual([
      {
        id: "tu1",
        sessionId: "s1",
        agentId: "main",
        name: "Bash",
        startedAt: T0,
        durationMs: 3_000,
        ok: true,
        inputKey: expect.stringMatching(/^[0-9a-f]{8}$/),
      },
    ]);
    feed(state, assistantLine({ timestamp: iso(T2), requestId: "r2" }));
    const failed = feed(state, {
      type: "user",
      timestamp: iso(T2),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "nope", is_error: true }] },
    });
    expect(failed.toolCalls).toEqual([
      {
        id: "nope",
        sessionId: "s1",
        agentId: "main",
        name: "unknown",
        startedAt: T2,
        durationMs: null,
        ok: false,
      },
    ]);
  });

  it("ignores string content and tool_use blocks without usable ids", () => {
    const state = newTranscriptState();
    const str = feed(state, {
      type: "user",
      timestamp: iso(T0),
      message: { role: "user", content: "plain text" },
    });
    expect(str.toolCalls).toEqual([]);
    const emit = feed(
      state,
      assistantLine({
        timestamp: iso(T1),
        content: [
          { type: "tool_use", id: 7, name: "Bash" },
          { type: "tool_use", id: "ok-1", name: "Read" },
        ],
      }),
    );
    expect([...state.pendingTools.keys()]).toEqual(["ok-1"]);
    expect(emit.requests).toHaveLength(1);
  });
});

describe("agent attribution", () => {
  it("routes sidechain entries to their own subagent tag", () => {
    const state = newTranscriptState();
    const emit = feed(state, {
      type: "assistant",
      timestamp: iso(T1),
      isSidechain: true,
      agentId: "chain-1",
      message: { role: "assistant", model: "glm-5.3", content: [] },
    });
    expect(emit.agents).toEqual([
      { sessionId: "s1", id: "chain-1", parentId: "main", kind: "subagent", name: "chain-1" },
    ]);
    expect(emit.requests[0]?.agentId).toBe("chain-1");
    expect(emit.requests[0]?.provider).toBe("Z.ai");
  });

  it("falls back to the literal id 'sidechain' when the entry carries no agentId", () => {
    const state = newTranscriptState();
    const emit = feed(state, {
      type: "assistant",
      timestamp: iso(T1),
      isSidechain: true,
      message: { role: "assistant", model: "kimi-k2.5", content: [] },
    });
    expect(emit.agents).toEqual([
      { sessionId: "s1", id: "sidechain", parentId: "main", kind: "subagent", name: "sidechain" },
    ]);
  });

  it("lets entry.sessionId override the file's session and keeps per-agent turn boundaries", () => {
    const state = newTranscriptState();
    const emit = feed(state, { type: "user", timestamp: iso(T0), sessionId: "zz", cwd: "/w/zz" });
    expect(emit.session).toEqual({ id: "zz", cwd: "/w/zz" });
    feed(state, { type: "system", timestamp: iso(T1), sessionId: "zz" });
    const req = feed(state, assistantLine({ timestamp: iso(T2), sessionId: "zz" }));
    expect(req.requests[0]?.sessionId).toBe("zz");
    expect(req.requests[0]?.latencyMs).toBe(2_000); // system entries also mark turn boundaries
  });

  it("attributes a subagents/*.jsonl file to its named agent", () => {
    const state = newTranscriptState();
    const file: FileIdentity = { sessionId: "s1", agentId: "w1", kind: "subagent" };
    const emit = feed(state, { type: "user", timestamp: iso(T0) }, file);
    expect(emit.agents).toEqual([
      { sessionId: "s1", id: "w1", parentId: "main", kind: "subagent", name: "w1" },
    ]);
    // the subagent has its own turn clock, independent of s1:main
    const req = feed(state, assistantLine({ timestamp: iso(T1) }), file);
    expect(req.requests[0]?.agentId).toBe("w1");
    expect(req.requests[0]?.latencyMs).toBe(1_000);
  });
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type AssistantOverrides = {
  timestamp?: string;
  /** null omits the field entirely; leaving it out keeps the default. */
  requestId?: string | null;
  uuid?: string;
  model?: string | null;
  usage?: Record<string, unknown> | null;
  content?: unknown[];
  sessionId?: string;
};

/** One assistant turn: a model, a usage block and a Bash tool_use, overridable field by field. */
function assistantLine(overrides: AssistantOverrides = {}): Record<string, unknown> {
  const model = overrides.model === undefined ? "claude-sonnet-5-5" : overrides.model;
  const usage =
    overrides.usage === undefined
      ? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }
      : overrides.usage;
  const message: Record<string, unknown> = {
    role: "assistant",
    stop_reason: "end_turn",
    content: overrides.content ?? [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
  };
  if (model !== null) message.model = model;
  if (usage !== null) message.usage = usage;
  const line: Record<string, unknown> = {
    type: "assistant",
    timestamp: overrides.timestamp ?? iso(T1),
    message,
  };
  const requestId = overrides.requestId === undefined ? "req_9" : overrides.requestId;
  if (requestId !== null) line.requestId = requestId;
  if (overrides.uuid !== undefined) line.uuid = overrides.uuid;
  if (overrides.sessionId !== undefined) line.sessionId = overrides.sessionId;
  return line;
}
