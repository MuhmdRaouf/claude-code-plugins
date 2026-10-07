import { describe, expect, it } from "vitest";
import {
  MAX_RECORDS,
  MAX_SESSIONS,
  type SpoolLine,
  type Tokens,
  type ToolCallRecord,
  ZERO_TOKENS,
} from "../src/shared/model.ts";
import { type Change, createStore } from "../src/store/store.ts";
import { iso, makeRequest, makeTool } from "./helpers.ts";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;
const T3 = T0 + 3_000;

function line(overrides: Partial<SpoolLine> = {}): SpoolLine {
  return { ts: iso(T1), event: "UserPromptSubmit", session_id: "s1", ...overrides };
}

function tokens(input: number, output: number, cacheRead: number, cacheWrite: number): Tokens {
  return { input, output, cacheRead, cacheWrite };
}

describe("addSpoolLine", () => {
  it("creates sessions, keeps first-writer meta and orders the list by recency", () => {
    const store = createStore();
    store.addSpoolLine(
      line({ ts: iso(T0), cwd: "/w/app", base_url: "http://127.0.0.1:8787", cc_version: "2.0.0" }),
    );
    store.addSpoolLine(line({ ts: iso(T1), model_env: { ANTHROPIC_MODEL: "glm-5.3" } }));
    store.addSpoolLine(line({ ts: iso(T1), cwd: "/later" })); // meta only fills holes
    store.addSpoolLine(line({ ts: iso(T2), session_id: "s2", cwd: "/w/other" }));
    expect(store.sessionDetail("s1")).toMatchObject({
      id: "s1",
      cwd: "/w/app",
      project: "app",
      upstream: "http://127.0.0.1:8787",
      ccVersion: "2.0.0",
      model: "glm-5.3",
      startedAt: T0,
      live: true,
      external: false,
    });
    const list = store.sessionList();
    expect(list.map((item) => item.id)).toEqual(["s2", "s1"]);
    expect(list[0]).toMatchObject({ id: "s2", project: "other", lastAt: T2, live: true });
  });

  it("records sessionless lines as events without inventing a session", () => {
    const store = createStore();
    store.addSpoolLine({ ts: iso(T1), event: "Notification" });
    expect(store.sessionList()).toEqual([]);
    expect(store.events({})).toHaveLength(1);
    expect(store.events({})[0]).toMatchObject({
      kind: "Notification",
      sessionId: null,
      agentId: null,
      label: null,
    });
  });

  it("labels every line from the first field it recognises", () => {
    const store = createStore();
    const cases: Array<[SpoolLine, string | null]> = [
      [line({ prompt: "x".repeat(200) }), "x".repeat(120)],
      [
        {
          ts: iso(T1),
          event: "route",
          session_id: "s1",
          model: "glm-5.3",
          upstream: "http://127.0.0.1:8787",
        },
        "glm-5.3 → http://127.0.0.1:8787",
      ],
      [
        line({ event: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a/b.ts" } }),
        "Read /a/b.ts",
      ],
      [
        line({ event: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "f".repeat(100) } }),
        `Edit ${"f".repeat(90)}`,
      ],
      [line({ event: "PreToolUse", tool_name: "Bash", tool_input: "raw" }), "Bash"],
      [line({ event: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "" } }), "Edit"],
      [line({ event: "SubagentStart", agent_type: "researcher" }), "researcher"],
      [line({ event: "Stop", reason: "end_turn" }), "end_turn"],
      [line({ event: "SessionStart", source: "startup" }), "startup"],
      [line({ event: "Notification", message: "m".repeat(200) }), "m".repeat(120)],
      [line({ event: "PreCompact", trigger: "auto" }), "auto"],
      [line({ event: "Notification" }), null],
    ];
    for (const [input, expected] of cases) {
      store.addSpoolLine(input);
      expect(store.events({ limit: 1 })[0]?.label).toBe(expected);
    }
  });

  it("filters events newest-first by session, since and limit", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), prompt: "a" }));
    store.addSpoolLine(line({ ts: iso(T1), prompt: "b" }));
    store.addSpoolLine(line({ ts: iso(T2), session_id: "s2", prompt: "c" }));
    const newest = store.events({});
    expect(newest.map((event) => event.label)).toEqual(["c", "b", "a"]);
    expect(newest[0]).toMatchObject({
      kind: "UserPromptSubmit",
      sessionId: "s2",
      agentId: null,
      ts: T2,
      seq: 3,
    });
    expect(newest[0]?.payload).toMatchObject({ prompt: "c" });
    expect(store.events({ session: "s1" }).map((event) => event.ts)).toEqual([T1, T0]);
    expect(store.events({ since: T1 }).map((event) => event.ts)).toEqual([T2, T1]);
    expect(store.events({ limit: 2 }).map((event) => event.ts)).toEqual([T2, T1]);
  });
});

describe("lifecycle", () => {
  it("ends, restarts and re-parents sessions and subagents from hook events alone", () => {
    const store = createStore();
    store.addSpoolLine(line({ ts: iso(T0), event: "SessionEnd" }));
    expect(store.sessionDetail("s1")).toMatchObject({ live: false, endedAt: T0, startedAt: T0 });
    store.addSpoolLine(line({ ts: iso(T1), event: "SessionStart", cwd: "/w/app" }));
    expect(store.sessionDetail("s1")).toMatchObject({
      live: true,
      endedAt: null,
      startedAt: T0,
      cwd: "/w/app",
    });

    store.addSpoolLine(
      line({
        ts: iso(T2),
        event: "SubagentStart",
        agent_id: "w1",
        agent_type: "researcher",
        prompt: "p".repeat(100),
      }),
    );
    const agents = store.sessionDetail("s1")?.agents ?? [];
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      id: "w1",
      parentId: "main",
      kind: "subagent",
      name: "p".repeat(80), // the subagent's title is its prompt's head
      live: true,
      lastAt: T2,
    });
    expect(store.sessionList()[0]?.title).toBe("p".repeat(80));

    store.addSpoolLine(line({ ts: iso(T3), event: "SubagentStop", agent_id: "w1" }));
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1")?.live).toBe(false);
    store.addSpoolLine(line({ ts: iso(T3), event: "SessionEnd" }));
    expect(store.sessionDetail("s1")?.agents.every((agent) => !agent.live)).toBe(true);
  });

  it("pairs hook tool events by tool_use_id, else by a time-keyed fallback id", () => {
    const store = createStore();
    const seen: ToolCallRecord[] = [];
    store.onUpdate((change) => seen.push(...change.tools));
    store.addSpoolLine(
      line({ ts: iso(T0), event: "PreToolUse", tool_name: "Read", tool_use_id: "tu1", agent_id: "w1" }),
    );
    expect(seen).toEqual([]); // a start alone records nothing
    store.addSpoolLine(
      line({ ts: iso(T2), event: "PostToolUse", tool_name: "Read", tool_use_id: "tu1", agent_id: "w1" }),
    );
    expect(seen).toEqual([
      { id: "tu1", sessionId: "s1", agentId: "w1", name: "Read", startedAt: T0, durationMs: 2_000, ok: true },
    ]);
    store.addSpoolLine(line({ ts: iso(T3), event: "PostToolUseFailure", tool_name: "Bash" }));
    expect(seen[1]).toEqual({
      id: `hook:s1:Bash:${T3}`,
      sessionId: "s1",
      agentId: null,
      name: "Bash",
      startedAt: T3,
      durationMs: null,
      ok: false,
    });
  });
});

describe("addRequest", () => {
  it("merges by id, keeping the first model and upstream, taking new facts only", () => {
    const store = createStore();
    store.addRequest(
      makeRequest({
        id: "r1",
        ts: T0,
        model: "m1",
        upstream: "u1",
        latencyMs: null,
        tokens: ZERO_TOKENS,
        stopReason: null,
      }),
    );
    store.addRequest(
      makeRequest({
        id: "r1",
        ts: T1,
        model: "",
        upstream: "",
        latencyMs: 5,
        tokens: tokens(1, 1, 0, 0),
        stopReason: "end_turn",
      }),
    );
    const list = store.requests({ session: "s1" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "r1",
      ts: T0,
      model: "m1",
      upstream: "u1",
      latencyMs: 5,
      stopReason: "end_turn",
    });
    expect(list[0]?.tokens).toEqual(tokens(1, 1, 0, 0));
    expect(store.sessionDetail("s1")).toMatchObject({ startedAt: T0, model: "m1" });
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "main")?.model).toBe("m1");
  });

  it("filters, sorts newest-first and slices to the limit", () => {
    const store = createStore();
    store.addRequest(makeRequest({ id: "r1", ts: 100, model: "a" }));
    store.addRequest(makeRequest({ id: "r2", ts: 300, model: "b" }));
    store.addRequest(makeRequest({ id: "r3", ts: 200, sessionId: "s2" }));
    store.addRequest(makeRequest({ id: "r4", ts: 50, agentId: "w1" }));
    expect(store.requests({}).map((request) => request.id)).toEqual(["r2", "r3", "r1", "r4"]);
    expect(store.requests({ limit: 2 }).map((request) => request.id)).toEqual(["r2", "r3"]);
    expect(store.requests({ session: "s1" }).map((request) => request.id)).toEqual(["r2", "r1", "r4"]);
    expect(store.requests({ model: "a" }).map((request) => request.id)).toEqual(["r1"]);
    expect(store.requests({ agent: "w1" }).map((request) => request.id)).toEqual(["r4"]);
    expect(store.requests({ since: 150 }).map((request) => request.id)).toEqual(["r2", "r3"]);
    expect(store.requestsFor({ session: "s1" }).map((request) => request.id)).toEqual(["r1", "r2", "r4"]);
  });
});

describe("addToolCall", () => {
  it("merges duration and success as they firm up", () => {
    const store = createStore();
    const seen: ToolCallRecord[] = [];
    store.onUpdate((change) => seen.push(...change.tools));
    store.addToolCall(makeTool({ id: "t1", durationMs: null, ok: false }));
    store.addToolCall(makeTool({ id: "t1", durationMs: 50, ok: false }));
    store.addToolCall(makeTool({ id: "t1", durationMs: 60, ok: true }));
    expect(seen).toHaveLength(3);
    expect(seen[1]).toMatchObject({ durationMs: 50, ok: false });
    expect(seen[2]).toMatchObject({ id: "t1", durationMs: 60, ok: true });
    expect(store.models().tools).toEqual([{ name: "Bash", count: 1, failures: 0 }]);
    expect(store.sessionDetail("s1")).toMatchObject({ toolCount: 1, errorCount: 0 });
  });
});

describe("upserts", () => {
  it("keeps the first session facts, the earliest start, and lets external flip freely", () => {
    const store = createStore();
    store.upsertSession({
      id: "s1",
      cwd: "/a",
      upstream: "u1",
      ccVersion: "1.0",
      startedAt: 100,
      external: false,
    });
    store.upsertSession({
      id: "s1",
      cwd: "/b",
      upstream: "u2",
      ccVersion: "2.0",
      startedAt: 50,
      external: true,
    });
    expect(store.sessionDetail("s1")).toMatchObject({
      cwd: "/a",
      upstream: "u1",
      ccVersion: "1.0",
      startedAt: 50,
      external: true,
    });
  });

  it("ends a session and every agent in it", () => {
    const store = createStore();
    store.upsertSession({ id: "s1" });
    store.upsertAgent({ sessionId: "s1", id: "w1" });
    store.endSession("s1", 900);
    const detail = store.sessionDetail("s1");
    expect(detail).toMatchObject({ live: false, endedAt: 900 });
    expect(detail?.agents.every((agent) => !agent.live)).toBe(true);
  });

  it("upserts external agents with their own shape and retires them on end", () => {
    const store = createStore();
    store.upsertAgent({
      sessionId: "s1",
      id: "w1",
      parentId: null,
      kind: "external",
      name: "zai job",
      model: "zai:glm-5.3",
      title: "Fix tests",
    });
    store.upsertAgent({ sessionId: "s1", id: "w1", model: "zai:other" }); // model seeds once
    const w1 = store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1");
    expect(w1).toMatchObject({
      id: "w1",
      parentId: null,
      kind: "external",
      name: "Fix tests",
      model: "zai:glm-5.3",
      live: true,
    });
    store.endAgent("s1", "w1", 500);
    expect(store.sessionDetail("s1")?.agents.find((agent) => agent.id === "w1")?.live).toBe(false);
  });
});

describe("views", () => {
  it("models() reuses the aggregations over everything stored", () => {
    const store = createStore();
    store.addRequest(
      makeRequest({ model: "glm-5.3", upstream: "http://127.0.0.1:8787", tokens: tokens(10, 0, 0, 0) }),
    );
    store.addToolCall(makeTool({ ok: false }));
    const out = store.models();
    expect(out.models).toEqual([
      {
        model: "glm-5.3",
        provider: "Z.ai",
        requests: 1,
        errors: 0,
        tokens: tokens(10, 0, 0, 0),
        latencyP50: 100,
        costUsd: 0.000014,
      },
    ]);
    expect(out.upstreams[0]).toMatchObject({
      upstream: "http://127.0.0.1:8787",
      host: "127.0.0.1:8787",
      requests: 1,
    });
    expect(out.tools).toEqual([{ name: "Bash", count: 1, failures: 1 }]);
  });

  it("summary() counts live sessions and totals across the board", () => {
    const store = createStore();
    expect(store.summary()).toMatchObject({ sessions: 0, liveSessions: 0, requests: 0, tokens: ZERO_TOKENS });
    store.addRequest(makeRequest({ tokens: tokens(1, 2, 3, 4) }));
    store.upsertSession({ id: "s2", startedAt: 5 });
    expect(store.summary()).toMatchObject({
      sessions: 2,
      liveSessions: 2,
      requests: 1,
      tokens: tokens(1, 2, 3, 4),
    });
  });
});

describe("bounds", () => {
  it("keeps at most MAX_SESSIONS sessions, dropping the stalest", () => {
    const store = createStore();
    for (let i = 0; i <= MAX_SESSIONS + 4; i += 1) {
      store.addSpoolLine(line({ ts: iso(T0 + i), session_id: `s${i}` }));
    }
    const list = store.sessionList();
    expect(list).toHaveLength(MAX_SESSIONS);
    expect(list.some((item) => item.id === "s0")).toBe(false);
    expect(list.some((item) => item.id === `s${MAX_SESSIONS + 4}`)).toBe(true);
  });

  /** Names the boundary records so eviction can be asserted by label. */
  function promptAt(i: number, last: number): string {
    if (i === 0) return "first";
    if (i === 1) return "second";
    return i === last ? "last" : "mid";
  }

  it("keeps at most MAX_RECORDS records, shedding the oldest events first", () => {
    const store = createStore();
    const total = MAX_RECORDS + 2;
    for (let i = 0; i < total; i += 1) {
      const prompt = promptAt(i, total - 1);
      store.addSpoolLine({ ts: iso(T0 + i), event: "UserPromptSubmit", session_id: "bulk", prompt });
    }
    const events = store.events({ limit: 1_000_000 });
    expect(events).toHaveLength(MAX_RECORDS);
    expect(events[0]?.label).toBe("last");
    expect(events.some((event) => event.label === "first" || event.label === "second")).toBe(false);
  });
});

describe("notifications", () => {
  it("delivers deltas to listeners until they unsubscribe, versioning every change", () => {
    const store = createStore();
    const seen: Change[] = [];
    const off = store.onUpdate((change) => seen.push(change));
    const before = store.version();
    store.addSpoolLine(line({}));
    store.addRequest(makeRequest({ ts: T2 }));
    off();
    store.addToolCall(makeTool({}));
    expect(seen).toHaveLength(2);
    expect(seen[0]?.sessions).toBe(true);
    expect(seen[0]?.events).toHaveLength(1);
    expect(seen[0]?.events[0]?.kind).toBe("UserPromptSubmit");
    expect(seen[1]?.requests).toHaveLength(1);
    expect(store.version()).toBe(before + 3);
  });
});
