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

const EMPTY_EMIT = {
  requests: [],
  toolCalls: [],
  agents: [],
  session: null,
  content: [],
  apiErrors: [],
  interrupts: [],
  notices: [],
};

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
      {
        sessionId: "s1",
        id: "main",
        parentId: null,
        kind: "main",
        name: null,
        agentType: null,
        description: null,
      },
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
        what: "→ Bash ls",
      },
    ]);
  });

  it("reads the billing fields the usage block names: 1 h writes, fast mode, geo and tier", () => {
    const state = newTranscriptState();
    feed(state, { type: "user", timestamp: iso(T0) });
    const emit = feed(
      state,
      assistantLine({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 9,
          cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 2 },
          speed: "fast",
          inference_geo: "us",
          service_tier: "standard",
        },
      }),
    );
    expect(emit.requests[0]).toMatchObject({
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 9 }, // cacheWrite stays the total
      cacheWrite1h: 2,
      speed: "fast",
      geo: "us",
      serviceTier: "standard",
    });
  });

  it("ignores an absent or zero 1 h count and empty-string conditions in the usage block", () => {
    const state = newTranscriptState();
    const emit = feed(
      state,
      assistantLine({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          speed: "",
          inference_geo: "",
          service_tier: "",
        },
      }),
    );
    expect(emit.requests[0]?.cacheWrite1h).toBeUndefined();
    expect(emit.requests[0]?.speed).toBeUndefined();
    expect(emit.requests[0]?.geo).toBeUndefined();
    expect(emit.requests[0]?.serviceTier).toBeUndefined();
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

  it("keeps the thinking share of the output when the provider breaks it out", () => {
    const state = newTranscriptState();
    const emit = feed(
      state,
      assistantLine({
        usage: {
          input_tokens: 10,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens_details: { thinking_tokens: 320 },
        },
      }),
    );
    expect(emit.requests[0]?.tokens).toEqual({
      input: 10,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 320,
    });
    // zero or absent details stay off the record
    const silent = feed(
      state,
      assistantLine({
        requestId: "r2",
        usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 0 } },
      }),
    );
    expect(silent.requests[0]?.tokens).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
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

  it("bounds its pending tool calls: interrupted ones drop oldest-first like the other maps", () => {
    const state = newTranscriptState();
    for (let at = 0; at < 600; at += 1) {
      feed(
        state,
        assistantLine({
          timestamp: iso(T0 + at),
          requestId: `r${at}`,
          content: [{ type: "tool_use", id: `tu${at}`, name: "Bash", input: { command: "ls" } }],
        }),
      ); // no tool_result ever lands: an interrupted run's calls would otherwise sit forever
    }
    expect(state.pendingTools.size).toBe(512);
    expect(state.pendingTools.has("tu0")).toBe(false); // the oldest went
    expect(state.pendingTools.has("tu599")).toBe(true); // the newest held
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
      {
        sessionId: "s1",
        id: "chain-1",
        parentId: "main",
        kind: "subagent",
        name: null,
        agentType: null,
        description: null,
      },
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
      {
        sessionId: "s1",
        id: "sidechain",
        parentId: "main",
        kind: "subagent",
        name: null,
        agentType: null,
        description: null,
      },
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
      {
        sessionId: "s1",
        id: "w1",
        parentId: "main",
        kind: "subagent",
        name: null,
        agentType: null,
        description: null,
      },
    ]);
    // the subagent has its own turn clock, independent of s1:main
    const req = feed(state, assistantLine({ timestamp: iso(T1) }), file);
    expect(req.requests[0]?.agentId).toBe("w1");
    expect(req.requests[0]?.latencyMs).toBe(1_000);
  });

  it("carries a subagent meta file's type and task, and names the agent after its type", () => {
    const state = newTranscriptState();
    const file: FileIdentity = {
      sessionId: "s1",
      agentId: "agent-w1",
      kind: "subagent",
      agentMeta: { agentType: "Explore", description: "find the flaky test" },
    };
    const emit = feed(state, { type: "user", timestamp: iso(T0) }, file);
    expect(emit.agents).toEqual([
      {
        sessionId: "s1",
        id: "agent-w1",
        parentId: "main",
        kind: "subagent",
        name: "Explore",
        agentType: "Explore",
        description: "find the flaky test",
      },
    ]);
  });

  it("names a subagent after the head of its first prompt when no meta file does", () => {
    const state = newTranscriptState();
    const file: FileIdentity = { sessionId: "s1", agentId: "agent-a95a00", kind: "subagent" };
    const first = feed(
      state,
      {
        type: "user",
        timestamp: iso(T0),
        message: { role: "user", content: "  Summarize the\n flaky test  " },
      },
      file,
    );
    expect(first.agents).toHaveLength(2); // the agent's descriptor, then its prompt title
    expect(first.agents[1]).toMatchObject({
      id: "agent-a95a00",
      kind: "subagent",
      name: null,
      title: "Summarize the flaky test",
    });
    const again = feed(
      state,
      { type: "user", timestamp: iso(T1), message: { role: "user", content: "another task" } },
      file,
    );
    expect(again.agents).toEqual([]); // once per agent: later prompts never rename it
  });
});

describe("session naming meta", () => {
  it("emits a naming line as session meta, timestamp or not", () => {
    const state = newTranscriptState();
    expect(feed(state, { type: "custom-title", customTitle: "Port the router" }).session).toEqual({
      id: "s1",
      customTitle: "Port the router",
    });
    expect(feed(state, { type: "agent-name", agentName: "Scout" }).session).toEqual({
      id: "s1",
      agentName: "Scout",
    });
    expect(feed(state, { type: "ai-title", aiTitle: "Porting the router" }).session).toEqual({
      id: "s1",
      aiTitle: "Porting the router",
    });
  });

  it("ignores naming lines with empty or non-string values", () => {
    const state = newTranscriptState();
    expect(feed(state, { type: "custom-title", customTitle: "" }).session).toBeNull();
    expect(feed(state, { type: "ai-title", aiTitle: 42 }).session).toBeNull();
    expect(feed(state, { type: "custom-title" }).session).toBeNull();
  });

  it("reads slug and gitBranch off ordinary entries alongside cwd and version", () => {
    const state = newTranscriptState();
    const emit = feed(state, {
      type: "user",
      timestamp: iso(T0),
      cwd: "/w/app",
      version: "2.0.0",
      slug: "porting-the-router",
      gitBranch: "feat/router",
    });
    expect(emit.session).toEqual({
      id: "s1",
      cwd: "/w/app",
      ccVersion: "2.0.0",
      slug: "porting-the-router",
      branch: "feat/router",
    });
  });

  it("lets entry.sessionId route a naming line to that session", () => {
    const state = newTranscriptState();
    expect(feed(state, { type: "custom-title", customTitle: "Other", sessionId: "zz" }).session).toEqual({
      id: "zz",
      customTitle: "Other",
    });
  });
});

describe("a remapped file (a job attempt's real transcript)", () => {
  const JOB_MAIN: FileIdentity = {
    sessionId: "zai:j1",
    agentId: "j1",
    kind: "external",
    upstream: "https://api.z.ai/api/anthropic",
    remap: { sessionId: "zai:j1", agentId: "j1" },
  };
  const JOB_SUB: FileIdentity = {
    sessionId: "zai:j1",
    agentId: "agent-w1",
    kind: "subagent",
    remap: { sessionId: "zai:j1", agentId: "j1", parentId: "j1" },
  };

  it("lands every record on the job session and agent, whatever the lines carry", () => {
    const state = newTranscriptState();
    const first = feed(
      state,
      { type: "user", timestamp: iso(T0), sessionId: "att-1", cwd: "/w/wt" },
      JOB_MAIN,
    );
    expect(first.agents).toEqual([
      {
        sessionId: "zai:j1",
        id: "j1",
        parentId: "main",
        kind: "external",
        name: null,
        agentType: null,
        description: null,
      },
    ]);
    const emit = feed(
      state,
      assistantLine({ timestamp: iso(T1), sessionId: "att-1", requestId: "req-1" }),
      JOB_MAIN,
    );
    expect(emit.requests[0]).toMatchObject({
      id: "req-1",
      sessionId: "zai:j1",
      agentId: "j1",
      upstream: "https://api.z.ai/api/anthropic",
    });
  });

  it("keeps the job session's name, title and branch free of the attempt transcript's own", () => {
    const state = newTranscriptState();
    expect(
      feed(state, { type: "custom-title", customTitle: "Attempt", sessionId: "att-1" }, JOB_MAIN).session,
    ).toBeNull();
    const turn = feed(
      state,
      { type: "user", timestamp: iso(T1), sessionId: "att-1", slug: "attempting", gitBranch: "attempt" },
      JOB_MAIN,
    );
    expect(turn.session).toBeNull(); // a naming line and slug/branch never rename a job session
    expect(state.lastUserTs.has("zai:j1:j1")).toBe(true); // the turn boundary still lands on the job agent
  });

  it("hangs a remapped subagent off the job agent and keeps its own id", () => {
    const state = newTranscriptState();
    const emit = feed(state, assistantLine({ timestamp: iso(T1), sessionId: "att-1" }), JOB_SUB);
    expect(emit.agents).toEqual([
      {
        sessionId: "zai:j1",
        id: "agent-w1",
        parentId: "j1",
        kind: "subagent",
        name: null,
        agentType: null,
        description: null,
      },
    ]);
    expect(emit.requests[0]).toMatchObject({ sessionId: "zai:j1", agentId: "agent-w1" });
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

describe("a claude -p stream whose provider reports usage only at the end", () => {
  const JOB: FileIdentity = {
    sessionId: "zai:j1",
    agentId: "j1",
    kind: "external",
    upstream: "https://api.z.ai/api/anthropic",
  };
  const assistant = (id: string, ts: number, usage: Record<string, number>) => ({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    requestId: id,
    message: { model: "glm-5.3-flash", usage, content: [] },
  });
  const result = (usage: Record<string, number>) => ({ type: "result", session_id: "x", usage });

  it("puts the result's total on the last request, sent where the file's source says", () => {
    const state = newTranscriptState();
    const first = feed(state, assistant("r1", T0, { input_tokens: 0, output_tokens: 0 }), JOB);
    expect(first.requests[0]).toMatchObject({ upstream: "https://api.z.ai/api/anthropic" });
    feed(state, assistant("r2", T1, { input_tokens: 0, output_tokens: 0 }), JOB);
    const end = feed(
      state,
      result({ input_tokens: 62_639, output_tokens: 10_446, cache_read_input_tokens: 857_600 }),
      JOB,
    );
    expect(end.requests).toHaveLength(1);
    expect(end.requests[0]).toMatchObject({
      id: "r2",
      tokens: { input: 62_639, output: 10_446, cacheRead: 857_600, cacheWrite: 0 },
    });
    // a second result (a retried attempt's) does not add the total twice
    expect(feed(state, result({ input_tokens: 5, output_tokens: 5 }), JOB).requests).toEqual([]);
  });

  it("marks the request it fills as a run total, so the context alert can skip it", () => {
    const state = newTranscriptState();
    feed(state, assistant("r1", T0, { input_tokens: 0, output_tokens: 0 }), JOB);
    feed(state, assistant("r2", T1, { input_tokens: 0, output_tokens: 0 }), JOB);
    const end = feed(state, result({ input_tokens: 500, output_tokens: 20 }), JOB);
    expect(end.requests[0]).toMatchObject({ id: "r2", totals: true });
  });

  it("leaves requests that reported their own usage alone, and ignores an empty or orphan result", () => {
    const state = newTranscriptState();
    expect(feed(state, result({ input_tokens: 9 }), JOB)).toEqual(EMPTY_EMIT); // no request yet
    feed(state, assistant("r1", T0, { input_tokens: 0, output_tokens: 0 }), JOB);
    expect(feed(state, result({}), JOB)).toEqual(EMPTY_EMIT); // nothing in the result either
    feed(state, assistant("r2", T1, { input_tokens: 4, output_tokens: 2 }), JOB);
    expect(feed(state, result({ input_tokens: 99, output_tokens: 1 }), JOB)).toEqual(EMPTY_EMIT);
  });
});

describe("content capture", () => {
  it("captures a text prompt as the request's input and the answer's blocks as its output", () => {
    const state = newTranscriptState();
    feed(state, { type: "user", timestamp: iso(T0), message: { content: "Fix the login bug" } });
    const emit = feed(
      state,
      assistantLine({
        timestamp: iso(T1),
        content: [
          { type: "thinking", text: "plan" },
          { type: "text", text: "On it" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
        ],
      }),
    );
    expect(emit.content).toHaveLength(1);
    expect(emit.content[0]?.requestId).toBe("req_9");
    expect(JSON.parse(emit.content[0]?.input ?? "null")).toEqual([
      { type: "text", text: "Fix the login bug" },
    ]);
    expect(JSON.parse(emit.content[0]?.output ?? "null")).toEqual([
      { type: "thinking", text: "plan" },
      { type: "text", text: "On it" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("feeds the next request the tool results the chain logged since the last answer", () => {
    const state = newTranscriptState();
    feed(state, assistantLine({ timestamp: iso(T0) }));
    feed(state, {
      type: "user",
      timestamp: iso(T1),
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "out" }] },
          { type: "tool_result", tool_use_id: "tu2", is_error: true, content: "boom" },
        ],
      },
    });
    const emit = feed(state, assistantLine({ timestamp: iso(T2), requestId: "r2" }));
    expect(JSON.parse(emit.content[0]?.input ?? "null")).toEqual([
      { type: "tool_result", tool_use_id: "tu1", text: "out" },
      { type: "tool_result", tool_use_id: "tu2", is_error: true, text: "boom" },
    ]);
    // consumed by that request: a second answer with no user entry between has no input
    const again = feed(state, assistantLine({ timestamp: iso(T2 + 1), requestId: "r3" }));
    expect(again.content[0]?.input).toBeNull();
    expect(JSON.parse(again.content[0]?.output ?? "null")).toEqual([
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("gives a subagent message one request id and the tool results logged between its own blocks", () => {
    const state = newTranscriptState();
    const SUB: FileIdentity = { sessionId: "s1", agentId: "agent-1", kind: "subagent" };
    // a subagent transcript carries no requestId and writes one entry per content block, tool results
    // landing between the blocks of the same message (shape of a real subagents/agent-*.jsonl)
    const block = (msgId: string, uuid: string, ts: number, content: Record<string, unknown>[]) =>
      feed(
        state,
        {
          type: "assistant",
          isSidechain: true,
          uuid,
          timestamp: iso(ts),
          message: { id: msgId, role: "assistant", model: "claude-sonnet-5-5", content },
        },
        SUB,
      );
    const toolResult = (uuid: string, ts: number, id: string, text: string) =>
      feed(
        state,
        {
          type: "user",
          isSidechain: true,
          uuid,
          timestamp: iso(ts),
          message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
        },
        SUB,
      );
    feed(state, { type: "user", timestamp: iso(T0), message: { content: "list the files" } }, SUB);
    const firstBlock = block("msg_a", "aaaa0001", T1, [{ type: "thinking", text: "plan" }]);
    block("msg_a", "aaaa0002", T1 + 1, [
      { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
    ]);
    toolResult("rrrr0001", T1 + 2, "tu1", "out");
    feed(
      state,
      { type: "attachment", isSidechain: true, uuid: "tttt0001", timestamp: iso(T1 + 3), attachment: {} },
      SUB,
    );
    // the same response's later block arrives after that tool result
    const lateBlock = block("msg_a", "aaaa0003", T1 + 4, [
      { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/tmp/x" } },
    ]);
    toolResult("rrrr0002", T1 + 5, "tu2", "body");
    const next = block("msg_b", "bbbb0001", T1 + 6, [{ type: "text", text: "Done" }]);

    // every block of one API response is that one request, not a request of its own
    expect(firstBlock.content[0]?.requestId).toBe("msg_a");
    expect(lateBlock.requests[0]?.id).toBe("msg_a");
    expect(next.requests[0]?.id).toBe("msg_b");
    // its first block took the prompt logged before the message started
    expect(JSON.parse(firstBlock.content[0]?.input ?? "null")).toEqual([
      { type: "text", text: "list the files" },
    ]);
    // the late block took nothing: its tool result waits for the next request
    expect(lateBlock.content.at(-1)?.input).toBeNull();
    // both tool results, in order, though the first arrived between msg_a's own blocks
    expect(JSON.parse(next.content[0]?.input ?? "null")).toEqual([
      { type: "tool_result", tool_use_id: "tu1", text: "out" },
      { type: "tool_result", tool_use_id: "tu2", text: "body" },
    ]);
  });

  it("keeps a thinking block's words, which the wire carries under `thinking`, not `text`", () => {
    const state = newTranscriptState();
    const emit = feed(
      state,
      assistantLine({
        timestamp: iso(T1),
        content: [
          { type: "thinking", thinking: "secret plan text", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      }),
    );
    expect(JSON.parse(emit.content[0]?.output ?? "null")).toEqual([
      { type: "thinking", thinking: "secret plan text" },
      { type: "text", text: "answer" },
    ]);
  });

  it("grows a streamed thinking block across its entries the way a text one grows", () => {
    const state = newTranscriptState();
    feed(state, { type: "user", timestamp: iso(T0), message: { content: "hi" } });
    feed(state, assistantLine({ timestamp: iso(T1), content: [{ type: "thinking", thinking: "plan" }] }));
    const emit = feed(
      state,
      assistantLine({ timestamp: iso(T1 + 1), content: [{ type: "thinking", thinking: "plan more" }] }),
    );
    expect(JSON.parse(emit.content[0]?.output ?? "null")).toEqual([
      { type: "thinking", thinking: "plan more" },
    ]);
  });

  it("keeps a prompt's image as its media type and decoded size, never the data", () => {
    const state = newTranscriptState();
    const data = Buffer.from("png-bytes").toString("base64"); // 9 bytes, 12 base64 characters
    feed(state, {
      type: "user",
      timestamp: iso(T0),
      message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] },
    });
    const emit = feed(state, assistantLine({ timestamp: iso(T1) }));
    expect(JSON.parse(emit.content[0]?.input ?? "null")).toEqual([
      { type: "image", media_type: "image/png", bytes: 9, text: "[image image/png, 9 bytes]" },
    ]);
  });

  it("marks a tool result that only carried an image, instead of reading as empty", () => {
    const state = newTranscriptState();
    const data = Buffer.alloc(32).toString("base64");
    feed(
      state,
      assistantLine({
        timestamp: iso(T0),
        content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "x.png" } }],
      }),
    );
    feed(state, {
      type: "user",
      timestamp: iso(T1),
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
          },
        ],
      },
    });
    const emit = feed(state, assistantLine({ timestamp: iso(T2), requestId: "r2" }));
    expect(JSON.parse(emit.content[0]?.input ?? "null")).toEqual([
      { type: "tool_result", tool_use_id: "tu1", text: "[image image/png, 32 bytes]" },
    ]);
  });

  it("merges a streamed message's rewrites into one growing output, tool_use kept once", () => {
    const state = newTranscriptState();
    feed(state, { type: "user", timestamp: iso(T0), message: { content: "hi" } });
    const first = feed(
      state,
      assistantLine({ timestamp: iso(T1), content: [{ type: "text", text: "Hel" }] }),
    );
    expect(JSON.parse(first.content[0]?.output ?? "null")).toEqual([{ type: "text", text: "Hel" }]);
    const second = feed(
      state,
      assistantLine({ timestamp: iso(T1 + 1), content: [{ type: "text", text: "Hello" }] }),
    );
    expect(JSON.parse(second.content[0]?.output ?? "null")).toEqual([{ type: "text", text: "Hello" }]);
    const third = feed(
      state,
      assistantLine({
        timestamp: iso(T1 + 2),
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
        ],
      }),
    );
    expect(JSON.parse(third.content[0]?.output ?? "null")).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("keeps a 200 KB block whole: past the old cap, under the one kept now", () => {
    const state = newTranscriptState();
    const big = "a".repeat(200_000);
    feed(state, { type: "user", timestamp: iso(T0), message: { content: big } });
    const emit = feed(state, assistantLine({ timestamp: iso(T1), content: [{ type: "text", text: big }] }));
    const input = JSON.parse(emit.content[0]?.input ?? "null") as { text: string }[];
    const output = JSON.parse(emit.content[0]?.output ?? "null") as { text: string }[];
    expect(input[0]?.text).toBe(big);
    expect(output[0]?.text).toBe(big);
  });

  it("caps a block past 1 MB with a marker naming the lost bytes, and records the cut for the UI", () => {
    const state = newTranscriptState();
    const huge = "a".repeat(1024 * 1024 + 4_464);
    feed(state, { type: "user", timestamp: iso(T0), message: { content: huge } });
    const emit = feed(state, assistantLine({ timestamp: iso(T1), content: [{ type: "text", text: huge }] }));
    const input = JSON.parse(emit.content[0]?.input ?? "null") as {
      text: string;
      truncated?: number;
    }[];
    const output = JSON.parse(emit.content[0]?.output ?? "null") as {
      text: string;
      truncated?: number;
    }[];
    for (const block of [input[0], output[0]]) {
      expect(block?.text?.endsWith("…[truncated 4464 bytes]")).toBe(true);
      expect(block?.truncated).toBe(4_464);
      expect(Buffer.byteLength(block?.text ?? "")).toBeLessThanOrEqual(1024 * 1024 + 32);
    }
  });
});

describe("the what line", () => {
  /** The request's `what`, fed one user line and one assistant line; `null` feeds no input at all. */
  const whatOf = (content: unknown[], user?: Record<string, unknown> | null): string | undefined => {
    const state = newTranscriptState();
    if (user !== null)
      feed(state, user ?? { type: "user", timestamp: iso(T0), message: { content: "Fix the login bug" } });
    return feed(state, assistantLine({ timestamp: iso(T1), content })).requests[0]?.what;
  };

  it("names the prompt's first 40 characters and the answer's tool calls", () => {
    expect(whatOf([{ type: "text", text: "On it" }])).toBe("↳ prompt: Fix the login bug  → text");
    expect(
      whatOf(
        [
          { type: "text", text: "On it" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "git status --porcelain" } },
        ],
        { type: "user", timestamp: iso(T0), message: { content: "x".repeat(60) } },
      ),
    ).toBe(`↳ prompt: ${"x".repeat(40)}  → Bash git status`);
  });

  it("counts tool results on the input side", () => {
    const user = {
      type: "user",
      timestamp: iso(T0),
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "out" },
          { type: "tool_result", tool_use_id: "tu2", content: "out" },
          { type: "tool_result", tool_use_id: "tu3", content: "out" },
        ],
      },
    };
    expect(whatOf([{ type: "text", text: "Done" }], user)).toBe("↳ 3 tool results  → text");
  });

  it("picks the telling argument per tool: file basename, command head, pattern", () => {
    expect(
      whatOf(
        [
          {
            type: "tool_use",
            id: "tu1",
            name: "Edit",
            input: { file_path: "/w/app/src/store/store.ts", old_string: "a", new_string: "b" },
          },
        ],
        null,
      ),
    ).toBe("→ Edit store.ts");
    expect(
      whatOf(
        [{ type: "tool_use", id: "tu1", name: "Grep", input: { pattern: "placeRequest", path: "/w" } }],
        null,
      ),
    ).toBe("→ Grep placeRequest");
    expect(
      whatOf(
        [{ type: "tool_use", id: "tu1", name: "NotebookEdit", input: { notebook_path: "/w/n.ipynb" } }],
        null,
      ),
    ).toBe("→ NotebookEdit n.ipynb");
    // a tool whose input names nothing shows under its name alone
    expect(whatOf([{ type: "tool_use", id: "tu1", name: "TaskOutput", input: { task_id: 7 } }], null)).toBe(
      "→ TaskOutput",
    );
  });

  it("lists at most three tool calls, then the count", () => {
    expect(
      whatOf(
        [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/a.ts" } },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/b.ts" } },
          { type: "tool_use", id: "t3", name: "Read", input: { file_path: "/w/c.ts" } },
          { type: "tool_use", id: "t4", name: "Read", input: { file_path: "/w/d.ts" } },
        ],
        null,
      ),
    ).toBe("→ Read a.ts, Read b.ts, Read c.ts +1");
  });

  it("keeps the input part a streamed message's first entry computed", () => {
    const state = newTranscriptState();
    feed(state, { type: "user", timestamp: iso(T0), message: { content: "Fix the login bug" } });
    const first = feed(
      state,
      assistantLine({ timestamp: iso(T1), content: [{ type: "text", text: "Working" }] }),
    );
    expect(first.requests[0]?.what).toBe("↳ prompt: Fix the login bug  → text");
    // the streamed rewrite carries no input of its own, and ends with a tool call
    const second = feed(
      state,
      assistantLine({
        timestamp: iso(T2),
        content: [
          { type: "text", text: "Working" },
          { type: "tool_use", id: "tu9", name: "Edit", input: { file_path: "/w/app/auth.ts" } },
        ],
      }),
    );
    expect(second.requests[0]?.what).toBe("↳ prompt: Fix the login bug  → Edit auth.ts");
  });

  it("stays undefined when nothing was captured on either side", () => {
    const state = newTranscriptState();
    const emit = feed(state, assistantLine({ timestamp: iso(T1), content: [] }));
    expect(emit.requests[0]?.what).toBeUndefined();
  });
});
