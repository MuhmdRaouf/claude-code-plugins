import { describe, expect, it } from "vitest";
import type { Budget } from "../src/budget/budgets.ts";
import type { TreeNodeRow } from "../src/history/history.ts";
import type { EventRecord, Summary } from "../src/shared/model.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import { DEFAULT_RANGE } from "../src/shared/time-range.ts";
import type { SessionListItem } from "../src/store/store.ts";
import {
  agentDisplayName,
  applyBackfill,
  applyContext,
  applyDetail,
  applyMessage,
  budgetFromDraft,
  type ClientState,
  clearSelected,
  detailTargets,
  draftOf,
  drawerRequest,
  flowSource,
  initialClientState,
  modelChoices,
  newDraft,
  nextSort,
  pickedSessions,
  rangeEqual,
  requestCost,
  type StreamMessage,
  selectedIds,
  selectedSession,
  stepRequest,
  TABS,
  tableRequests,
  tableTools,
  toggleSelected,
  visibleEvents,
  visibleRequests,
  visibleTools,
  withBudget,
  withSelection,
} from "../src/ui/state.ts";
import { makeAgentView, makeRequest, makeSessionView, makeTool } from "./helpers.ts";

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

const MODELS: ClientState["models"] = { models: [], upstreams: [], tools: [] };

function item(id: string, lastAt: number): SessionListItem {
  return {
    id,
    project: null,
    cwd: null,
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: false,
    status: null,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: null,
    agentCount: 0,
    liveAgentCount: 0,
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
  it("starts disconnected on the overview tab over the last hour, refreshing every 5 s", () => {
    const state = initialClientState();
    expect(state.connected).toBe(false);
    expect(state.tab).toBe("overview");
    expect(state.range).toEqual({ preset: "1h", from: 0, to: null });
    expect(state.refresh).toBe(5000);
    expect(state.flow).toBeNull();
    expect(state.flowLoading).toBe(false);
    expect(state.flowError).toBeNull();
    expect(state.session).toBeNull();
    expect(state.selected).toEqual([]);
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

describe("session selection", () => {
  function seeded(): ClientState {
    return applyBackfill(initialClientState(), {
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
  }

  it("starts with nothing picked: every session in scope, no single session", () => {
    const state = initialClientState();
    expect(state.selected).toEqual([]);
    expect(state.session).toBeNull();
    expect(selectedIds(state)).toEqual([]);
  });

  it("toggles a session in and out of the picked set, pick order kept, agent and model reset", () => {
    let state: ClientState = { ...initialClientState(), agent: "a1", model: "m1" };
    state = toggleSelected(state, "s1");
    expect(state.selected).toEqual(["s1"]);
    expect(state.session).toBe("s1"); // the derived single view keeps the session-only pages working
    expect(state.agent).toBeNull();
    expect(state.model).toBeNull();
    state = toggleSelected(state, "s2");
    expect(state.selected).toEqual(["s1", "s2"]);
    expect(state.session).toBeNull(); // two picks is no single session any more
    state = toggleSelected(state, "s1"); // a second click on the card picks it back out
    expect(state.selected).toEqual(["s2"]);
    expect(state.session).toBe("s2");
  });

  it("dedupes a repeated pick and drops empty ids", () => {
    expect(withSelection(initialClientState(), ["s1", "s1", ""]).selected).toEqual(["s1"]);
  });

  it("clears the set back to every session", () => {
    const picked = toggleSelected(toggleSelected(initialClientState(), "s1"), "s2");
    const cleared = clearSelected({ ...picked, agent: "a1", model: "m1" });
    expect(cleared.selected).toEqual([]);
    expect(cleared.session).toBeNull();
    expect(cleared.agent).toBeNull();
    expect(cleared.model).toBeNull();
  });

  it("reads a hand-built single field as a one-pick set, so direct tests keep working", () => {
    expect(selectedIds({ ...initialClientState(), session: "s9" })).toEqual(["s9"]);
    expect(selectedIds({ ...initialClientState(), selected: ["s1", "s2"], session: null })).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("narrows every view by the set: picked sessions keep their rows, others drop out", () => {
    const state = seeded();
    const both = toggleSelected(toggleSelected(state, "s2"), "s1");
    expect(both.selected).toEqual(["s2", "s1"]);
    expect(visibleRequests(both).map((request) => request.id)).toEqual(["c", "a", "b"]);
    expect(visibleTools(both).map((tool) => tool.id)).toEqual(["t2", "t1"]);
    expect(visibleEvents(both).map((event) => event.seq)).toEqual([2, 1]);
    const onlyS2 = toggleSelected(state, "s2");
    expect(visibleRequests(onlyS2).map((request) => request.id)).toEqual(["c"]);
    expect(visibleTools(onlyS2).map((tool) => tool.id)).toEqual(["t2"]);
    expect(visibleEvents(onlyS2).map((event) => event.seq)).toEqual([2]);
    // the model filter narrows within the picked set
    expect(tableRequests({ ...onlyS2, model: "glm-5.3" }).map((r) => r.id)).toEqual(
      visibleRequests(onlyS2)
        .filter((r) => r.model === "glm-5.3")
        .map((r) => r.id),
    );
  });

  it("targets every picked session's detail and lists them in pick order", () => {
    const sessions = [item("s1", 5), item("s2", 9), item("s3", 1)];
    const state = toggleSelected(toggleSelected({ ...initialClientState(), sessions }, "s2"), "s1");
    expect(detailTargets(state).map((entry) => entry.id)).toEqual(["s2", "s1"]);
    expect(pickedSessions(state).map((entry) => entry.id)).toEqual(["s2", "s1"]);
    // a picked id the list has not seen targets nothing
    expect(detailTargets(toggleSelected({ ...initialClientState(), sessions }, "ghost"))).toEqual([]);
    // a single pick still targets just that session
    expect(
      detailTargets(toggleSelected({ ...initialClientState(), sessions }, "s3")).map((e) => e.id),
    ).toEqual(["s3"]);
  });

  it("keeps selectedSession as the one picked session, null with none or several", () => {
    const sessions = [item("s1", 5), item("s2", 9)];
    const one = toggleSelected({ ...initialClientState(), sessions }, "s1");
    expect(selectedSession(one)?.id).toBe("s1");
    const two = toggleSelected(one, "s2");
    expect(selectedSession(two)).toBeNull();
    expect(selectedSession(clearSelected(two))).toBeNull();
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
      catchingUp: false,
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

  it("carries the server's backlog word: a snapshot sets it, an ingest message flips it", () => {
    const before = { ...initialClientState(), error: "reconnecting" };
    const snapshot = applyMessage(before, {
      type: "snapshot",
      summary: SUMMARY,
      sessions: [item("s1", 5)],
      models: MODELS,
      catchingUp: true,
    });
    expect(snapshot.catchingUp).toBe(true);
    const done = applyMessage(snapshot, { type: "ingest", catchingUp: false });
    expect(done.catchingUp).toBe(false);
    // the word is not a data update: the "updated ..." clock keeps running from the last data
    expect(done.updatedAt).toBe(snapshot.updatedAt);
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

  it("lets the last record with an id win and sorts the page oldest-first", () => {
    const merged = applyBackfill(initialClientState(), {
      requests: [
        makeRequest({ id: "x", ts: 1 }),
        makeRequest({ id: "y", ts: 5 }),
        makeRequest({ id: "x", ts: 9, model: "glm-5.3" }),
      ],
    });
    expect(merged.requests.map((request) => request.id)).toEqual(["y", "x"]);
    expect(merged.requests[1]?.model).toBe("glm-5.3");
  });
});

describe("TABS", () => {
  it("lists the tabs in order, each with an icon", () => {
    expect(TABS.map((tab) => [tab.id, tab.label, tab.icon])).toEqual([
      ["overview", "Overview", "gauge"],
      ["agents", "Agents", "bot"],
      ["requests", "Requests", "arrows"],
      ["tools", "Tools", "wrench"],
      ["timeline", "Timeline", "clock"],
      ["models", "Models", "cpu"],
      ["costs", "Costs", "coins"],
      ["alerts", "Alerts", "bell"],
      ["router", "Router", "route"],
      ["settings", "Settings", "settings"],
    ]);
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

  it("narrows the view further to the picked agent on a session page", () => {
    const state = populated();
    const scoped = { ...state, session: "s1", agent: "main" };
    expect(visibleRequests(scoped).map((request) => request.id)).toEqual(["a", "b"]);
    expect(visibleTools(scoped).map((tool) => tool.id)).toEqual(["t1"]);
    expect(visibleEvents(scoped).map((event) => event.seq)).toEqual([1]);
    // an agent with nothing in view shows nothing, and clearing the agent widens back
    expect(visibleRequests({ ...scoped, agent: "other" })).toEqual([]);
    expect(visibleRequests({ ...scoped, agent: null }).map((request) => request.id)).toEqual(["a", "b"]);
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
    expect(modelChoices(state)).toEqual([
      { model: "claude-sonnet-5-5", count: 3 },
      { model: "glm-5.3", count: 2 },
      { model: "kimi-k3", count: 1 },
    ]);
    expect(tableRequests(state)).toHaveLength(6);
    expect(tableRequests({ ...state, model: "glm-5.3" }).map((r) => r.id)).toEqual(["g2", "g1"]);
    expect(modelChoices({ ...state, session: "s2" })).toEqual([{ model: "claude-sonnet-5-5", count: 1 }]);
    const tie = applyBackfill(initialClientState(), {
      requests: [makeRequest({ id: "z", model: "b-model" }), makeRequest({ id: "y", model: "a-model" })],
    });
    expect(modelChoices(tie).map((m) => m.model)).toEqual(["a-model", "b-model"]);
  });

  it("offers the busiest Claude models and every provider model as filter chips, never <synthetic>", () => {
    const requests = [
      ...["a", "b", "c", "d", "e"].flatMap((name, index) =>
        Array.from({ length: 10 - index }, (_, n) =>
          makeRequest({ id: `${name}${n}`, model: `claude-${name}` }),
        ),
      ),
      makeRequest({ id: "g", model: "glm-5.3" }),
      makeRequest({ id: "s1", model: "<synthetic>" }),
      makeRequest({ id: "s2", model: "<synthetic>" }),
    ];
    const state = applyBackfill(initialClientState(), { requests });
    expect(modelChoices(state).map((choice) => choice.model)).toEqual([
      "claude-a",
      "claude-b",
      "claude-c",
      "claude-d",
      "glm-5.3",
    ]);
  });

  it("replaces a streamed request that arrives again under the same id", () => {
    let state = initialClientState();
    state = applyMessage(state, { type: "request", request: makeRequest({ id: "r", upstream: "" }) });
    state = applyMessage(state, {
      type: "request",
      request: makeRequest({ id: "r", upstream: "api.anthropic.com" }),
    });
    expect(state.requests).toEqual([expect.objectContaining({ id: "r", upstream: "api.anthropic.com" })]);
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
    const deduped = applyBackfill(initialClientState(), {
      tools: [makeTool({ id: "x", startedAt: 9 }), makeTool({ id: "w", startedAt: 1 })],
    });
    expect(deduped.tools.map((t) => t.id)).toEqual(["w", "x"]);
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

  it("resolves a history scope's row from the fetched page the live list never held", () => {
    const historic = {
      ...populated(),
      historyScope: { rootId: "s1/main", nodeId: null },
      historyRequests: [makeRequest({ id: "h1", sessionId: "s1" }), makeRequest({ id: "h2" })],
      request: "h2",
    };
    expect(drawerRequest(historic)?.id).toBe("h2");
    expect(drawerRequest({ ...historic, request: "gone" })).toBeNull();
  });

  it("steps through the requests in scope, null at either end and without the open row", () => {
    const state = { ...populated(), request: "a" };
    // the view's newest-first order is c, a, b: next from a is b, prev is c; the session filter narrows it
    expect(stepRequest(state, 1)).toBe("b");
    expect(stepRequest(state, -1)).toBe("c");
    expect(stepRequest({ ...state, request: "c" }, -1)).toBeNull();
    expect(stepRequest({ ...state, request: "b" }, 1)).toBeNull();
    expect(stepRequest({ ...state, request: "nope" }, 1)).toBeNull();
    expect(stepRequest({ ...state, request: null }, 1)).toBeNull();
    const scoped = { ...state, session: "s1" };
    expect(stepRequest(scoped, 1)).toBe("b");
    expect(stepRequest(scoped, -1)).toBeNull(); // a is the newest of s1's two requests
    // a history scope reads the fetched history page instead of the live table
    const historic = {
      ...state,
      historyScope: { rootId: "s1/main", nodeId: null },
      historyRequests: [makeRequest({ id: "h1", sessionId: "s1" }), makeRequest({ id: "h2" })],
      request: "h1",
    };
    expect(stepRequest(historic, 1)).toBe("h2");
    expect(stepRequest(historic, -1)).toBeNull();
    expect(stepRequest({ ...historic, historyRequests: null }, 1)).toBeNull();
  });

  it("stores a rebuilt conversation per request, replacing the one it had", () => {
    let state = applyContext(initialClientState(), "a", { status: "loading" });
    expect(state.context.a).toEqual({ status: "loading" });
    state = applyContext(state, "a", {
      status: "ready",
      messages: [],
      totals: { messages: 0, approxTokens: 0, usage: null, cacheTokens: 0 },
      note: null,
      next: null,
      loadingOlder: false,
    });
    state = applyContext(state, "b", { status: "missing" });
    expect(state.context.a?.status).toBe("ready");
    expect(state.context.b).toEqual({ status: "missing" });
  });
});

describe("requestCost", () => {
  it("prices a request off its upstream, null for a model nothing prices", () => {
    expect(
      requestCost(
        makeRequest({
          model: "glm-5.3",
          upstream: "https://api.z.ai",
          tokens: { ...ZERO_TOKENS, input: 1e6 },
          stopReason: "end_turn",
        }),
      )?.usd,
    ).toBeCloseTo(1.4);
    expect(requestCost(makeRequest({ model: "glm-5.3" }))).toBeNull();
    expect(requestCost(makeRequest({ model: "not-a-model" }))).toBeNull();
  });

  it("never prices a request in flight: no stop reason and no output yet", () => {
    expect(
      requestCost(makeRequest({ model: "glm-5.3", upstream: "https://api.z.ai", tokens: ZERO_TOKENS })),
    ).toBeNull();
  });
});

describe("agent names", () => {
  /** A history tree node of one subagent, overridable per test. */
  const treeNode = (overrides: Partial<TreeNodeRow> = {}): TreeNodeRow => ({
    id: "s1/w1",
    kind: "subagent",
    parentId: "s1/main",
    sessionId: "s1",
    agentId: "w1",
    label: null,
    agentType: "Explore",
    description: null,
    project: null,
    cwd: null,
    model: null,
    provider: null,
    toolUseId: null,
    spawnDepth: 1,
    jobState: null,
    repo: null,
    branch: null,
    name: "Explore — find the flaky test",
    parentSessionId: null,
    startedAt: 1,
    endedAt: null,
    lastAt: 9,
    live: false,
    requests: 3,
    tokens: { ...ZERO_TOKENS },
    ...overrides,
  });

  it("names an agent after its session's own agents, live or in the scoped history tree", () => {
    const base = initialClientState();
    expect(agentDisplayName(base, "s1", "main")).toBe("Main");
    expect(agentDisplayName(base, "s1", "")).toBe("Main");
    const live = applyDetail(base, makeSessionView({ agents: [makeAgentView({ id: "w1", name: "scout" })] }));
    expect(agentDisplayName(live, "s1", "w1")).toBe("scout");
    expect(agentDisplayName(live, "s1", "ghost")).toBe("ghost"); // no detail held: the raw id stands in
    const history = {
      ...base,
      historyScope: { rootId: "s1", nodeId: null },
      historyTrees: { s1: [treeNode()] },
    };
    expect(agentDisplayName(history, "s1", "w1")).toBe("Explore — find the flaky test");
    expect(agentDisplayName(history, "s1", "ghost")).toBe("ghost");
  });
});

describe("budget drafts", () => {
  const budget: Budget = { id: "b", scope: "total", period: "week", limitUsd: 3, action: "stop" };

  it("start from the first provider and turn into budgets, or say what to fix", () => {
    expect(newDraft([])).toEqual({ id: null, scope: "total", period: "month", limit: "10", action: "warn" });
    expect(newDraft(["kimi"]).scope).toBe("provider:kimi");
    expect(budgetFromDraft({ ...newDraft([]), limit: "$7.555" }, "new")).toEqual({
      id: "new",
      scope: "total",
      period: "month",
      limitUsd: 7.56,
      action: "warn",
    });
    expect(budgetFromDraft({ ...newDraft([]), limit: "abc" }, "n")).toMatch(/above \$0/);
    expect(budgetFromDraft({ ...newDraft([]), limit: "0" }, "n")).toMatch(/above \$0/);
    expect(budgetFromDraft({ ...newDraft([]), limit: "2000000" }, "n")).toMatch(/too large/);
    expect(draftOf(budget)).toEqual({ id: "b", scope: "total", period: "week", limit: "3", action: "stop" });
    expect(budgetFromDraft(draftOf(budget), "ignored")).toEqual(budget);
    expect(withBudget([], budget)).toEqual([budget]);
    expect(withBudget([budget], { ...budget, limitUsd: 4 })).toEqual([{ ...budget, limitUsd: 4 }]);
    expect(withBudget([budget], { ...budget, id: "c" })).toHaveLength(2);
  });
});

describe("rangeEqual", () => {
  const NOW = 1_800_000_000_000;

  it("reads two ranges as the same when preset, or both custom ends, match", () => {
    expect(rangeEqual(DEFAULT_RANGE, { preset: "1h", from: 0, to: null })).toBe(true);
    expect(rangeEqual(DEFAULT_RANGE, { preset: "24h", from: 0, to: null })).toBe(false);
    expect(rangeEqual({ preset: null, from: 5, to: null }, { preset: null, from: 5, to: null })).toBe(true);
    expect(rangeEqual({ preset: null, from: 5, to: null }, { preset: null, from: 5, to: NOW })).toBe(false);
    expect(rangeEqual({ preset: "1h", from: 0, to: null }, { preset: null, from: 5, to: null })).toBe(false);
  });
});

describe("flowSource", () => {
  const NOW = 1_800_000_000_000;
  const stateOver = (range: ClientState["range"], requests: number[]): ClientState => ({
    ...initialClientState(),
    range,
    requests: requests.map((ts) => makeRequest({ ts })),
  });
  const preset = (key: ClientState["range"]["preset"]): ClientState["range"] =>
    key === null ? { preset: null, from: 0, to: null } : { preset: key, from: 0, to: null };

  it("answers a short open-ended span from memory", () => {
    const state = stateOver(preset("1h"), [NOW - 3_600_000, NOW - 600_000]);
    expect(flowSource(state, NOW)).toEqual({ from: NOW - 3_600_000, to: NOW, history: false });
  });

  it("sends a span longer than a day, or one with a fixed end, to history", () => {
    expect(flowSource(stateOver(preset("7d"), []), NOW).history).toBe(true);
    expect(flowSource(stateOver({ preset: null, from: NOW - 600_000, to: NOW - 1 }, []), NOW).history).toBe(
      true,
    );
  });

  it("sends a start older than the oldest request in memory to history", () => {
    const state = stateOver(preset("1h"), [NOW - 600_000]);
    expect(flowSource(state, NOW)).toEqual({ from: NOW - 3_600_000, to: NOW, history: true });
  });

  it("reaches back to the oldest request for all time", () => {
    const state = stateOver(preset("all"), [NOW - 5_000]);
    expect(flowSource(state, NOW)).toEqual({ from: NOW - 5_000, to: NOW, history: false });
  });
});
