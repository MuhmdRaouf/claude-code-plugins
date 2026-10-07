import { describe, expect, it } from "vitest";
import { type ApiResponse, type AppInfo, handleApi, ROUTES } from "../src/server/routes.ts";
import { createStore, type Store } from "../src/store/store.ts";
import { iso, makeRequest, makeTool } from "./helpers.ts";

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
