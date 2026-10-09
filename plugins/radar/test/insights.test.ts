import { readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetStatusPath, budgetsPath } from "../src/budget/budgets.ts";
import {
  apiErrorStatus,
  feedTranscriptLine,
  newTranscriptState,
  toolInputKey,
} from "../src/ingest/transcript.ts";
import { interruptLine, routeFailure, startWatcher } from "../src/ingest/watch.ts";
import { isRouterEventLine, parseRouterEvent, routerHealth } from "../src/router/health.ts";
import { createHttpServer, writeAllowed } from "../src/server/http.ts";
import { createInsights } from "../src/server/insights.ts";
import { escapeLabel, providerSlug, renderMetrics } from "../src/server/metrics.ts";
import { type AppInfo, handleApi, handleWrite } from "../src/server/routes.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import { createStore } from "../src/store/store.ts";
import { iso, jsonl, makeEnv, makeRequest, makeTool, writeText } from "./helpers.ts";

const NOW = Date.now();
const M = { ...ZERO_TOKENS, input: 1_000_000 };
const OUT = { ...ZERO_TOKENS, output: 1_000_000 };
const INFO: AppInfo = { version: "0.0.1", startedAt: 1, port: 1 };

describe("router health", () => {
  it("reads both naming conventions and refuses lines that are not health events", () => {
    const routerLine = {
      ts: iso(NOW),
      kind: "router.event",
      event: "fallback",
      plugin: "zai",
      reason: "503",
      model: null,
    };
    expect(isRouterEventLine(routerLine)).toBe(true);
    expect(parseRouterEvent(routerLine)).toEqual({
      ts: NOW,
      plugin: "zai",
      event: "fallback",
      reason: "503",
      model: null,
    });
    expect(
      parseRouterEvent({
        ts: iso(NOW),
        event: "router.event",
        type: "restart",
        plugin: "kimi",
        model: "kimi-k3",
      }),
    ).toMatchObject({ event: "restart", reason: "", model: "kimi-k3" });
    expect(parseRouterEvent({ ts: iso(NOW), event: "Stop" })).toBeNull();
    expect(parseRouterEvent({ ts: iso(NOW), kind: "router.event", event: "oops", plugin: "zai" })).toBeNull();
    expect(
      parseRouterEvent({ ts: "never", kind: "router.event", event: "refusal", plugin: "zai" }),
    ).toBeNull();
    expect(parseRouterEvent({ ts: iso(NOW), kind: "router.event", event: "refusal", plugin: "" })).toBeNull();
    const numeric = {
      ts: NOW,
      kind: "router.event",
      event: "refusal",
      plugin: "zai",
    } as unknown as Parameters<typeof parseRouterEvent>[0];
    expect(parseRouterEvent(numeric)?.ts).toBe(NOW);
  });

  it("buckets events per provider over 24 hours, busiest first", () => {
    const events = [
      { ts: NOW - 1000, plugin: "zai", event: "fallback" as const, reason: "a", model: null },
      { ts: NOW - 2000, plugin: "zai", event: "rate_limited" as const, reason: "", model: null },
      { ts: NOW - 3 * 3_600_000, plugin: "kimi", event: "restart" as const, reason: "up", model: null },
      { ts: NOW - 30 * 3_600_000, plugin: "kimi", event: "restart" as const, reason: "old", model: null },
    ];
    const health = routerHealth(events, NOW);
    expect(health.providers.map((p) => p.plugin)).toEqual(["zai", "kimi"]);
    expect(health.providers[0]?.counts).toMatchObject({ fallback: 1, rate_limited: 1, refusal: 0 });
    expect(health.providers[0]?.series[23]).toBe(2);
    expect(health.providers[0]?.lastReason).toBe("a");
    expect(health.providers[1]?.lastReason).toBe("up");
    expect(health.recent).toHaveLength(3);
  });
});

describe("ingest additions", () => {
  it("hashes tool inputs and reads API error statuses", () => {
    expect(toolInputKey("Bash", { command: "ls" })).toBe(toolInputKey("Bash", { command: "ls" }));
    expect(toolInputKey("Bash", { command: "ls" })).not.toBe(toolInputKey("Read", { command: "ls" }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolInputKey("X", cyclic)).toMatch(/^[0-9a-f]{8}$/);
    expect(apiErrorStatus("API Error: 529 overloaded")).toBe(529);
    expect(apiErrorStatus("API Error: 400 bad")).toBeNull();
    expect(apiErrorStatus("fine")).toBeNull();
  });

  it("turns transcript errors, retries and interruptions into records, not requests", () => {
    const state = newTranscriptState();
    const file = { sessionId: "s1", agentId: null, kind: "main" as const };
    const failed = feedTranscriptLine(
      state,
      file,
      JSON.stringify({
        type: "assistant",
        timestamp: iso(NOW),
        isApiErrorMessage: true,
        message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 429 slow down" }] },
      }),
    );
    expect(failed.requests).toEqual([]);
    expect(failed.apiErrors).toEqual([
      { ts: NOW, sessionId: "s1", agentId: "main", status: 429, source: "transcript", plugin: null },
    ]);
    const retry = feedTranscriptLine(
      state,
      file,
      JSON.stringify({ type: "system", subtype: "api_error", timestamp: iso(NOW), error: { status: 503 } }),
    );
    expect(retry.apiErrors[0]?.status).toBe(503);
    const plain = feedTranscriptLine(
      state,
      file,
      JSON.stringify({ type: "system", subtype: "api_error", timestamp: iso(NOW), status: 401 }),
    );
    expect(plain.apiErrors).toEqual([]);
    const stop = feedTranscriptLine(
      state,
      file,
      JSON.stringify({
        type: "user",
        timestamp: iso(NOW),
        message: { content: "[Request interrupted by user]" },
      }),
    );
    expect(stop.interrupts).toEqual([{ sessionId: "s1", agentId: "main", ts: NOW }]);
    const toolStop = feedTranscriptLine(
      state,
      file,
      JSON.stringify({
        type: "user",
        timestamp: iso(NOW),
        message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
      }),
    );
    expect(toolStop.interrupts).toHaveLength(1);
  });

  it("reads route failures and interruption lines", () => {
    expect(routeFailure({ ts: iso(NOW), event: "route", status: "200" }, NOW)).toBeNull();
    expect(
      routeFailure(
        { ts: iso(NOW), event: "route", status: 529, plugin: "zai", session_id: "s", agent_id: "a" } as never,
        NOW,
      ),
    ).toEqual({ ts: NOW, sessionId: "s", agentId: "a", status: 529, source: "route", plugin: "zai" });
    expect(routeFailure({ ts: iso(NOW), event: "route", status: "429", model: "kimi-k3" }, NOW)?.plugin).toBe(
      "kimi",
    );
    expect(routeFailure({ ts: iso(NOW), event: "route", status: "429" }, NOW)?.plugin).toBeNull();
    expect(interruptLine({ sessionId: "s", agentId: "w1", ts: NOW })).toMatchObject({
      event: "Interrupted",
      session_id: "s",
      agent_id: "w1",
    });
    expect(interruptLine({ sessionId: "s", agentId: "main", ts: NOW }).agent_id).toBeUndefined();
  });

  it("feeds router events, route failures, transcript errors and interruptions into the store", () => {
    const { env, state, config } = makeEnv();
    const today = new Date(NOW).toISOString().slice(0, 10);
    writeText(
      join(state, "spool", `${today}.jsonl`),
      jsonl([
        {
          ts: NOW,
          kind: "router.event",
          event: "rate_limited",
          plugin: "zai",
          reason: "429",
          model: "glm-5.3",
        },
        { ts: iso(NOW), kind: "router.event", event: "restart", plugin: "zai", reason: "", model: null },
        { ts: iso(NOW), event: "router.event", plugin: "zai" },
        { ts: iso(NOW), event: "route", plugin: "zai", status: 503, model: "glm-5.3", session_id: "s9" },
      ]),
    );
    writeText(
      join(config, "projects", "-p", "s1.jsonl"),
      jsonl([
        {
          type: "system",
          subtype: "api_error",
          timestamp: iso(NOW),
          sessionId: "s1",
          error: { status: 529 },
        },
        {
          type: "user",
          timestamp: iso(NOW),
          sessionId: "s1",
          message: { content: "[Request interrupted by user]" },
        },
      ]),
    );
    const store = createStore();
    const watcher = startWatcher({ env, store, sinceMs: 3_600_000, intervalMs: 60_000 });
    watcher.stop();
    expect(store.routerEvents().map((e) => e.event)).toEqual(["rate_limited", "restart"]);
    expect(
      store
        .apiErrors()
        .map((e) => [e.source, e.status])
        .sort(),
    ).toEqual([
      ["route", 503],
      ["router", 429],
      ["transcript", 529],
    ]);
    expect(store.events({}).map((e) => e.kind)).toContain("Interrupted");
  });
});

describe("metrics", () => {
  it("escapes labels and names providers", () => {
    expect(escapeLabel('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(providerSlug("glm-5.3")).toBe("zai");
    expect(providerSlug("claude-opus-5")).toBe("anthropic");
    expect(providerSlug("gpt")).toBe("other");
  });

  it("renders every family in the text format", () => {
    const text = renderMetrics({
      version: "1.2.3",
      ledger: [
        { id: "a", ts: 1, model: "glm-5.3", sessionId: "s1", agentId: "main", tokens: M },
        { id: "b", ts: 2, model: "claude-x", sessionId: "s2", agentId: "main", tokens: M },
      ],
      names: {
        sessions: { s1: { project: 'my "app"', title: null, repo: null, parentSessionId: null, name: null } },
        agents: {},
      },
      requests: [
        makeRequest({ latencyMs: 700 }),
        makeRequest({ id: "r2", latencyMs: null }),
        makeRequest({ id: "r4", model: "glm-5.3", latencyMs: 400_000 }),
      ],
      tools: [makeTool(), makeTool({ id: "t2", ok: false })],
      apiErrors: [{ ts: 1, sessionId: null, agentId: null, status: 429, source: "router", plugin: "zai" }],
      routerEvents: [{ ts: 1, plugin: "zai", event: "fallback", reason: "", model: null }],
      alerts: [],
      sessions: [{ live: true }, { live: false }],
      budgets: [
        {
          id: "b1",
          spentUsd: 1.5,
          limitUsd: 10,
          pct: 15,
          scope: "total",
          period: "day",
          action: "warn",
          periodStart: 0,
        },
      ],
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('radar_info{version="1.2.3"} 1');
    expect(text).toContain('radar_requests_total{model="glm-5.3",provider="zai",project="my \\"app\\""} 1');
    expect(text).toContain('radar_cost_usd_total{model="glm-5.3",provider="zai",project="my \\"app\\""} 1.4');
    expect(text).not.toContain('radar_cost_usd_total{model="claude-x"');
    expect(text).toContain('radar_request_latency_seconds_bucket{provider="anthropic",le="1"} 1');
    expect(text).toContain('radar_request_latency_seconds_bucket{provider="zai",le="+Inf"} 1');
    expect(text).toContain('radar_request_latency_seconds_count{provider="zai"} 1');
    expect(text).toContain('radar_tool_calls_total{tool="Bash",result="error"} 1');
    expect(text).toContain('radar_api_errors_total{status="429",source="router"} 1');
    expect(text).toContain('radar_router_events_total{provider="zai",event="fallback"} 1');
    expect(text).toContain('radar_sessions{state="ended"} 1');
    expect(text).toContain('radar_alerts{kind="stuck"} 0');
    expect(text).toContain('radar_budget_spent_usd{budget="b1",scope="total",period="day"} 1.5');
    expect(text).toMatch(/# TYPE radar_request_latency_seconds histogram/);
  });
});

function seededInsights() {
  const { env } = makeEnv();
  const store = createStore();
  store.upsertSession({ id: "s1", cwd: "/w/app" });
  store.addRequest(makeRequest({ id: "r1", ts: NOW - 1000, model: "glm-5.3", tokens: OUT }));
  store.addRequest(makeRequest({ id: "r2", ts: NOW - 2000, agentId: "w1", model: "glm-5.3", tokens: OUT }));
  store.upsertAgent({ sessionId: "s1", id: "w1", name: "explorer" });
  const calls: string[][] = [];
  const insights = createInsights({
    env,
    store,
    tickMs: 0,
    runner: (command, args) => calls.push([command, ...args]),
  });
  return { env, store, insights, calls };
}

describe("insights", () => {
  it("feeds the ledger from the store, before and after it starts", () => {
    const { store, insights } = seededInsights();
    store.addRequest(
      makeRequest({ id: "r3", ts: NOW, model: "kimi-k3", tokens: { ...ZERO_TOKENS, input: 1000 } }),
    );
    expect(
      insights.ledger
        .rows(0)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["r1", "r2", "r3"]);
    expect(insights.spendToday()).toBeCloseTo(8.803);
    expect(insights.providers()).toEqual(expect.arrayContaining(["zai", "kimi", "qwen"]));
    expect(insights.attribution("agent", "day").map((r) => r.label)).toEqual([
      "main · app · s1",
      "explorer · app · s1",
    ]);
    insights.stop();
  });

  it("saves budgets and settings, rejecting bad input, and writes the status file", () => {
    const { env, insights } = seededInsights();
    expect(insights.setBudgets({ budgets: [{ id: "x" }] })).toMatch(/scope/);
    const saved = insights.setBudgets({
      budgets: [{ id: "z", scope: "provider:zai", period: "day", limitUsd: 2, action: "stop" }],
    });
    expect(saved).toHaveLength(1);
    expect(JSON.parse(readFileSync(budgetsPath(env), "utf8")).budgets).toHaveLength(1);
    const status = JSON.parse(readFileSync(budgetStatusPath(env), "utf8"));
    expect(status).toMatchObject({ stopped: ["provider:zai"], spend: [{ id: "z", pct: 440 }] });
    expect(insights.budgetStatus().stopped).toEqual(["provider:zai"]);
    expect(insights.alerts().map((a) => a.kind)).toEqual(["budget"]);
    expect(insights.setSettings({ notifications: "x" })).toMatch(/true or false/);
    expect(insights.setSettings({ notifications: false })).toEqual({
      notifications: false,
      historyRetentionDays: 30,
    });
    expect(insights.settings()).toEqual({ notifications: false, historyRetentionDays: 30 });
    insights.stop();
  });

  it("dismisses alerts by id and notifies new ones on a tick", () => {
    const { insights, calls } = seededInsights();
    insights.setBudgets({
      budgets: [{ id: "t", scope: "total", period: "month", limitUsd: 1, action: "warn" }],
    });
    const [alert] = insights.alerts();
    expect(alert?.kind).toBe("budget");
    insights.tick();
    expect(calls.length).toBe(process.platform === "darwin" ? 1 : calls.length);
    expect(insights.dismiss("")).toBe(false);
    expect(insights.dismiss(alert?.id ?? "")).toBe(true);
    expect(insights.alerts()).toEqual([]);
    expect(insights.routerHealth().providers).toEqual([]);
    expect(insights.advisor().runsChecked).toBe(1);
    expect(insights.metrics("9")).toContain('project="app"');
    insights.stop();
  });

  it("answers the new routes and writes through handleApi and handleWrite", () => {
    const { store, insights } = seededInsights();
    const get = (path: string, query = "") =>
      handleApi(store, INFO, { path, query: new URLSearchParams(query) }, insights);
    expect(get("/api/alerts").body).toEqual({ alerts: [] });
    expect(get("/api/attribution", "by=model&range=month")).toMatchObject({
      status: 200,
      body: { by: "model", range: "month", rows: [{ key: "glm-5.3" }] },
    });
    expect(get("/api/attribution")).toMatchObject({ status: 200, body: { by: "repo", range: "day" } });
    expect(get("/api/attribution", "by=tree&range=day")).toMatchObject({
      status: 200,
      body: { by: "tree", range: "day", tree: [{ kind: "repo", key: "app", requests: 2 }] },
    });
    expect(get("/api/attribution", "by=nope").status).toBe(400);
    expect(get("/api/attribution", "range=year").status).toBe(400);
    expect(get("/api/budgets").body).toMatchObject({ budgets: [] });
    expect(get("/api/budget-status").body).toMatchObject({ version: 1, stopped: [] });
    expect(get("/api/spend").body).toMatchObject({ pricesRetrieved: expect.any(String) });
    expect(get("/api/settings").body).toEqual({
      settings: { notifications: true, historyRetentionDays: 30 },
    });
    expect(get("/api/router").body).toMatchObject({ providers: [] });
    expect(get("/api/advisor").body).toMatchObject({ runsChecked: 1 });
    expect(handleApi(store, INFO, { path: "/api/alerts", query: new URLSearchParams() }).status).toBe(404);
    expect(handleWrite(undefined, "PUT", "/api/budgets", {}).status).toBe(503);
    expect(handleWrite(insights, "PUT", "/api/budgets", { budgets: [] })).toEqual({
      status: 200,
      body: { budgets: [] },
    });
    expect(handleWrite(insights, "PUT", "/api/budgets", { budgets: "x" }).status).toBe(400);
    expect(handleWrite(insights, "PUT", "/api/settings", { notifications: false }).status).toBe(200);
    expect(handleWrite(insights, "POST", "/api/alerts/dismiss", { id: "a" }).body).toEqual({
      dismissed: "a",
    });
    expect(handleWrite(insights, "POST", "/api/alerts/dismiss", { id: 3 }).status).toBe(400);
    expect(handleWrite(insights, "POST", "/api/alerts/dismiss", null).status).toBe(400);
    expect(handleWrite(insights, "DELETE", "/api/budgets", {}).status).toBe(405);
    insights.stop();
  });

  it("serves advisor and metrics from a version-keyed cache, not a store copy per call", () => {
    const { env, store } = seededInsights();
    let rawCalls = 0;
    const counted = {
      ...store,
      raw: () => {
        rawCalls += 1;
        return store.raw();
      },
    } as typeof store;
    const cached = createInsights({ env, store: counted, tickMs: 0 });
    const before = rawCalls; // the one call the start-up tick made
    cached.advisor();
    cached.advisor();
    expect(rawCalls).toBe(before + 1);
    const text = cached.metrics("0.0.1");
    cached.metrics("0.0.1");
    // the alerts the text folds in come from their own cache, so one build is one copy of the store
    expect(rawCalls).toBe(before + 2);
    expect(cached.metrics("0.0.1")).toBe(text);
    expect(rawCalls).toBe(before + 2);
    store.addRequest(makeRequest({ id: "r9", ts: NOW, model: "kimi-k3", tokens: OUT }));
    cached.advisor();
    expect(rawCalls).toBe(before + 3); // the version moved: the answer builds once, then holds again
    cached.stop();
  });

  it("rebuilds the metrics text when the budgets change, not only when the store does", () => {
    const { env, store } = seededInsights();
    let rawCalls = 0;
    const counted = {
      ...store,
      raw: () => {
        rawCalls += 1;
        return store.raw();
      },
    } as typeof store;
    const cached = createInsights({ env, store: counted, tickMs: 0 });
    const before = rawCalls;
    const first = cached.metrics("0.0.1");
    cached.setBudgets({
      budgets: [{ id: "z", scope: "provider:zai", period: "day", limitUsd: 2, action: "warn" }],
    });
    expect(cached.metrics("0.0.1")).not.toBe(first);
    expect(rawCalls).toBe(before + 3);
    cached.stop();
  });
});

type Reply = { status: number; body: string; type: string };

function call(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
) {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: text, type: String(res.headers["content-type"]) }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("http writes and /metrics", () => {
  it("only lets JSON from our own origin through", () => {
    expect(writeAllowed({ "content-type": "application/json" }, 5)).toBe(true);
    expect(writeAllowed({ "content-type": "text/plain" }, 5)).toBe(false);
    expect(writeAllowed({}, 5)).toBe(false);
    expect(writeAllowed({ "content-type": "application/json", origin: "http://evil.test" }, 5)).toBe(false);
    expect(writeAllowed({ "content-type": "application/json", origin: "http://localhost:5" }, 5)).toBe(true);
    expect(writeAllowed({ "content-type": "application/json", "sec-fetch-site": "cross-site" }, 5)).toBe(
      false,
    );
    expect(writeAllowed({ "content-type": "application/json", "sec-fetch-site": "same-origin" }, 5)).toBe(
      true,
    );
  });

  it("serves writes and metrics over real loopback http", async () => {
    const { store, insights } = seededInsights();
    const { server, state } = createHttpServer({ store, version: "0.0.1", startedAt: 1, insights });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    state.port = port;
    const json = { "Content-Type": "application/json" };
    try {
      const budgets = JSON.stringify({
        budgets: [{ id: "a", scope: "total", period: "week", limitUsd: 3, action: "warn" }],
      });
      expect((await call(port, "PUT", "/api/budgets", budgets, json)).status).toBe(200);
      expect(insights.budgets()).toHaveLength(1);
      expect(
        (await call(port, "PUT", "/api/budgets", budgets, { "Content-Type": "text/plain" })).status,
      ).toBe(403);
      expect(
        (await call(port, "PUT", "/api/budgets", budgets, { ...json, Origin: "http://evil.test" })).status,
      ).toBe(403);
      expect((await call(port, "POST", "/api/budgets", budgets, json)).status).toBe(405);
      expect((await call(port, "PUT", "/api/summary", "{}", json)).status).toBe(405);
      expect((await call(port, "PUT", "/api/settings", "{nope", json)).status).toBe(400);
      expect((await call(port, "PUT", "/api/settings", "x".repeat(70_000), json)).status).toBe(413);
      const dismissed = await call(port, "POST", "/api/alerts/dismiss", '{"id":"k"}', json);
      expect(JSON.parse(dismissed.body)).toEqual({ dismissed: "k" });
      const metrics = await call(port, "GET", "/metrics");
      expect(metrics.status).toBe(200);
      expect(metrics.type).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(metrics.body).toContain("radar_requests_total");
      expect((await call(port, "HEAD", "/metrics")).body).toBe("");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      insights.stop();
    }
  });

  it("answers 500 when a save fails and an empty /metrics without insights", async () => {
    const { store, insights } = seededInsights();
    const broken = {
      ...insights,
      setSettings: () => {
        throw new Error("disk full");
      },
    };
    const { server, state } = createHttpServer({ store, version: "0.0.1", startedAt: 1, insights: broken });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    state.port = port;
    const bare = createHttpServer({ store, version: "0.0.1", startedAt: 1 });
    await new Promise<void>((resolve) => bare.server.listen(0, "127.0.0.1", resolve));
    const bareAddress = bare.server.address();
    const barePort = typeof bareAddress === "object" && bareAddress !== null ? bareAddress.port : 0;
    bare.state.port = barePort;
    try {
      const reply = await call(port, "PUT", "/api/settings", "{}", { "Content-Type": "application/json" });
      expect(reply.status).toBe(500);
      expect(reply.body).toContain("disk full");
      expect((await call(barePort, "GET", "/metrics")).body).toBe("");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => bare.server.close(() => resolve()));
      insights.stop();
    }
  });
});
