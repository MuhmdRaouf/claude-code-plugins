import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type History, type NodeUpsert, openHistory } from "../src/history/history.ts";
import {
  DAY_MS,
  PRUNE_INTERVAL_MS,
  pruneOnce,
  retentionCutoff,
  schedulePrunes,
} from "../src/history/retention.ts";
import { feedTranscriptLine, newTranscriptState } from "../src/ingest/transcript.ts";
import { createInsights } from "../src/server/insights.ts";
import {
  type ApiResponse,
  type AppInfo,
  HISTORY_LIVE_MS,
  handleApi,
  handleWrite,
  ROUTES,
} from "../src/server/routes.ts";
import { DEFAULT_SETTINGS, writeSettings } from "../src/server/settings.ts";
import { OUTSIDE_SESSION, type RequestRecord, ZERO_TOKENS } from "../src/shared/model.ts";
import { createStore, type Store } from "../src/store/store.ts";
import { iso, makeEnv, makeRequest, makeTool } from "./helpers.ts";

const INFO: AppInfo = { version: "0.0.1", startedAt: 1_000, port: 12_345 };

function get(store: Store, path: string, query = ""): ApiResponse {
  return handleApi(store, INFO, { path, query: new URLSearchParams(query) });
}

function seeded(): Store {
  const store = createStore();
  store.addRequest(makeRequest({ id: "r1", ts: 100, model: "a" }));
  store.addRequest(makeRequest({ id: "r2", ts: 300, model: "b" }));
  store.addRequest(makeRequest({ id: "r3", ts: 200, sessionId: "s2" }));
  store.addRequest(makeRequest({ id: "r4", ts: 50, agentId: "w1" }));
  return store;
}

describe("handleApi", () => {
  it("lists every route, the original eight first", () => {
    expect(ROUTES).toEqual([
      "/api/summary",
      "/api/sessions",
      "/api/sessions/:id",
      "/api/requests",
      "/api/events",
      "/api/tools",
      "/api/models",
      "/api/health",
      "/api/alerts",
      "/api/attribution",
      "/api/budgets",
      "/api/budget-status",
      "/api/spend",
      "/api/settings",
      "/api/router",
      "/api/advisor",
      "/api/history/roots",
      "/api/history/tree/:rootId",
      "/api/history/requests",
      "/api/history/content/:requestId",
      "/api/history/context/:requestId",
      "/api/history/request/:requestId/capture",
      "/api/history/agent/:nodeId/transcript",
      "/api/history/repos",
      "/api/history/flow",
      "/api/history/stats",
      "/api/history/clear",
    ]);
  });

  it("serves the summary and the session list", () => {
    const store = createStore();
    store.addSpoolLine({ ts: iso(1_000), event: "UserPromptSubmit", session_id: "s1", prompt: "a" });
    store.addSpoolLine({ ts: iso(2_000), event: "UserPromptSubmit", session_id: "s2", prompt: "b" });
    const summary = get(store, "/api/summary");
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ summary: { sessions: 2 } });
    const sessions = get(store, "/api/sessions");
    expect(sessions.status).toBe(200);
    expect((sessions.body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual([
      "s2",
      "s1",
    ]);
  });

  it("serves one session, decoding its id, and 404s the rest", () => {
    const store = createStore();
    store.addSpoolLine({ ts: iso(1_000), event: "SessionStart", session_id: "s 1", cwd: "/w/app" });
    const found = get(store, `/api/sessions/${encodeURIComponent("s 1")}`);
    expect(found.status).toBe(200);
    expect((found.body as { session: { id: string } }).session.id).toBe("s 1");
    expect(get(store, "/api/sessions/nope").body).toEqual({ error: "unknown session: nope" });
    expect(get(store, "/api/sessions/").body).toEqual({ error: "missing session id" });
  });

  it("serves 48-bucket activity for every session, a live window or the whole span", () => {
    const store = createStore();
    const now = Date.now();
    store.addSpoolLine({ ts: iso(now - 60_000), event: "SessionStart", session_id: "live-1" });
    store.applyRegistry(
      [
        {
          pid: 100,
          sessionId: "live-1",
          name: null,
          nameSource: null,
          status: "busy",
          cwd: null,
          startedAt: null,
        },
      ],
      now,
    );
    store.addRequest(makeRequest({ id: "r1", sessionId: "live-1", ts: now - 30_000 }));
    store.addRequest(makeRequest({ id: "r2", sessionId: "old-1", ts: 1_000, model: "glm-5.3" }));
    store.addRequest(makeRequest({ id: "r3", sessionId: "old-1", ts: 2_000, model: "glm-5.3" }));
    type Shaped = {
      id: string;
      status: string | null;
      activity: { bucketMs: number; counts: number[]; models: string[] };
    };
    const listed = (get(store, "/api/sessions").body as { sessions: Shaped[] }).sessions;
    const live = listed.find((session) => session.id === "live-1");
    expect(live).toMatchObject({ status: "working" });
    expect(live?.activity.bucketMs).toBe(18_750); // 15 minutes ending now, in 48
    expect(live?.activity.counts.reduce((a, b) => a + b, 0)).toBe(1);
    const ended = listed.find((session) => session.id === "old-1");
    expect(ended?.status).toBeNull();
    expect(ended?.activity.bucketMs).toBe(21); // a one-second run stretched over the same 48
    expect(ended?.activity.counts[0]).toBe(1);
    expect(ended?.activity.counts[47]).toBe(1);
    expect(ended?.activity.models[0]).toBe("glm-5.3");
    const detail = (get(store, "/api/sessions/old-1").body as { session: Shaped }).session;
    expect(detail.activity).toEqual(ended?.activity);
  });

  it("carries a session's name, branch, repo and parent session in both session routes", () => {
    const store = createStore();
    store.upsertSession({
      id: "zai:j1",
      branch: "zai/j1",
      repo: "/w/main",
      parentSessionId: "s9",
      customTitle: "Fix tests",
    });
    // the job's parent is not listed: it hangs off the Unattached group, never off the top level
    store.addRequest(makeRequest({ id: "r0", sessionId: OUTSIDE_SESSION, ts: 1_000 }));
    const listed = get(store, "/api/sessions");
    const [top] = (listed.body as { sessions: Array<Record<string, unknown>> }).sessions;
    expect(top).toMatchObject({ id: "outside-a-session", name: "Unattached" });
    expect(top?.jobs).toEqual([
      expect.objectContaining({
        id: "zai:j1",
        name: "Fix tests",
        branch: "zai/j1",
        repo: "/w/main",
        parentSessionId: "s9",
      }),
    ]);
    const detail = get(store, "/api/sessions/zai%3Aj1");
    expect((detail.body as { session: Record<string, unknown> }).session).toMatchObject({
      name: "Fix tests",
      branch: "zai/j1",
      repo: "/w/main",
      parentSessionId: "s9",
    });
  });

  it("filters requests by session, agent, model and since", () => {
    const store = seeded();
    const ids = (query: string): string[] =>
      (get(store, "/api/requests", query).body as { requests: Array<{ id: string }> }).requests.map(
        (r) => r.id,
      );
    expect(ids("")).toEqual(["r2", "r3", "r1", "r4"]);
    expect(ids("session=s2")).toEqual(["r3"]);
    expect(ids("model=a")).toEqual(["r1"]);
    expect(ids("agent=w1")).toEqual(["r4"]);
    expect(ids("since=150")).toEqual(["r2", "r3"]);
    expect(ids("limit=2")).toEqual(["r2", "r3"]);
  });

  it("clamps request limits to the default and the cap", () => {
    const store = createStore();
    for (let i = 0; i < 1_205; i += 1) {
      store.addRequest(makeRequest({ id: `q${i}`, ts: i }));
    }
    const cases: Array<[string, number]> = [
      ["", 200],
      ["limit=5", 5],
      ["limit=5000", 1_000],
      ["limit=abc", 200],
      ["limit=0", 200],
      ["limit=-3", 200],
    ];
    for (const [query, expected] of cases) {
      const body = get(store, "/api/requests", query).body as { requests: unknown[] };
      expect(body.requests).toHaveLength(expected);
    }
    const newest = (get(store, "/api/requests").body as { requests: Array<{ id: string }> }).requests[0]?.id;
    expect(newest).toBe("q1204");
  });

  it("filters events by session and since, with the same limit clamps", () => {
    const store = createStore();
    for (let i = 0; i < 250; i += 1) {
      store.addSpoolLine({
        ts: iso(i),
        event: "UserPromptSubmit",
        session_id: i % 2 === 0 ? "s1" : "s2",
        prompt: `e${i}`,
      });
    }
    const all = get(store, "/api/events").body as { events: Array<{ label: string | null }> };
    expect(all.events).toHaveLength(200); // default limit
    expect(all.events[0]?.label).toBe("e249");
    expect((get(store, "/api/events", "limit=7").body as { events: unknown[] }).events).toHaveLength(7);
    const mine = (
      get(store, "/api/events", "session=s1").body as { events: Array<{ sessionId: string | null }> }
    ).events;
    expect(mine).toHaveLength(125);
    expect(mine.every((event) => event.sessionId === "s1")).toBe(true);
    expect((get(store, "/api/events", "since=200").body as { events: unknown[] }).events).toHaveLength(50);
    expect((get(store, "/api/events", "since=abc").body as { events: unknown[] }).events).toHaveLength(200);
  });

  it("serves recent tool calls newest first, filtered by session and failure", () => {
    const store = createStore();
    store.addToolCall(makeTool({ id: "t1", sessionId: "s1", startedAt: 1_000, ok: true }));
    store.addToolCall(makeTool({ id: "t2", sessionId: "s2", startedAt: 3_000, ok: false }));
    store.addToolCall(makeTool({ id: "t3", sessionId: "s1", startedAt: 2_000, ok: false }));
    const ids = (query: string): string[] =>
      (get(store, "/api/tools", query).body as { tools: Array<{ id: string }> }).tools.map((t) => t.id);
    expect(ids("")).toEqual(["t2", "t3", "t1"]);
    expect(ids("session=s1")).toEqual(["t3", "t1"]);
    expect(ids("failed=1")).toEqual(["t2", "t3"]);
    expect(ids("failed=0")).toEqual(["t2", "t3", "t1"]);
    expect(ids("limit=1")).toEqual(["t2"]);
  });

  it("serves the models view verbatim", () => {
    const store = createStore();
    store.addRequest(makeRequest({ model: "glm-5.3" }));
    store.addToolCall(makeTool({ ok: false }));
    const models = get(store, "/api/models");
    expect(models.status).toBe(200);
    expect(models.body).toEqual(store.models());
  });

  it("narrows the models view to the window and sessions it is asked for", () => {
    const store = createStore();
    store.addRequest(makeRequest({ id: "r1", ts: 100, model: "glm-5.3" }));
    store.addRequest(makeRequest({ id: "r2", ts: 300, model: "glm-5.3", sessionId: "s2" }));
    store.addRequest(makeRequest({ id: "r3", ts: 500, model: "kimi-k3", sessionId: "s2" }));
    const modelsOf = (answer: ApiResponse): { model: string; requests: number }[] =>
      (answer.body as { models: { model: string; requests: number }[] }).models.map((row) => ({
        model: row.model,
        requests: row.requests,
      }));
    // no scope: every request, the cached answer the snapshot pushes
    expect(modelsOf(get(store, "/api/models"))).toEqual([
      { model: "glm-5.3", requests: 2 },
      { model: "kimi-k3", requests: 1 },
    ]);
    // a window drops what ran before it
    expect(modelsOf(get(store, "/api/models", "from=200"))).toEqual([
      { model: "glm-5.3", requests: 1 },
      { model: "kimi-k3", requests: 1 },
    ]);
    // the picked session (its subagents' records carry its id) narrows to it
    expect(modelsOf(get(store, "/api/models", "session=s2"))).toEqual([
      { model: "glm-5.3", requests: 1 },
      { model: "kimi-k3", requests: 1 },
    ]);
    // window and sessions together, the way the models tab asks
    expect(modelsOf(get(store, "/api/models", "from=400&session=s2"))).toEqual([
      { model: "kimi-k3", requests: 1 },
    ]);
  });

  it("answers health with build facts and a live count", () => {
    const store = createStore();
    store.addSpoolLine({ ts: iso(1_000), event: "UserPromptSubmit", session_id: "s1", prompt: "a" });
    const body = get(store, "/api/health").body as {
      ok: boolean;
      version: string;
      startedAt: number;
      port: number;
      sessions: number;
      uptimeMs: number;
    };
    expect(body).toMatchObject({ ok: true, version: "0.0.1", startedAt: 1_000, port: 12_345, sessions: 1 });
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.uptimeMs).toBeLessThanOrEqual(Date.now() - INFO.startedAt);
  });

  it("404s unknown api paths with the route list attached", () => {
    const unknown = get(createStore(), "/api/nope");
    expect(unknown.status).toBe(404);
    const body = unknown.body as { error: string; routes: readonly string[] };
    expect(body.error).toContain("/api/nope");
    expect(body.routes).toEqual(ROUTES);
  });
});

describe("history routes", () => {
  const MINUTE = 60_000;
  const R1_INPUT = JSON.stringify([{ type: "text", text: "fix the bug" }]);
  const R1_OUTPUT = JSON.stringify([
    { type: "text", text: "on it" },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
  ]);

  let dir: string;
  let history: History | null = null;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "radar-history-routes-"));
    history = null;
    now = Date.now();
  });

  afterEach(() => {
    history?.close();
    history = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function node(overrides: Partial<NodeUpsert> = {}): NodeUpsert {
    return { id: "s1/main", kind: "main", sessionId: "s1", agentId: "main", ...overrides };
  }

  function req(overrides: Partial<RequestRecord> = {}): RequestRecord {
    return {
      id: "r1",
      sessionId: "s1",
      agentId: "main",
      model: "glm-5.3",
      upstream: "https://api.z.ai",
      ts: now - 4 * MINUTE,
      latencyMs: 10,
      tokens: { ...ZERO_TOKENS, input: 1000, output: 100 },
      stopReason: null,
      provider: "zai",
      ...overrides,
    };
  }

  /** One live tree (main, two subagents, a linked job) plus an old main and an unattached job in history. */
  async function seeded(): Promise<History> {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(
      node({
        repo: "/w/main",
        branch: "main",
        name: "Big fix",
        project: "app",
        cwd: "/w/main",
        model: "glm-5.3",
        startedAt: now - 5 * MINUTE,
        lastAt: now,
      }),
    );
    h.upsertNode(
      node({
        id: "s1/a1",
        kind: "subagent",
        parentId: "s1/main",
        agentId: "a1",
        agentType: "fork",
        description: "dig",
        model: "glm-5.3-flash",
        lastAt: now - MINUTE,
      }),
    );
    h.upsertNode(
      node({
        id: "s1/a2",
        kind: "subagent",
        parentId: "s1/main",
        agentId: "a2",
        agentType: "general-purpose",
        model: "glm-5.3-flash",
        lastAt: now - 2 * MINUTE,
      }),
    );
    h.upsertNode(
      node({
        id: "job:s1",
        kind: "job",
        parentId: "s1/main",
        sessionId: "s1",
        agentId: "job",
        jobState: "running",
        repo: "/w/main",
        lastAt: now - 3 * MINUTE,
      }),
    );
    h.upsertNode(
      node({
        id: "s2/main",
        sessionId: "s2",
        repo: "/w/other",
        branch: "feat",
        name: "Old work",
        model: "glm-5.3-flash",
        startedAt: now - 60 * MINUTE,
        lastAt: now - 20 * MINUTE,
      }),
    );
    h.upsertNode(
      node({
        id: "job:s3",
        kind: "job",
        sessionId: "s3",
        agentId: "job",
        jobState: "done",
        repo: "/w/other",
        lastAt: now - 30 * MINUTE,
      }),
    );
    h.putRequest("s1/main", req({ id: "r1", ts: now - 4 * MINUTE }));
    h.putRequest(
      "s1/a1",
      req({
        id: "r2",
        agentId: "a1",
        model: "glm-5.3-flash",
        ts: now - 150_000,
        tokens: { ...ZERO_TOKENS, input: 500, output: 50 },
      }),
    );
    h.putRequest(
      "s1/a2",
      req({
        id: "r3",
        agentId: "a2",
        model: "claude-sonnet-5-5",
        upstream: "https://api.anthropic.com",
        provider: "anthropic",
        ts: now - 90_000,
        tokens: { ...ZERO_TOKENS, input: 200, output: 20 },
      }),
    );
    h.putRequest(
      "s2/main",
      req({ id: "r4", sessionId: "s2", model: "glm-5.3-flash", ts: now - 25 * MINUTE }),
    );
    h.putContent("r1", { input: R1_INPUT, output: R1_OUTPUT });
    return h;
  }

  /** GET as the routes see it: a full "/api/history/..." path with its query string. `store` stands in
   *  for the live store, so a test can put sessions in the registry the way the running server has. */
  function hget(path: string, insights?: ReturnType<typeof createInsights>, store?: Store): ApiResponse {
    const at = path.indexOf("?");
    return handleApi(
      store ?? createStore(),
      INFO,
      {
        path: at === -1 ? path : (path.slice(0, at) ?? path),
        query: new URLSearchParams(at === -1 ? "" : path.slice(at + 1)),
      },
      insights,
      history,
    );
  }

  function insightsOf(): ReturnType<typeof createInsights> {
    return createInsights({ env: makeEnv().env, store: createStore(), tickMs: 0 });
  }

  function rootIdsOf(h: History, scope: "live" | "history"): string[] {
    return h.roots({ scope, now: Date.now(), liveMs: HISTORY_LIVE_MS, limit: 50 }).map((root) => root.id);
  }

  /** Every top-level tree, either scope: the prune tests advance the clock, so live moves to history. */
  function allTreeIds(h: History): string[] {
    return [...rootIdsOf(h, "live"), ...rootIdsOf(h, "history")].sort();
  }

  it("503s every history read when the history failed to open", () => {
    for (const path of [
      "/api/history/roots",
      "/api/history/tree/x",
      "/api/history/requests",
      "/api/history/content/x",
      "/api/history/context/x",
      "/api/history/agent/x/transcript",
      "/api/history/repos",
      "/api/history/flow",
      "/api/history/stats",
    ]) {
      expect(hget(path)).toEqual({ status: 503, body: { error: "history unavailable" } });
    }
  });

  it("flows the window's requests and token kinds as zero-filled buckets", async () => {
    history = await seeded();
    const body = hget(`/api/history/flow?from=${now - 5 * MINUTE}&to=${now}&buckets=5`).body as {
      from: number;
      to: number;
      bucketMs: number;
      requests: number[];
      kinds: Record<string, number[]>;
    };
    expect(body.from).toBe(now - 5 * MINUTE);
    expect(body.to).toBe(now);
    expect(body.bucketMs).toBe(MINUTE);
    // r1 lands 1 min in, r2 at 2.5 min truncates to the 3rd bar, r3 at 3.5 min to the 4th; r4 is outside
    expect(body.requests).toEqual([0, 1, 1, 1, 0]);
    expect(body.kinds.input).toEqual([0, 1000, 500, 200, 0]);
    expect(body.kinds.output).toEqual([0, 100, 50, 20, 0]);
    expect(body.kinds.cacheRead).toEqual([0, 0, 0, 0, 0]);
    expect(body.kinds.cacheWrite).toEqual([0, 0, 0, 0, 0]);
  });

  it("defaults to 60 buckets and drops nothing outside its bars", async () => {
    history = await seeded();
    const body = hget(`/api/history/flow?from=${now - 5 * MINUTE}&to=${now}`).body as {
      bucketMs: number;
      requests: number[];
    };
    expect(body.bucketMs).toBe(5_000);
    expect(body.requests).toHaveLength(60);
    expect(body.requests.reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  it("400s a bad window and caps buckets, clamping the overflow into the last bar", async () => {
    history = await seeded();
    expect(hget("/api/history/flow").body).toEqual({ error: "from: epoch ms the window starts at" });
    expect(hget(`/api/history/flow?from=${now}`).body).toEqual({
      error: "to: epoch ms the window ends at",
    });
    expect(hget(`/api/history/flow?from=later&to=${now}`).body).toEqual({
      error: "from: epoch ms the window starts at",
    });
    expect(hget(`/api/history/flow?from=${now}&to=${now}`).body).toEqual({
      error: "from must be before to",
    });
    // 999 bars asked, 240 answered: every seeded request is hours inside the bucket-count cap's span,
    // so the clamped last bar must still hold all four
    const body = hget(`/api/history/flow?from=0&to=${now}&buckets=999`).body as {
      bucketMs: number;
      requests: number[];
    };
    expect(body.bucketMs).toBe(86_400_000);
    expect(body.requests).toHaveLength(240);
    expect(body.requests.reduce((sum, count) => sum + count, 0)).toBe(4);
  });

  it("splits live roots from history, unattached jobs history-only, with roll-ups", async () => {
    history = await seeded();
    const live = hget("/api/history/roots").body as {
      roots: Array<Record<string, unknown>>;
      next: unknown;
    };
    expect(live.roots.map((root) => root.id)).toEqual(["s1/main"]);
    expect(live.roots[0]).toMatchObject({
      id: "s1/main",
      name: "Big fix",
      repo: "/w/main",
      branch: "main",
      model: "glm-5.3",
      requests: 3,
      nodes: 4,
      liveNodes: 4,
    });
    const liveActivity = live.roots[0]?.activity as {
      bucketMs: number;
      counts: number[];
      models: string[];
    };
    expect(liveActivity.bucketMs).toBe(18_750); // the 15-minute live window in 48 buckets
    expect(liveActivity.counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(liveActivity.models[35]).toBe("glm-5.3"); // 4 minutes ago
    expect(liveActivity.models[39]).toBe("glm-5.3-flash"); // 2.5 minutes ago
    expect(liveActivity.models[43]).toBe("claude-sonnet-5-5"); // 90 seconds ago
    const tokens = live.roots[0]?.tokens as { input: number } | undefined;
    expect(tokens?.input).toBe(1700);
    expect(live.roots[0]?.costUsd).toBeGreaterThan(0);
    expect(live.next).toBeNull();

    const past = hget("/api/history/roots?scope=history").body as {
      roots: Array<{
        id: string;
        requests: number;
        costUsd: number | null;
        activity: { bucketMs: number; counts: number[]; models: string[] };
      }>;
      next: unknown;
    };
    expect(past.roots.map((root) => root.id)).toEqual(["s2/main", "outside-a-session"]);
    expect(past.roots[0]).toMatchObject({ requests: 1, costUsd: expect.any(Number) });
    // the Unattached group: the ended job s3, rolled up alone, priced at nothing it ran
    expect(past.roots[1]).toMatchObject({
      id: "outside-a-session",
      kind: "job",
      name: "Unattached",
      sessionId: "outside-a-session",
      nodes: 1,
      requests: 0,
      costUsd: null, // nothing ran, nothing priced
    });
    const pastActivity = past.roots[0]?.activity as {
      bucketMs: number;
      counts: number[];
      models: string[];
    };
    expect(pastActivity.bucketMs).toBe(50_000); // a 40-minute run from start to last activity, in 48
    expect(pastActivity.counts[42]).toBe(1);
    expect(pastActivity.models[42]).toBe("glm-5.3-flash");
    expect(past.next).toBeNull();
  });

  it("keeps the registry's live sessions out of history, in the list and in the count", async () => {
    history = await seeded();
    // s2 went quiet 20 minutes ago: time alone would call it ended, but the registry still has it open,
    // so it stays a Live card and History must not list it a second time
    const store = createStore();
    store.applyRegistry(
      [
        {
          pid: 100,
          sessionId: "s2",
          name: null,
          nameSource: null,
          status: "busy",
          cwd: null,
          startedAt: null,
        },
      ],
      now,
    );
    const ids = (path: string): string[] =>
      (hget(path, undefined, store).body as { roots: Array<{ id: string }> }).roots.map((root) => root.id);
    expect(ids("/api/history/roots?scope=history")).toEqual(["outside-a-session"]); // Unattached stays
    expect(ids("/api/history/roots")).toEqual(["s1/main"]); // the live scope is untouched by the rule
    const counted = hget("/api/history/stats", undefined, store).body as { roots: number };
    expect(counted.roots).toBe(0); // the badge counts what the list would show
    // without the registry listing it, the same rows read as history again
    const unfiltered = hget("/api/history/roots?scope=history").body as { roots: Array<{ id: string }> };
    expect(unfiltered.roots.map((root) => root.id)).toEqual(["s2/main", "outside-a-session"]);
  });

  it("never names a root by a path: the old repo fallback reads as the repo's own name", async () => {
    history = await seeded();
    // rows written before the name fallback learned better carry the repo's whole path as the name
    history.upsertNode(
      node({
        id: "s5/main",
        sessionId: "s5",
        repo: "/Users/raouf/.work/onthegosystems/wpml-org/app",
        cwd: "/Users/raouf/.work/onthegosystems/wpml-org/app",
        name: "/Users/raouf/.work/onthegosystems/wpml-org/app",
        lastAt: now - 30 * MINUTE,
      }),
    );
    const past = hget("/api/history/roots?scope=history").body as {
      roots: Array<{ id: string; name: string | null; cwd: string | null }>;
    };
    const root = past.roots.find((entry) => entry.id === "s5/main");
    expect(root?.name).toBe("app");
    expect(root?.cwd).toBe("/Users/raouf/.work/onthegosystems/wpml-org/app"); // the path stays on the node
  });

  it("rejects an unknown scope and pages roots by last_at", async () => {
    history = await seeded();
    expect(hget("/api/history/roots?scope=nope")).toMatchObject({
      status: 400,
      body: { error: "scope: one of live, history" },
    });
    history.upsertNode(
      node({
        id: "s4/main",
        sessionId: "s4",
        repo: "/w/other",
        name: "Older still",
        startedAt: now - 80 * MINUTE,
        lastAt: now - 40 * MINUTE,
      }),
    );
    const first = hget("/api/history/roots?scope=history&limit=1").body as {
      roots: Array<{ id: string; kind: string }>;
      next: number;
    };
    // the unfiltered first page ends with the one Unattached group, but pagination counts mains only
    expect(first.roots.map((root) => root.id)).toEqual(["s2/main", "outside-a-session"]);
    expect(first.next).toBe(now - 20 * MINUTE);
    const second = hget(`/api/history/roots?scope=history&limit=1&before=${first.next}`).body as {
      roots: Array<{ id: string }>;
      next: unknown;
    };
    expect(second.roots.map((root) => root.id)).toEqual(["s4/main"]);
    expect(second.next).toBeNull();
  });

  it("filters roots by repo and by search text", async () => {
    history = await seeded();
    const ids = (query: string): string[] =>
      (hget(`/api/history/roots?${query}`).body as { roots: Array<{ id: string }> }).roots.map(
        (root) => root.id,
      );
    expect(ids("scope=history&repo=/w/other")).toEqual(["s2/main"]);
    expect(ids("repo=/w/main")).toEqual(["s1/main"]);
    expect(ids("scope=history&q=old")).toEqual(["s2/main"]);
    expect(ids("q=zzz")).toEqual([]);
  });

  it("shows one tree's nodes with per-node cost, live flags and job state", async () => {
    history = await seeded();
    const body = hget("/api/history/tree/s1%2Fmain").body as { nodes: Array<Record<string, unknown>> };
    expect(body.nodes.map((n) => n.id)).toEqual(["s1/main", "s1/a1", "s1/a2", "job:s1"]);
    expect(body.nodes.map((n) => n.live)).toEqual([true, true, true, true]);
    expect(body.nodes[1]).toMatchObject({
      agentType: "fork",
      description: "dig",
      parentId: "s1/main",
      requests: 1,
      costUsd: expect.any(Number),
    });
    expect(body.nodes[3]).toMatchObject({ kind: "job", jobState: "running", requests: 0, costUsd: null });
    expect(hget("/api/history/tree/nope")).toMatchObject({
      status: 404,
      body: { error: "unknown root: nope" },
    });
    expect(hget("/api/history/tree/")).toMatchObject({ status: 404, body: { error: "missing root id" } });
  });

  it("lists a tree's requests newest first with prices, keyset paged", async () => {
    history = await seeded();
    const first = hget("/api/history/requests?root=s1%2Fmain&limit=2").body as {
      requests: Array<{ id: string; cost: { usd: number; detail: string[] } | null }>;
      next: string;
    };
    expect(first.requests.map((r) => r.id)).toEqual(["r3", "r2"]);
    expect(first.requests[0]?.cost).toMatchObject({ usd: expect.any(Number), detail: ["Anthropic list"] });
    expect(first.next).toBe(`${now - 150_000}:r2`);
    const second = hget(
      `/api/history/requests?root=s1%2Fmain&limit=2&before=${encodeURIComponent(first.next)}`,
    ).body as { requests: Array<{ id: string }>; next: unknown };
    expect(second.requests.map((r) => r.id)).toEqual(["r1"]);
    expect(second.next).toBeNull();
    expect(
      (hget("/api/history/requests?node=s1%2Fa1").body as { requests: Array<{ id: string }> }).requests.map(
        (r) => r.id,
      ),
    ).toEqual(["r2"]);
  });

  it("rejects request listings without a node or root, and bad cursors", async () => {
    history = await seeded();
    expect(hget("/api/history/requests").status).toBe(400);
    expect(hget("/api/history/requests?node=x&before=zzz").status).toBe(400);
    expect(hget("/api/history/requests?node=x&before=123:").status).toBe(400);
  });

  it("parses stored content back to block arrays and 404s the rest", async () => {
    history = await seeded();
    const body = hget("/api/history/content/r1").body as {
      input: unknown;
      output: unknown;
      bytes: number;
    };
    expect(body.input).toEqual(JSON.parse(R1_INPUT));
    expect(body.output).toEqual(JSON.parse(R1_OUTPUT));
    expect(body.bytes).toBe(Buffer.byteLength(R1_INPUT) + Buffer.byteLength(R1_OUTPUT));
    expect(hget("/api/history/content/nope")).toMatchObject({
      status: 404,
      body: { error: "unknown request: nope" },
    });
  });

  it("caps a content response at a megabyte, cutting the longest block with a marker", async () => {
    history = await seeded();
    const big = [{ type: "text", text: "x".repeat(1_500_000) }];
    const out = [{ type: "text", text: "y".repeat(200_000) }];
    history.upsertNode(node({ id: "big/main", sessionId: "big", lastAt: now - MINUTE }));
    history.putRequest("big/main", req({ id: "rbig", sessionId: "big", ts: now - MINUTE }));
    history.putContent("rbig", { input: JSON.stringify(big), output: JSON.stringify(out) });
    const res = hget("/api/history/content/rbig");
    expect(res.status).toBe(200);
    const body = res.body as { input: Array<{ text: string }>; output: unknown; bytes: number };
    expect(body.bytes).toBe(Buffer.byteLength(JSON.stringify(big)) + Buffer.byteLength(JSON.stringify(out)));
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThanOrEqual(1024 * 1024 + 512);
    expect(body.input[0]?.text.startsWith("xxxxxxxxxx")).toBe(true);
    expect(body.input[0]?.text.endsWith("bytes]")).toBe(true);
    expect(JSON.stringify(body)).toContain("…[truncated");
    expect(body.output).toEqual(out); // the shorter side survives whole
  });

  /** Two requests on a quiet node whose sides come from a real transcript feed: the request, its answer,
   *  the tool result the answer caused, then the request that saw it. */
  async function transcribed(): Promise<{ first: string; target: string }> {
    const h = history as History;
    h.upsertNode(node({ id: "s9/main", sessionId: "s9", lastAt: now - MINUTE }));
    h.putRequest("s9/main", req({ id: "tr0", sessionId: "s9", ts: now - 3 * MINUTE }));
    h.putRequest(
      "s9/main",
      req({
        id: "tr1",
        sessionId: "s9",
        ts: now - 2 * MINUTE,
        tokens: { ...ZERO_TOKENS, input: 400, cacheRead: 120 },
      }),
    );
    const identity = { sessionId: "s9", agentId: null, kind: "main" as const };
    const state = newTranscriptState();
    const lines = [
      { type: "user", sessionId: "s9", timestamp: iso(now - 181_000), message: { content: "fix the bug" } },
      {
        type: "assistant",
        sessionId: "s9",
        requestId: "tr0",
        timestamp: iso(now - 180_000),
        message: {
          model: "glm-5.3",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", id: "call1", name: "Bash", input: { command: "git status" } },
          ],
          usage: { input_tokens: 300 },
        },
      },
      {
        type: "user",
        sessionId: "s9",
        timestamp: iso(now - 125_000),
        message: { content: [{ type: "tool_result", tool_use_id: "call1", content: "clean tree" }] },
      },
      {
        type: "assistant",
        sessionId: "s9",
        requestId: "tr1",
        timestamp: iso(now - 120_000),
        message: {
          model: "glm-5.3",
          content: [{ type: "text", text: "nothing to fix" }],
          usage: { input_tokens: 400, cache_read_input_tokens: 120, output_tokens: 9 },
        },
      },
    ];
    for (const line of lines) {
      for (const emit of [feedTranscriptLine(state, identity, JSON.stringify(line))]) {
        for (const capture of emit.content) {
          h.putContent(capture.requestId, { input: capture.input, output: capture.output });
        }
      }
    }
    return { first: "tr0", target: "tr1" };
  }

  it("rebuilds the conversation a request sat in, ending at its own input", async () => {
    history = await seeded();
    await transcribed();
    const body = hget("/api/history/context/tr1").body as {
      requestId: string;
      nodeId: string;
      model: string;
      totals: {
        messages: number;
        approxTokens: number;
        usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
        cacheTokens: number;
      };
      messages: Array<{ role: string; kind: string; requestId: string; preview: string; bytes: number }>;
      next: string | null;
      note: string;
    };
    expect(body.requestId).toBe("tr1");
    expect(body.nodeId).toBe("s9/main");
    expect(body.model).toBe("glm-5.3");
    expect(body.messages.map((m) => [m.role, m.kind, m.requestId, m.preview])).toEqual([
      ["user", "text", "tr0", "fix the bug"],
      ["assistant", "text", "tr0", "on it"],
      ["user", "tool_result", "tr1", "clean tree"],
    ]);
    expect(body.messages[2]?.kind).toBe("tool_result");
    // the totals cover the whole conversation, and the cache split is the request's own usage
    expect(body.totals.messages).toBe(3);
    expect(body.totals.usage).toEqual({ input: 400, output: 0, cacheRead: 120, cacheWrite: 0 });
    expect(body.totals.cacheTokens).toBe(120);
    expect(body.totals.approxTokens).toBeGreaterThan(0);
    expect(body.note).toBe("System prompt and tool definitions are not in the transcript.");
  });

  it("pages the conversation backwards from the request, cursor by cursor", async () => {
    history = await seeded();
    await transcribed();
    const first = hget("/api/history/context/tr1?limit=1").body as {
      messages: Array<{ requestId: string; role: string }>;
      next: string | null;
      totals: { messages: number };
    };
    expect(first.messages.map((m) => [m.requestId, m.role])).toEqual([["tr1", "user"]]);
    expect(first.totals.messages).toBe(3);
    // the cursor names the page's own first message, so the next page is everything before it
    expect(first.next).toBe(`${now - 120_000}:tr1:0`);
    const second = hget(`/api/history/context/tr1?limit=1&cursor=${encodeURIComponent(first.next ?? "")}`)
      .body as { messages: Array<{ requestId: string; role: string }>; next: string | null };
    expect(second.messages.map((m) => [m.requestId, m.role])).toEqual([["tr0", "assistant"]]);
    expect(second.next).toBe(`${now - 180_000}:tr0:1`);
    const third = hget(`/api/history/context/tr1?limit=1&cursor=${encodeURIComponent(second.next ?? "")}`)
      .body as { messages: Array<{ requestId: string; role: string }>; next: string | null };
    expect(third.messages.map((m) => [m.requestId, m.role])).toEqual([["tr0", "user"]]);
    expect(third.next).toBeNull();
    // an unknown-but-well-formed cursor pages past the start to an empty page
    const past = hget(`/api/history/context/tr1?cursor=${encodeURIComponent(`1:zzz:0`)}`).body as {
      messages: unknown[];
      next: string | null;
    };
    expect(past.messages).toEqual([]);
    expect(past.next).toBeNull();
  });

  it("serves a request's captured prompt decompressed, and 404s the rest", async () => {
    history = await seeded();
    const payload = { system: "be brief", tools: [{ name: "Bash", input_schema: { type: "object" } }] };
    const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
    history.putRequest(
      "s1/main",
      req({
        id: "cap1",
        ts: now - MINUTE,
        promptHash: "h".repeat(64),
        headers: { "request-id": "req_9", "retry-after": "7" },
      }),
    );
    history.putCapture({ hash: "h".repeat(64), gz: gz.toString("base64"), firstTs: now - MINUTE });
    const body = hget("/api/history/request/cap1/capture").body as {
      hash: string;
      system: unknown;
      tools: unknown;
      bytes: number;
      headers: Record<string, string> | null;
    };
    expect(body.hash).toBe("h".repeat(64));
    expect(body.system).toBe("be brief");
    expect(body.tools).toEqual(payload.tools);
    expect(body.bytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
    expect(body.headers).toEqual({ "request-id": "req_9", "retry-after": "7" });
    // a request whose route named no hash, and one that does not exist, have nothing to serve
    expect(hget("/api/history/request/r1/capture")).toMatchObject({
      status: 404,
      body: { error: "no capture for request: r1" },
    });
    expect(hget("/api/history/request/nope/capture")).toMatchObject({ status: 404 });
    expect(hget("/api/history/request//capture")).toMatchObject({
      status: 404,
      body: { error: "missing request id" },
    });
    expect(hget("/api/history/request/%zz/capture")).toMatchObject({
      status: 400,
      body: { error: "id is not valid URI encoding" },
    });
  });

  it("rejects a bad context cursor and 404s an unknown request, like the other reads", async () => {
    history = await seeded();
    expect(hget("/api/history/context/nope")).toMatchObject({
      status: 404,
      body: { error: "unknown request: nope" },
    });
    expect(hget(`/api/history/context/tr1?cursor=not-a-cursor`)).toMatchObject({ status: 400 });
    expect(hget("/api/history/context/")).toMatchObject({
      status: 404,
      body: { error: "missing request id" },
    });
  });

  it("holds one context page to a megabyte by cutting its biggest text", async () => {
    history = await seeded();
    const big = "x".repeat(1_500_000);
    history.upsertNode(node({ id: "big/main", sessionId: "big", lastAt: now - MINUTE }));
    history.putRequest("big/main", req({ id: "rbig", sessionId: "big", ts: now - MINUTE }));
    history.putRequest("big/main", req({ id: "rbig2", sessionId: "big", ts: now - 30_000 }));
    history.putContent("rbig", {
      input: JSON.stringify([{ type: "text", text: big }]),
      output: JSON.stringify([{ type: "text", text: "short answer" }]),
    });
    history.putContent("rbig2", { input: JSON.stringify([{ type: "text", text: "latest" }]), output: null });
    const res = hget("/api/history/context/rbig2");
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThanOrEqual(1024 * 1024 + 512);
    expect(JSON.stringify(res.body)).toContain("…[truncated");
  });

  it("serves an agent's whole transcript by node id, newest answer included", async () => {
    history = await seeded();
    await transcribed();
    const body = hget("/api/history/agent/s9/main/transcript").body as {
      requestId: string;
      nodeId: string;
      model: string;
      totals: { messages: number };
      messages: Array<{ role: string; kind: string; requestId: string; preview: string }>;
      next: string | null;
      note: string;
    };
    expect(body.requestId).toBe("tr1"); // the agent's newest request, the way the context route names it
    expect(body.nodeId).toBe("s9/main");
    expect(body.model).toBe("glm-5.3");
    expect(body.messages.map((m) => [m.role, m.requestId, m.preview])).toEqual([
      ["user", "tr0", "fix the bug"],
      ["assistant", "tr0", "on it"],
      ["user", "tr1", "clean tree"],
      ["assistant", "tr1", "nothing to fix"], // the newest answer is in, where the context view stops
    ]);
    expect(body.totals.messages).toBe(4);
    expect(body.next).toBeNull();
    expect(body.note).toBe("System prompt and tool definitions are not in the transcript.");
  });

  it("keeps a subagent's transcript to its own requests", async () => {
    history = await seeded();
    history.putContent("r2", {
      input: JSON.stringify([{ type: "text", text: "dig here" }]),
      output: JSON.stringify([{ type: "text", text: "found it" }]),
    });
    const body = hget("/api/history/agent/s1/a1/transcript").body as {
      nodeId: string;
      model: string;
      messages: Array<{ role: string; requestId: string }>;
    };
    expect(body.nodeId).toBe("s1/a1");
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.messages.map((m) => [m.role, m.requestId])).toEqual([
      ["user", "r2"],
      ["assistant", "r2"],
    ]);
    // the main agent's request never bleeds into the subagent's transcript
    expect(hget("/api/history/agent/s1/a2/transcript").body).toMatchObject({ messages: [] });
  });

  it("answers an empty page for a known agent with nothing stored, 404s the unknown ones", async () => {
    history = await seeded();
    // the seeded job node exists but carries no request rows
    expect(hget("/api/history/agent/job:s3/transcript")).toMatchObject({
      status: 200,
      body: {
        requestId: "",
        nodeId: "job:s3",
        messages: [],
        next: null,
        totals: { messages: 0, usage: null },
      },
    });
    expect(hget("/api/history/agent/nope/transcript")).toMatchObject({
      status: 404,
      body: { error: "unknown agent: nope" },
    });
    expect(hget("/api/history/agent//transcript")).toMatchObject({
      status: 404,
      body: { error: "missing agent id" },
    });
  });

  it("pages the transcript backwards with the context route's cursor", async () => {
    history = await seeded();
    await transcribed();
    const first = hget("/api/history/agent/s9/main/transcript?limit=1").body as {
      messages: Array<{ requestId: string; role: string }>;
      next: string | null;
    };
    expect(first.messages.map((m) => [m.requestId, m.role])).toEqual([["tr1", "assistant"]]);
    expect(first.next).toBe(`${now - 120_000}:tr1:1`);
    const second = hget(
      `/api/history/agent/s9/main/transcript?limit=1&cursor=${encodeURIComponent(first.next ?? "")}`,
    ).body as { messages: Array<{ requestId: string; role: string }>; next: string | null };
    expect(second.messages.map((m) => [m.requestId, m.role])).toEqual([["tr1", "user"]]);
    const third = hget(
      `/api/history/agent/s9/main/transcript?limit=1&cursor=${encodeURIComponent(second.next ?? "")}`,
    ).body as { messages: Array<{ requestId: string; role: string }>; next: string | null };
    expect(third.messages.map((m) => [m.requestId, m.role])).toEqual([["tr0", "assistant"]]);
    const fourth = hget(
      `/api/history/agent/s9/main/transcript?limit=1&cursor=${encodeURIComponent(third.next ?? "")}`,
    ).body as { messages: Array<{ requestId: string; role: string }>; next: string | null };
    expect(fourth.messages.map((m) => [m.requestId, m.role])).toEqual([["tr0", "user"]]);
    expect(fourth.next).toBeNull();
  });

  it("pages a long transcript past requests with nothing stored, route ids with colons included", async () => {
    history = await seeded();
    history.upsertNode(node({ id: "long/main", sessionId: "long", lastAt: now - MINUTE }));
    // 40 requests, only every eighth with content: a page reads past the empty ones to fill itself
    for (let i = 0; i < 40; i += 1) {
      const id = `route:long:main:glm-5.3:${i}`;
      history.putRequest("long/main", req({ id, sessionId: "long", ts: now - (40 - i) * 1000 }));
      if (i % 8 === 0)
        history.putContent(id, {
          input: JSON.stringify([{ type: "text", text: `ask ${i}` }]),
          output: JSON.stringify([{ type: "text", text: `answer ${i}` }]),
        });
    }
    const seen: string[] = [];
    let cursor: string | null = "";
    for (let pages = 0; cursor !== null && pages < 20; pages += 1) {
      const path = `/api/history/agent/long%2Fmain/transcript?limit=3${cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const body = hget(path).body as {
        messages: Array<{ preview: string }>;
        next: string | null;
        totals: { messages: number };
      };
      expect(body.totals.messages).toBe(10);
      seen.unshift(...body.messages.map((m) => m.preview));
      cursor = body.next;
    }
    expect(seen).toEqual([0, 8, 16, 24, 32].flatMap((i) => [`ask ${i}`, `answer ${i}`]));
  });

  it("rejects a bad transcript cursor like the context route", async () => {
    history = await seeded();
    expect(hget(`/api/history/agent/s9/main/transcript?cursor=not-a-cursor`)).toMatchObject({ status: 400 });
  });

  it("lists the repos trees ran in with root counts", async () => {
    history = await seeded();
    // roots are main sessions: the unattached job in /w/other is not a root of its own any more
    expect(hget("/api/history/repos").body).toEqual({
      repos: [
        { repo: "/w/main", roots: 1 },
        { repo: "/w/other", roots: 1 },
      ],
    });
  });

  it("reports stats with the retention setting, and honors a new one", async () => {
    history = await seeded();
    const insights = insightsOf();
    const stats = hget("/api/history/stats", insights).body as {
      bytes: number;
      nodes: number;
      requests: number;
      roots: number;
      retentionDays: number;
    };
    expect(stats).toMatchObject({
      nodes: 6,
      requests: 4,
      roots: 1, // s2/main: the one ended main tree; the unattached job is no root of its own
      retentionDays: DEFAULT_SETTINGS.historyRetentionDays,
    });
    expect(stats.bytes).toBeGreaterThan(0);
    expect(handleWrite(insights, "PUT", "/api/settings", { historyRetentionDays: 7 }).status).toBe(200);
    expect((hget("/api/history/stats", insights).body as { retentionDays: number }).retentionDays).toBe(7);
    expect(handleWrite(insights, "PUT", "/api/settings", { historyRetentionDays: 14 }).status).toBe(400);
    insights.stop();
  });

  it("clears history through the write route, 503s without one, 405s other methods", async () => {
    history = await seeded();
    const insights = insightsOf();
    expect(handleWrite(insights, "POST", "/api/history/clear", {}, history)).toEqual({
      status: 200,
      body: { cleared: true },
    });
    expect(hget("/api/history/stats").body).toMatchObject({ nodes: 0, requests: 0 });
    expect(handleWrite(insights, "POST", "/api/history/clear", {}, null)).toEqual({
      status: 503,
      body: { error: "history unavailable" },
    });
    expect(handleWrite(insights, "DELETE", "/api/history/clear", {}, history).status).toBe(405);
    insights.stop();
  });

  it("prunes past the retention at startup and on the hour beat, forever when 0", async () => {
    expect(retentionCutoff(7, 1_000_000_000)).toBe(1_000_000_000 - 7 * DAY_MS);
    expect(retentionCutoff(0, 1_000_000_000)).toBeNull();
    expect(retentionCutoff(-3, 1_000_000_000)).toBeNull();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000_000_000);
      const base = Date.now();
      const h = await openHistory(join(dir, "prune.db"));
      const env = makeEnv().env;
      writeSettings(env, { notifications: true, historyRetentionDays: 7 });
      h.upsertNode(node({ id: "old/main", sessionId: "old", lastAt: base - 40 * DAY_MS }));
      h.upsertNode(node({ id: "fresh/main", sessionId: "fresh", lastAt: base }));
      const schedule = schedulePrunes(h, env, { intervalMs: PRUNE_INTERVAL_MS });
      expect(allTreeIds(h)).toEqual(["fresh/main"]); // pruned once, at startup
      h.upsertNode(node({ id: "late/main", sessionId: "late", lastAt: base - 40 * DAY_MS }));
      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
      expect(allTreeIds(h)).toEqual(["fresh/main"]); // the hourly beat caught it
      schedule.stop();
      h.upsertNode(node({ id: "late2/main", sessionId: "late2", lastAt: base - 40 * DAY_MS }));
      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
      expect(allTreeIds(h)).toEqual(["fresh/main", "late2/main"]); // stopped: nothing prunes any more
      h.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps everything when retention is 0", async () => {
    const h = await openHistory(join(dir, "forever.db"));
    const env = makeEnv().env;
    writeSettings(env, { notifications: true, historyRetentionDays: 0 });
    h.upsertNode(node({ id: "old/main", sessionId: "old", lastAt: Date.now() - 400 * DAY_MS }));
    expect(pruneOnce(h, env, Date.now())).toBe(0);
    expect(rootIdsOf(h, "history")).toEqual(["old/main"]);
    h.close();
  });
});
