import { describe, expect, it } from "vitest";
import type { EventRecord, Summary } from "../src/shared/model.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import type { SessionListItem } from "../src/store/store.ts";
import {
  applyBackfill,
  applyDetail,
  applyMessage,
  type ClientState,
  dedupeNewest,
  dedupeTools,
  detailTargets,
  drawerRequest,
  initialClientState,
  type ModelsData,
  modelsInView,
  nextSort,
  type StreamMessage,
  selectedSession,
  tableRequests,
  tableTools,
  visibleEvents,
  visibleRequests,
  visibleTools,
} from "../src/ui/state.ts";
import { makeRequest, makeSessionView, makeTool } from "./helpers.ts";

const SUMMARY: Summary = {
  sessions: 1,
  liveSessions: 1,
  agents: 1,
  requests: 0,
  tokens: { ...ZERO_TOKENS },
  errors: 0,
  toolCalls: 0,
  latencyP50: null,
  latencyP95: null,
  startedAt: null,
  now: 0,
};

const MODELS: ModelsData = { models: [], upstreams: [], tools: [] };

function item(id: string, lastAt: number): SessionListItem {
  return {
    id,
    project: null,
    cwd: null,
    startedAt: null,
    endedAt: null,
    live: false,
    model: null,
    agentCount: 0,
    requestCount: 0,
    tokens: 0,
    lastAt,
    external: false,
    title: null,
  };
}

function makeEvent(seq: number, ts: number, sessionId: string | null = "s1"): EventRecord {
  return { seq, ts, kind: "Stop", sessionId, agentId: null, label: `e${seq}`, payload: null };
}

describe("initialClientState", () => {
  it("starts disconnected on the agents tab over the last hour", () => {
    const state = initialClientState();
    expect(state.connected).toBe(false);
    expect(state.tab).toBe("agents");
    expect(state.range).toBe("1h");
    expect(state.session).toBeNull();
    expect(state.request).toBeNull();
    expect(state.summary).toBeNull();
    expect(state.models).toBeNull();
    expect(state.requests).toEqual([]);
    expect(state.collapsed.size).toBe(0);
    expect(state.error).toBeNull();
    expect(state.updatedAt).toBeNull();
    expect(state.model).toBeNull();
    expect(state.toolFilter).toBe("all");
    expect(state.theme).toBe("system");
    expect(state.timeMode).toBe("relative");
    expect(state.requestSort).toEqual({ key: "time", dir: "desc" });
    expect(state.toolSort).toEqual({ key: "time", dir: "desc" });
  });
});

describe("applyMessage", () => {
  it("folds a snapshot in, clearing the error, and never mutates the input state", () => {
    const before = { ...initialClientState(), error: "lost the stream" };
    const message: StreamMessage = {
      type: "snapshot",
      summary: SUMMARY,
      sessions: [item("s1", 5)],
      models: MODELS,
    };
    const after = applyMessage(before, message);
    expect(after.error).toBeNull();
    expect(after.summary).toEqual(SUMMARY);
    expect(after.sessions).toEqual([item("s1", 5)]);
    expect(after.models).toEqual(MODELS);
    expect(after.updatedAt).toBeGreaterThanOrEqual(0);
    expect(before.error).toBe("lost the stream"); // the input state is untouched
    expect(before.sessions).toEqual([]);
  });

  it("folds session refreshes without clearing the error", () => {
    const before = { ...initialClientState(), error: "reconnecting" };
    const after = applyMessage(before, {
      type: "sessions",
      summary: SUMMARY,
      sessions: [],
      models: MODELS,
    });
    expect(after.error).toBe("reconnecting");
    expect(after.summary).toEqual(SUMMARY);
  });

  it("appends streamed records and caps the request buffer at 2000, oldest evicted", () => {
    let state = initialClientState();
    for (let i = 1; i <= 2_003; i += 1) {
      state = applyMessage(state, { type: "request", request: makeRequest({ id: `r${i}`, ts: i }) });
    }
    expect(state.requests).toHaveLength(2_000);
    expect(state.requests[0]?.id).toBe("r4");
    expect(state.requests[2_000 - 1]?.id).toBe("r2003");

    state = applyMessage(state, { type: "tool", tool: makeTool({ id: "t1", startedAt: 9 }) });
    expect(state.tools.map((tool) => tool.id)).toEqual(["t1"]);
    state = applyMessage(state, { type: "tool", tool: makeTool({ id: "t0", startedAt: 8 }) });
    state = applyMessage(state, { type: "tool", tool: makeTool({ id: "t1", startedAt: 9, ok: false }) });
    expect(state.tools.map((tool) => `${tool.id}:${tool.ok}`)).toEqual(["t0:true", "t1:false"]); // replaced
    state = applyMessage(state, { type: "event", event: makeEvent(1, 9) });
    expect(state.events.map((event) => event.seq)).toEqual([1]);
  });
});

describe("details", () => {
  it("stores and replaces session details by id", () => {
    let state = initialClientState();
    const first = makeSessionView({ id: "s1" });
    state = applyDetail(state, first);
    state = applyDetail(state, makeSessionView({ id: "s2" }));
    expect(state.details.s1).toEqual(first);
    state = applyDetail(state, makeSessionView({ id: "s1", requestCount: 7 }));
    expect(state.details.s1?.requestCount).toBe(7);
    expect(Object.keys(state.details)).toEqual(["s1", "s2"]);
  });

  it("targets the selected session only, else the six most recent", () => {
    const sessions = Array.from({ length: 8 }, (_, i) => item(`s${i + 1}`, i + 1));
    const picked = { ...initialClientState(), session: "s3", sessions };
    expect(detailTargets(picked).map((entry) => entry.id)).toEqual(["s3"]);

    const missing = { ...picked, session: "nope" };
    expect(detailTargets(missing)).toEqual([]);

    const all = { ...initialClientState(), sessions };
    expect(detailTargets(all).map((entry) => entry.id)).toEqual(["s8", "s7", "s6", "s5", "s4", "s3"]);
  });
});

describe("applyBackfill", () => {
  it("replaces each page when given and keeps it when omitted", () => {
    const seeded = {
      ...initialClientState(),
      requests: [makeRequest({ id: "old" })],
      tools: [makeTool({ id: "old" })],
      events: [makeEvent(1, 1)],
    };
    const backfilled = applyBackfill(seeded, {
      requests: [makeRequest({ id: "new" })],
      events: [makeEvent(2, 2)],
    });
    expect(backfilled.requests.map((request) => request.id)).toEqual(["new"]);
    expect(backfilled.events.map((event) => event.seq)).toEqual([2]);
    expect(backfilled.tools.map((tool) => tool.id)).toEqual(["old"]); // not supplied
  });

  it("keeps only the newest slice of a huge page", () => {
    const big = Array.from({ length: 2_050 }, (_, i) => makeRequest({ id: `b${i}`, ts: i }));
    const state = applyBackfill(initialClientState(), { requests: big });
    expect(state.requests).toHaveLength(2_000);
    expect(state.requests[0]?.id).toBe("b50");
  });
});

describe("dedupeNewest", () => {
  it("lets the last record with an id win and sorts oldest-first", () => {
    const merged = dedupeNewest([
      makeRequest({ id: "x", ts: 1 }),
      makeRequest({ id: "y", ts: 5 }),
      makeRequest({ id: "x", ts: 9, model: "glm-5.3" }),
    ]);
    expect(merged.map((request) => request.id)).toEqual(["y", "x"]);
    expect(merged[1]?.model).toBe("glm-5.3");
  });
});

describe("views", () => {
  function populated(): ReturnType<typeof initialClientState> {
    let state = initialClientState();
    state = applyBackfill(state, {
      requests: [
        makeRequest({ id: "a", ts: 5, sessionId: "s1" }),
        makeRequest({ id: "b", ts: 1, sessionId: "s1" }),
        makeRequest({ id: "c", ts: 9, sessionId: "s2" }),
      ],
      tools: [
        makeTool({ id: "t1", startedAt: 5, sessionId: "s1" }),
        makeTool({ id: "t2", startedAt: 7, sessionId: "s2" }),
      ],
      events: [makeEvent(1, 5, "s1"), makeEvent(2, 7, "s2")],
    });
    return state;
  }

  it("shows every record newest-first, or just the picked session's", () => {
    const state = populated();
    expect(visibleRequests(state).map((request) => request.id)).toEqual(["c", "a", "b"]);
    expect(visibleRequests({ ...state, session: "s1" }).map((request) => request.id)).toEqual(["a", "b"]);
    expect(visibleTools({ ...state, session: "s2" }).map((tool) => tool.id)).toEqual(["t2"]);
    expect(visibleEvents({ ...state, session: "s1" }).map((event) => event.seq)).toEqual([1]);
  });

  it("narrows the requests table by model and lists the view's models by volume", () => {
    let state = populated();
    state = applyBackfill(state, {
      requests: [
        ...state.requests,
        makeRequest({ id: "g1", ts: 3, model: "glm-5.3" }),
        makeRequest({ id: "g2", ts: 4, model: "glm-5.3" }),
        makeRequest({ id: "k1", ts: 2, model: "kimi-k3" }),
      ],
    });
    expect(modelsInView(state)).toEqual([
      { model: "claude-sonnet-5-5", count: 3 },
      { model: "glm-5.3", count: 2 },
      { model: "kimi-k3", count: 1 },
    ]);
    expect(tableRequests(state)).toHaveLength(6);
    expect(tableRequests({ ...state, model: "glm-5.3" }).map((r) => r.id)).toEqual(["g2", "g1"]);
    expect(modelsInView({ ...state, session: "s2" })).toEqual([{ model: "claude-sonnet-5-5", count: 1 }]);
    const tie = applyBackfill(initialClientState(), {
      requests: [makeRequest({ id: "z", model: "b-model" }), makeRequest({ id: "y", model: "a-model" })],
    });
    expect(modelsInView(tie).map((m) => m.model)).toEqual(["a-model", "b-model"]);
  });

  it("filters the tools table to failures on request, and dedupes backfilled calls", () => {
    const state = applyBackfill(initialClientState(), {
      tools: [
        makeTool({ id: "t1", startedAt: 5, ok: true }),
        makeTool({ id: "t2", startedAt: 7, ok: false }),
        makeTool({ id: "t1", startedAt: 6, ok: false }),
      ],
    });
    expect(tableTools(state).map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(tableTools({ ...state, toolFilter: "failed" }).map((t) => t.id)).toEqual(["t2", "t1"]);
    const mixed = { ...state, tools: [makeTool({ id: "a", ok: true }), makeTool({ id: "b", ok: false })] };
    expect(tableTools({ ...mixed, toolFilter: "failed" }).map((t) => t.id)).toEqual(["b"]);
    expect(
      dedupeTools([makeTool({ id: "x", startedAt: 9 }), makeTool({ id: "w", startedAt: 1 })]).map(
        (t) => t.id,
      ),
    ).toEqual(["w", "x"]);
  });

  it("flips a column's direction, and starts text columns A to Z and the rest newest/biggest first", () => {
    expect(nextSort({ key: "time", dir: "desc" }, "time")).toEqual({ key: "time", dir: "asc" });
    expect(nextSort({ key: "time", dir: "asc" }, "time")).toEqual({ key: "time", dir: "desc" });
    expect(nextSort({ key: "time", dir: "desc" }, "model")).toEqual({ key: "model", dir: "asc" });
    expect(nextSort({ key: "model", dir: "asc" }, "latency")).toEqual({ key: "latency", dir: "desc" });
  });

  it("sorts the requests table by any column, missing values last, ties in view order", () => {
    const state = applyBackfill(initialClientState(), {
      requests: [
        makeRequest({ id: "a", ts: 1, latencyMs: 300, model: "b-model", stopReason: null }),
        makeRequest({ id: "b", ts: 2, latencyMs: null, model: "a-model", stopReason: "end_turn" }),
        makeRequest({ id: "c", ts: 3, latencyMs: 100, model: "b-model", stopReason: null }),
      ],
    });
    const ids = (sort: ClientState["requestSort"]): string[] =>
      tableRequests({ ...state, requestSort: sort }).map((r) => r.id);
    expect(ids({ key: "time", dir: "desc" })).toEqual(["c", "b", "a"]);
    expect(ids({ key: "time", dir: "asc" })).toEqual(["a", "b", "c"]);
    expect(ids({ key: "latency", dir: "desc" })).toEqual(["a", "c", "b"]);
    expect(ids({ key: "latency", dir: "asc" })).toEqual(["c", "a", "b"]);
    expect(ids({ key: "model", dir: "asc" })).toEqual(["b", "c", "a"]);
    expect(ids({ key: "stop", dir: "asc" })).toEqual(["b", "c", "a"]);
    for (const key of ["agent", "upstream", "input", "output", "cacheRead", "cacheWrite"] as const) {
      expect(ids({ key, dir: "asc" })).toEqual(["c", "b", "a"]); // all equal: view order (newest first) stands
    }
  });

  it("sorts the tools table by any column", () => {
    const state = {
      ...applyBackfill(initialClientState(), {
        tools: [
          makeTool({
            id: "x",
            startedAt: 1,
            name: "Read",
            sessionId: "s2",
            agentId: null,
            durationMs: 30,
            ok: true,
          }),
          makeTool({
            id: "y",
            startedAt: 2,
            name: "Bash",
            sessionId: "s1",
            agentId: "sub",
            durationMs: null,
            ok: false,
          }),
        ],
      }),
      sessions: [{ ...item("s1", 1), project: "zeta" }],
    };
    const ids = (sort: ClientState["toolSort"]): string[] =>
      tableTools({ ...state, toolSort: sort }).map((t) => t.id);
    expect(ids({ key: "time", dir: "desc" })).toEqual(["y", "x"]);
    expect(ids({ key: "tool", dir: "asc" })).toEqual(["y", "x"]);
    expect(ids({ key: "session", dir: "asc" })).toEqual(["x", "y"]); // "s2" sorts before the project "zeta"
    expect(ids({ key: "agent", dir: "asc" })).toEqual(["x", "y"]); // "main" < "sub"
    expect(ids({ key: "duration", dir: "asc" })).toEqual(["x", "y"]); // null last
    expect(ids({ key: "result", dir: "asc" })).toEqual(["y", "x"]); // failed < succeeded
  });

  it("resolves the selected session and the drawer request, null when absent", () => {
    const state = { ...populated(), sessions: [item("s1", 5)], session: "s1", request: "a" };
    expect(selectedSession(state)?.id).toBe("s1");
    expect(drawerRequest(state)?.model).toBe("claude-sonnet-5-5");
    expect(selectedSession({ ...state, session: "nope" })).toBeNull();
    expect(drawerRequest({ ...state, request: "nope" })).toBeNull();
    expect(drawerRequest({ ...state, request: null })).toBeNull();
  });
});
