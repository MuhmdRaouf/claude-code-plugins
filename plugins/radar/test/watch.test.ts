import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { openHistory } from "../src/history/history.ts";
import { attachHistoryWriter } from "../src/history/writer.ts";
import { loopbackHost, startWatcher } from "../src/ingest/watch.ts";
import { OUTSIDE_SESSION, type SpoolLine } from "../src/shared/model.ts";
import { spoolDir } from "../src/shared/paths.ts";
import { DEFAULT_UPSTREAM } from "../src/shared/provider.ts";
import { createStore, type Store } from "../src/store/store.ts";
import { appendText, iso, jsonl, makeEnv, type TestEnv, waitFor, writeText } from "./helpers.ts";

const NOW = new Date("2026-01-15T06:30:00.000Z");
const T0 = NOW.getTime();
const T1 = T0 + 1_000;
const DAY = 86_400_000;

function spoolPath(env: NodeJS.ProcessEnv): string {
  return join(spoolDir(env), "2026-01-15.jsonl");
}

function todaySpool(env: NodeJS.ProcessEnv): string {
  return join(spoolDir(env), `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function userLine(ts: number): Record<string, unknown> {
  return { type: "user", timestamp: iso(ts), cwd: "/w/app", version: "2.0.0", message: { content: "go" } };
}

function assistantLine(ts: number, requestId: string, model = "claude-sonnet-5-5"): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: iso(ts),
    requestId,
    message: {
      model,
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
      content: [],
    },
  };
}

/** A watcher whose interval never fires; the clock moves only when the test ticks it. */
function manualWatcher(env: NodeJS.ProcessEnv, store: Store): { tick(advanceMs: number): void } {
  let clock = T0;
  const watcher = startWatcher({
    env,
    store,
    sinceMs: DAY,
    intervalMs: 3_600_000,
    rescanMs: 5_000,
    now: () => clock,
  });
  return {
    tick(advanceMs: number): void {
      clock += advanceMs;
      watcher.pollOnce();
    },
  };
}

describe("spool ingestion", () => {
  it("replays the spool on start and picks up only new lines on later polls", () => {
    const { env } = makeEnv();
    const path = writeText(
      spoolPath(env),
      jsonl([
        { ts: iso(T0), event: "UserPromptSubmit", session_id: "s1", prompt: "a" },
        { ts: iso(T1), event: "Notification" },
      ]),
    );
    const store = createStore();
    const { tick } = manualWatcher(env, store);
    expect(store.events({ limit: 10 }).map((event) => event.kind)).toEqual([
      "Notification",
      "UserPromptSubmit",
    ]);
    expect(store.sessionList().map((session) => session.id)).toEqual(["s1"]);
    appendText(
      path,
      `${JSON.stringify({ ts: iso(T1), event: "Stop", session_id: "s1", reason: "end_turn" })}\n`,
    );
    tick(1_000);
    expect(store.events({ limit: 10 }).map((event) => event.kind)).toEqual([
      "Stop",
      "Notification",
      "UserPromptSubmit",
    ]);
  });

  it("turns route events into requests and drops malformed ones", () => {
    const { env } = makeEnv();
    writeText(
      spoolPath(env),
      jsonl([
        {
          ts: iso(T1),
          event: "route",
          session_id: "s9",
          model: "glm-5.3",
          upstream: "http://127.0.0.1:8787",
          status: "ok",
          latency_ms: 42,
          usage: {
            input_tokens: 3,
            output_tokens: 4,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 6,
          },
        },
        { ts: iso(T1), event: "route", session_id: "s9" },
        { ts: "nope", event: "route", session_id: "s9", model: "glm-5.3" },
        { ts: iso(T1), event: "route", model: "glm-5.3" },
        { ts: iso(T1), event: "route", session_id: "s10", model: "kimi-k2" },
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    const routed = store.requests({ session: "s9" });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      id: `route:s9::glm-5.3:${T1}:ok`,
      sessionId: "s9",
      agentId: "main",
      model: "glm-5.3",
      upstream: "http://127.0.0.1:8787",
      ts: T1,
      latencyMs: 42,
      stopReason: "ok",
      provider: "Z.ai",
      route: "router",
    });
    expect(routed[0]?.tokens).toEqual({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6 });
    expect(store.requests({ session: "s10" })[0]).toMatchObject({
      upstream: DEFAULT_UPSTREAM,
      latencyMs: null,
      stopReason: null,
    });
    // a router request no Claude Code session sent still counts, outside any session
    expect(store.requests({ session: OUTSIDE_SESSION })).toEqual([
      expect.objectContaining({ model: "glm-5.3", agentId: "main", provider: "Z.ai" }),
    ]);
    expect(store.events({ limit: 100 })).toEqual([]);
  });

  it("keeps the extra usage a route line carries: thinking tokens and billing conditions", () => {
    const { env } = makeEnv();
    writeText(
      spoolPath(env),
      jsonl([
        {
          ts: iso(T1),
          event: "route",
          session_id: "s9",
          model: "glm-5.3",
          upstream: "http://127.0.0.1:8787",
          route: "provider",
          status: 200,
          latency_ms: 42,
          usage: {
            input_tokens: 3,
            output_tokens: 400,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 6,
            cache_creation: { ephemeral_1h_input_tokens: 6, ephemeral_5m_input_tokens: 0 },
            output_tokens_details: { thinking_tokens: 120, rejected_tokens: 0 },
            speed: "fast",
            inference_geo: "us",
            service_tier: "priority",
          },
        },
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    expect(store.requests({ session: "s9" })[0]).toMatchObject({
      tokens: { input: 3, output: 400, cacheRead: 5, cacheWrite: 6, thinking: 120 },
      cacheWrite1h: 6,
      speed: "fast",
      geo: "us",
      serviceTier: "priority",
    });
  });

  it("carries a route line's error reason onto the failed request, and none onto a success", () => {
    const { env } = makeEnv();
    writeText(
      spoolPath(env),
      jsonl([
        {
          ts: iso(T1),
          event: "route",
          session_id: "s9",
          model: "glm-5.3",
          upstream: "http://127.0.0.1:8787",
          route: "provider",
          status: 502,
          error: "connection failed (ECONNREFUSED)",
          latency_ms: 12,
        },
        {
          ts: iso(T1),
          event: "route",
          session_id: "s9",
          model: "glm-5.3",
          upstream: "http://127.0.0.1:8787",
          route: "provider",
          status: 200,
          latency_ms: 12,
        },
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    const routed = store.requests({ session: "s9" });
    expect(routed.find((request) => request.stopReason === "502")).toMatchObject({
      error: "connection failed (ECONNREFUSED)",
    });
    expect(routed.find((request) => request.stopReason === null)?.error).toBeUndefined();
  });

  it("keeps same-millisecond completions of parallel subagents as separate records, under their parent", () => {
    const { env } = makeEnv();
    const route = (agent_id: string, parent_agent_id?: string): Record<string, unknown> => ({
      ts: iso(T1),
      event: "route",
      session_id: "s9",
      agent_id,
      ...(parent_agent_id === undefined ? {} : { parent_agent_id }),
      model: "glm-5.3",
      upstream: "http://127.0.0.1:8787",
      route: "provider",
      status: 200,
      latency_ms: 900,
    });
    writeText(spoolPath(env), jsonl([route("agent-w1", "a31cd"), route("agent-w2", "a31cd")]));
    const store = createStore();
    manualWatcher(env, store);
    const routed = store.requests({ session: "s9" });
    expect(routed).toHaveLength(2);
    expect(routed.map((request) => request.id).sort()).toEqual([
      `route:s9:agent-w1:glm-5.3:${T1}:200`,
      `route:s9:agent-w2:glm-5.3:${T1}:200`,
    ]);
    expect(routed.every((request) => request.parentAgentId === "a31cd")).toBe(true);
  });

  it("reads a success status as no stop reason and names an unknown model after its plugin", () => {
    const { env } = makeEnv();
    writeText(
      spoolPath(env),
      jsonl([
        {
          ts: iso(T1),
          event: "route",
          plugin: "kimi",
          route: "provider",
          model: "moonshot-preview",
          upstream: "api.moonshot.ai",
          status: 200,
          agent_id: "a7",
          session_id: "s1",
        },
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    expect(store.requests({})).toEqual([
      expect.objectContaining({ agentId: "a7", provider: "Kimi", stopReason: null, route: "provider" }),
    ]);
  });

  it("links a route line's prompt hash and headers, and stores each capture once in the history", async () => {
    const { env, home } = makeEnv();
    const hash = "a".repeat(64);
    const gz = gzipSync(
      Buffer.from(JSON.stringify({ system: "be brief", tools: [{ name: "Bash" }] })),
    ).toString("base64");
    const route = {
      ts: iso(T1),
      event: "route",
      session_id: "s9",
      model: "glm-5.3",
      upstream: "http://127.0.0.1:8787",
      route: "provider",
      status: 200,
      latency_ms: 42,
      prompt_hash: hash,
      headers: { "request-id": "req_1", "retry-after": "7", "set-cookie": "nope" },
    };
    writeText(
      spoolPath(env),
      jsonl([
        { ...route, ts: iso(T0) },
        { ts: iso(T0), event: "capture", plugin: "zai", prompt_hash: hash, gz },
      ]),
    );
    const store = createStore();
    const history = await openHistory(join(home, "history.db"));
    const writer = attachHistoryWriter({ store, history });
    const { tick } = manualWatcher(env, store);

    // the request carries the hash and only the allow-listed headers its line named
    const routed = store.requests({ session: "s9" })[0];
    expect(routed?.promptHash).toBe(hash);
    expect(routed?.headers).toEqual({ "request-id": "req_1", "retry-after": "7" });
    writer.flush();
    const capture = history.capture(routed?.id ?? "");
    expect(capture).toMatchObject({
      hash,
      system: "be brief",
      bytes: Buffer.byteLength(JSON.stringify({ system: "be brief", tools: [{ name: "Bash" }] })),
      headers: { "request-id": "req_1", "retry-after": "7" },
    });
    expect(capture?.tools).toEqual([{ name: "Bash" }]);

    // the same capture line again (a second router saw the prompt, say) keeps the first row as it was
    appendText(
      spoolPath(env),
      `${JSON.stringify({ ts: iso(T1), event: "capture", plugin: "zai", prompt_hash: hash, gz })}\n`,
    );
    tick(1_000);
    writer.flush();
    expect(history.capture(routed?.id ?? "")?.hash).toBe(hash);

    // a request whose route line named no hash has no capture to read
    expect(history.capture("route:nowhere")).toBeNull();
    history.close();
  });
});

describe("transcripts", () => {
  it("discovers recent project files, honours the since window and tails spool-referenced paths", () => {
    const { env, home, config } = makeEnv();
    const projects = join(config, "projects", "-w-app");
    writeText(join(projects, "sess-a.jsonl"), jsonl([userLine(T0), assistantLine(T1, "req-a")]));
    const stale = writeText(join(projects, "stale.jsonl"), jsonl([assistantLine(T1, "req-stale")]));
    utimesSync(stale, new Date(T0 - 10 * DAY), new Date(T0 - 10 * DAY));
    const referenced = writeText(
      join(home, "elsewhere", "referenced.jsonl"),
      jsonl([assistantLine(T1, "req-ref")]),
    );
    utimesSync(referenced, new Date(T0 - 10 * DAY), new Date(T0 - 10 * DAY));
    writeText(
      spoolPath(env),
      jsonl([
        {
          ts: iso(T0),
          event: "SessionStart",
          session_id: "sess-a",
          source: "startup",
          base_url: "http://127.0.0.1:8787",
          transcript_path: referenced,
        },
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    const ids = store.requests({}).map((request) => request.id);
    expect(ids).toContain("req-a");
    expect(ids).toContain("req-ref"); // referenced paths bypass the mtime window
    expect(ids).not.toContain("req-stale"); // unreferenced stale ones do not
    expect(store.requests({}).find((request) => request.id === "req-a")).toMatchObject({
      sessionId: "sess-a",
      agentId: "main",
      model: "claude-sonnet-5-5",
      latencyMs: 1_000,
      upstream: DEFAULT_UPSTREAM, // the local router passes claude-* straight on to Anthropic
      via: "127.0.0.1:8787",
      provider: "Anthropic",
    });
    expect(store.requests({}).find((request) => request.id === "req-ref")).toMatchObject({
      sessionId: "referenced",
      upstream: DEFAULT_UPSTREAM, // no SessionStart taught us this session's base URL: Claude Code called Anthropic itself
    });
    expect(store.sessionDetail("sess-a")).toMatchObject({
      cwd: "/w/app",
      project: "app",
      ccVersion: "2.0.0",
    });
  });

  it("reads the walked transcripts newest-modified first, so a cold start is useful within seconds", () => {
    const { env, config } = makeEnv();
    const projects = join(config, "projects");
    const live = join(projects, "-w-live");
    const archive = join(projects, "-w-archive");
    const liveNow = writeText(join(live, "now.jsonl"), jsonl([assistantLine(T1, "req-now")]));
    const livePast = writeText(join(live, "past.jsonl"), jsonl([assistantLine(T1, "req-past")]));
    const cold = writeText(join(archive, "cold.jsonl"), jsonl([assistantLine(T1, "req-cold")]));
    const at = (agoMs: number): Date => new Date(T0 - agoMs);
    utimesSync(liveNow, at(60_000), at(60_000));
    utimesSync(livePast, at(2 * 3_600_000), at(2 * 3_600_000));
    utimesSync(cold, at(90_000), at(90_000));
    utimesSync(live, at(60_000), at(60_000)); // directories too: the fresh project is entered first
    utimesSync(archive, at(2 * 3_600_000), at(2 * 3_600_000));
    const store = createStore();
    const order: string[] = [];
    store.onUpdate((change) => order.push(...change.requests.map((request) => request.id)));
    manualWatcher(env, store);
    expect(order).toEqual(["req-now", "req-past", "req-cold"]);
  });

  it("gives each request the base URL in effect when it was made, not the session's latest", () => {
    const { env, config } = makeEnv();
    const projects = join(config, "projects", "-w-app");
    writeText(
      join(projects, "sess-r.jsonl"),
      jsonl([
        assistantLine(T0 - 60_000, "req-before"), // older than every hook report
        assistantLine(T0 + 1_000, "req-direct"),
        assistantLine(T0 + 61_000, "req-routed"),
      ]),
    );
    const hook = (ts: number, base_url: string) => ({
      ts: iso(ts),
      event: "UserPromptSubmit",
      session_id: "sess-r",
      base_url,
    });
    writeText(
      spoolPath(env),
      jsonl([
        hook(T0, "https://api.anthropic.com"),
        hook(T0 + 30_000, "https://api.anthropic.com"), // a repeat changes nothing
        hook(T0 + 60_000, "http://127.0.0.1:18787"), // the router was set up mid-session
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    const upstream = (id: string) => store.requests({}).find((request) => request.id === id)?.upstream;
    expect(upstream("req-before")).toBe(DEFAULT_UPSTREAM); // no base URL in effect yet: Claude Code called Anthropic itself
    expect(upstream("req-direct")).toBe("https://api.anthropic.com");
    expect(upstream("req-routed")).toBe(DEFAULT_UPSTREAM); // the local router passes claude-* straight on to Anthropic
    expect(store.requests({}).find((request) => request.id === "req-routed")?.via).toBe("127.0.0.1:18787");
  });

  it("finds new transcripts only on the rescan cadence, never mid-window", () => {
    const { env, config } = makeEnv();
    const projects = join(config, "projects", "p");
    writeText(join(projects, "a.jsonl"), jsonl([assistantLine(T1, "req-a")]));
    const store = createStore();
    const { tick } = manualWatcher(env, store);
    expect(store.requests({})).toHaveLength(1);
    writeText(join(projects, "b.jsonl"), jsonl([assistantLine(T1, "req-b")]));
    tick(1_000); // inside the 5s window: no rescan, no discovery
    expect(store.requests({}).map((request) => request.id)).toEqual(["req-a"]);
    tick(5_000); // past the window: rescan picks the new file up
    const ids = store.requests({}).map((request) => request.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("req-b");
  });
});

describe("a claude-* request whose enrichment names no upstream", () => {
  /** The store for one session `name` whose call went out at T1, the hook reporting `base_url` at T0. */
  function watched(env: TestEnv, name: string, model: string, base_url: string | null): Store {
    writeText(
      join(env.config, "projects", "-w-app", `${name}.jsonl`),
      jsonl([assistantLine(T1, `req-${name}`, model)]),
    );
    if (base_url !== null) {
      writeText(
        spoolPath(env.env),
        jsonl([{ ts: iso(T0), event: "UserPromptSubmit", session_id: name, base_url }]),
      );
    }
    const store = createStore();
    manualWatcher(env.env, store);
    return store;
  }

  it("went to Anthropic through the local router, which the request names as via", () => {
    const store = watched(makeEnv(), "s1", "claude-sonnet-5-5", "http://127.0.0.1:18787");
    const [request] = store.requests({});
    expect(request).toMatchObject({ upstream: DEFAULT_UPSTREAM, provider: "Anthropic" });
    expect(request?.via).toBe("127.0.0.1:18787");
  });

  it("went to Anthropic from Claude Code itself when there is no base URL at all", () => {
    const store = watched(makeEnv(), "s2", "claude-sonnet-5-5", null);
    const [request] = store.requests({});
    expect(request).toMatchObject({ upstream: DEFAULT_UPSTREAM, provider: "Anthropic" });
    expect(request?.via).toBeUndefined();
  });

  it("names a provider model after its own offering until a route line says where it went", () => {
    const store = watched(makeEnv(), "s3", "glm-5.3", "http://127.0.0.1:18787");
    const [request] = store.requests({});
    expect(request).toMatchObject({ upstream: "https://api.z.ai", provider: "Z.ai" });
    expect(request?.via).toBe("127.0.0.1:18787");
  });

  it("leaves a model no offering serves unnamed", () => {
    const store = watched(makeEnv(), "s5", "totally-unknown-model", "http://127.0.0.1:18787");
    const [request] = store.requests({});
    expect(request).toMatchObject({ upstream: "", provider: "other" });
    expect(request?.via).toBe("127.0.0.1:18787");
  });

  it("keeps an explicit https base URL as the upstream", () => {
    const store = watched(makeEnv(), "s4", "claude-sonnet-5-5", "https://proxy.example.com");
    const [request] = store.requests({});
    expect(request).toMatchObject({ upstream: "https://proxy.example.com" });
    expect(request?.via).toBeUndefined();
  });
});

describe("provider jobs", () => {
  /** A job dir under one provider's state dir; the provider's state dir defaults to the test home. */
  function writeJobDir(
    env: NodeJS.ProcessEnv,
    home: string,
    plugin: string,
    id: string,
    job: Record<string, unknown>,
    attempts: string[] = [],
  ): string {
    const dir = join(env[`${plugin.toUpperCase()}_STATE_DIR`] ?? join(home, plugin), "jobs", id);
    writeText(join(dir, "job.json"), JSON.stringify(job));
    for (const name of attempts) writeText(join(dir, name), "");
    return dir;
  }

  it("surfaces external agents, tails their attempts and retires finished jobs", () => {
    const { env, zai } = makeEnv();
    const j1 = join(zai, "jobs", "j1");
    writeText(
      join(j1, "job.json"),
      JSON.stringify({
        brief: { title: "Fix tests", model: "glm-5.3" },
        state: "running",
        updatedAt: "2030-01-01T00:00:00Z",
      }),
    );
    writeText(
      join(j1, "attempt-1.jsonl"),
      jsonl([
        { type: "user", timestamp: iso(T0), message: { content: "go" } },
        {
          type: "assistant",
          timestamp: iso(T1),
          requestId: "zreq-1",
          message: {
            model: "glm-5.3",
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
            content: [],
          },
        },
      ]),
    );
    const j2 = join(zai, "jobs", "j2");
    writeText(join(j2, "job.json"), JSON.stringify({ state: "failed", updatedAt: "2030-01-01T00:00:00Z" }));
    writeText(join(j2, "attempt-1.jsonl"), jsonl([assistantLine(T1, "zreq-2")]));
    const store = createStore();
    manualWatcher(env, store);
    const sessionIds = store.sessionList().map((session) => session.id);
    expect(sessionIds).toContain("zai:j1");
    expect(sessionIds).toContain("zai:j2");
    expect(store.sessionDetail("zai:j1")?.agents.find((agent) => agent.id === "j1")).toMatchObject({
      id: "j1",
      kind: "external",
      name: "Fix tests",
      live: true,
    });
    // a landed job is no open session: neither its agent nor its session reads as live
    expect(store.sessionDetail("zai:j2")?.agents.find((agent) => agent.id === "j2")?.live).toBe(false);
    expect(store.sessionDetail("zai:j2")).toMatchObject({
      live: false,
      endedAt: Date.parse("2030-01-01T00:00:00Z"),
    });
    expect(store.requests({ session: "zai:j1" })[0]).toMatchObject({
      id: "zreq-1",
      agentId: "j1",
      model: "glm-5.3",
      provider: "Z.ai",
      latencyMs: 1_000,
    });
  });

  it("tails an attempt's real transcript as one job session and skips the attempt file", () => {
    const { env, zai } = makeEnv();
    writeJobDir(env, "", "zai", "j1", {
      brief: { title: "Fix tests", model: "glm-5.3" },
      state: "running",
      workspace: { repoRoot: "/w/main", branch: "zai/j1" },
      origin: { sessionId: "sess-0" },
      attempts: [{ n: 1, sessionId: "att-1" }],
      updatedAt: "2030-01-01T00:00:00Z",
    });
    writeText(join(zai, "jobs", "j1", "attempt-1.jsonl"), jsonl([assistantLine(T1, "zreq-attempt")]));
    const transcript = (id: string, ts: number): Record<string, unknown> => ({
      type: "assistant",
      timestamp: iso(ts),
      sessionId: "att-1", // the attempt's own session id, which the job session replaces
      requestId: id,
      message: {
        model: "glm-5.3",
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
        content: [],
      },
    });
    writeText(
      join(zai, "claude-home", "projects", "-w-main", "att-1.jsonl"),
      jsonl([transcript("treq-1", T0), transcript("treq-2", T1)]),
    );
    writeText(
      join(zai, "claude-home", "projects", "-w-main", "att-1", "subagents", "agent-w1.jsonl"),
      jsonl([transcript("sreq-1", T1)]),
    );
    writeText(
      join(zai, "claude-home", "projects", "-w-main", "att-1", "subagents", "agent-w1.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "find the flaky test" }),
    );
    const store = createStore();
    manualWatcher(env, store);
    const ids = store.requests({ session: "zai:j1" }).map((request) => request.id);
    expect(ids).toEqual(["treq-2", "sreq-1", "treq-1"]); // the attempt file's zreq-attempt is not counted twice
    expect(store.requests({ session: "zai:j1" }).find((request) => request.id === "treq-1")).toMatchObject({
      agentId: "j1",
      sessionId: "zai:j1",
      upstream: "https://api.z.ai/api/anthropic",
    });
    expect(store.requests({ session: "zai:j1" }).find((request) => request.id === "sreq-1")).toMatchObject({
      agentId: "agent-w1",
    });
    expect(store.sessionDetail("zai:j1")?.agents.find((agent) => agent.id === "agent-w1")).toMatchObject({
      parentId: "j1",
      kind: "subagent",
      name: "Explore — find the flaky test",
      agentType: "Explore",
      description: "find the flaky test",
    });
    expect(store.sessionList().find((session) => session.id === "zai:j1")).toMatchObject({
      name: "Fix tests",
      branch: "zai/j1",
      repo: "/w/main",
      parentSessionId: "sess-0",
    });
  });

  it("falls back to an attempt file whose transcript never appeared", () => {
    const { env, zai } = makeEnv();
    writeJobDir(env, "", "zai", "old", {
      attempts: [{ n: 1, sessionId: "att-gone" }],
      updatedAt: "2030-01-01T00:00:00Z",
    });
    writeText(join(zai, "jobs", "old", "attempt-1.jsonl"), jsonl([assistantLine(T1, "zreq-old")]));
    const store = createStore();
    manualWatcher(env, store);
    expect(store.requests({ session: "zai:old" }).map((request) => request.id)).toEqual(["zreq-old"]);
  });

  it("keeps a transcript-less attempt file even when job.json names no session", () => {
    const { env, zai } = makeEnv();
    writeJobDir(env, "", "zai", "plain", { updatedAt: "2030-01-01T00:00:00Z" });
    writeText(join(zai, "jobs", "plain", "attempt-1.jsonl"), jsonl([assistantLine(T1, "zreq-plain")]));
    const store = createStore();
    manualWatcher(env, store);
    expect(store.requests({ session: "zai:plain" }).map((request) => request.id)).toEqual(["zreq-plain"]);
  });

  it("sends a plugin's jobs where its router sent that plugin's models, and nowhere else", () => {
    const { env, home } = makeEnv();
    env.KIMI_STATE_DIR = join(home, "kimi");
    env.QWEN_STATE_DIR = join(home, "qwen");
    writeText(
      spoolPath(env),
      jsonl([
        {
          ts: iso(T0),
          event: "route",
          plugin: "kimi",
          model: "kimi-k2.5",
          upstream: "https://api.moonshot.ai/anthropic",
          status: 200,
          session_id: "s1",
        },
        {
          ts: iso(T0),
          event: "route",
          plugin: "kimi",
          model: "claude-sonnet-5-5", // a passthrough says nothing about where kimi's own models go
          upstream: "https://api.anthropic.com",
          status: 200,
          session_id: "s1",
        },
      ]),
    );
    writeJobDir(env, home, "kimi", "k1", { attempts: [{ n: 1 }], updatedAt: "2030-01-01T00:00:00Z" });
    writeJobDir(env, home, "qwen", "q1", { attempts: [{ n: 1 }], updatedAt: "2030-01-01T00:00:00Z" });
    writeText(
      join(home, "kimi", "jobs", "k1", "attempt-1.jsonl"),
      jsonl([assistantLine(T1, "kreq-1", "kimi-k2.5")]),
    );
    writeText(
      join(home, "qwen", "jobs", "q1", "attempt-1.jsonl"),
      jsonl([assistantLine(T1, "qreq-1", "qwen3.8-max")]),
    );
    const store = createStore();
    manualWatcher(env, store);
    expect(store.requests({ session: "kimi:k1" })[0]).toMatchObject({
      upstream: "https://api.moonshot.ai/anthropic",
      provider: "Moonshot",
    });
    // a model no route line ever placed still names the host its own offering serves
    expect(store.requests({ session: "qwen:q1" })[0]).toMatchObject({
      upstream: "https://dashscope-intl.aliyuncs.com",
    });
  });
});

describe("subagent meta files", () => {
  it("names a discovered session subagent after its type and carries its task", () => {
    const { env, config } = makeEnv();
    const subagents = join(config, "projects", "-w-app", "sess-a", "subagents");
    writeText(join(subagents, "agent-w1.jsonl"), jsonl([assistantLine(T1, "sreq-1")]));
    writeText(
      join(subagents, "agent-w1.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "find the flaky test" }),
    );
    const store = createStore();
    manualWatcher(env, store);
    expect(store.sessionDetail("sess-a")?.agents.find((agent) => agent.id === "agent-w1")).toMatchObject({
      parentId: "main",
      kind: "subagent",
      name: "Explore — find the flaky test",
      agentType: "Explore",
      description: "find the flaky test",
    });
  });

  it("does not rename a subagent whose meta file is missing or unusable", () => {
    const { env, config } = makeEnv();
    const subagents = join(config, "projects", "-w-app", "sess-b", "subagents");
    writeText(join(subagents, "agent-w2.jsonl"), jsonl([assistantLine(T1, "sreq-2")]));
    writeText(join(subagents, "agent-w3.jsonl"), jsonl([assistantLine(T1, "sreq-3")]));
    writeText(join(subagents, "agent-w3.meta.json"), JSON.stringify({ agentType: 42 }));
    const store = createStore();
    manualWatcher(env, store);
    const agents = store.sessionDetail("sess-b")?.agents ?? [];
    expect(agents.map((agent) => agent.name).sort()).toEqual(["Subagent", "Subagent", "main"]);
  });

  it("names a subagent without a meta file after its first prompt, one line, 80 characters", () => {
    const { env, config } = makeEnv();
    const subagents = join(config, "projects", "-w-app", "sess-c", "subagents");
    writeText(
      join(subagents, "agent-w4.jsonl"),
      jsonl([
        {
          type: "user",
          timestamp: iso(T0),
          message: { role: "user", content: `${"a".repeat(100)}\nsecond line` },
        },
        assistantLine(T1, "sreq-4"),
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    const agent = store.sessionDetail("sess-c")?.agents.find((entry) => entry.id === "agent-w4");
    expect(agent).toMatchObject({ kind: "subagent", name: "a".repeat(80) });
  });
});

describe("Claude Code's session registry", () => {
  /** A temp Claude config dir with an empty sessions/ registry beside its projects/. */
  function registryEnv(): { env: NodeJS.ProcessEnv; config: string; sessions: string } {
    const { env, config } = makeEnv();
    const sessions = join(config, "sessions");
    mkdirSync(sessions, { recursive: true });
    return { env, config, sessions };
  }

  it("marks the sessions it lists live and names them as the user named them", () => {
    const { env, config, sessions } = registryEnv();
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "sess-a",
        status: "busy",
        name: "ProxBeam",
        nameSource: "user",
      }),
    );
    writeText(join(config, "projects", "-w-app", "sess-a.jsonl"), jsonl([userLine(T0)]));
    const store = createStore();
    manualWatcher(env, store);
    expect(store.sessionDetail("sess-a")).toMatchObject({
      live: true,
      status: "working",
      name: "ProxBeam",
    });
  });

  it("ends a session whose pid died, without any SessionEnd hook", () => {
    const { env, config, sessions } = registryEnv();
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({ pid: process.pid, sessionId: "sess-a", status: "busy" }),
    );
    writeText(join(config, "projects", "-w-app", "sess-a.jsonl"), jsonl([userLine(T0)]));
    const store = createStore();
    const { tick } = manualWatcher(env, store);
    expect(store.sessionDetail("sess-a")).toMatchObject({ live: true });
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({ pid: 999_999_999, sessionId: "sess-a", status: "busy" }),
    );
    tick(5_000); // the next rescan reads the registry again
    expect(store.sessionDetail("sess-a")).toMatchObject({ live: false });
  });

  it("never asks about a pid from the .key files beside the session files", () => {
    const { env, sessions } = registryEnv();
    writeText(join(sessions, "81812.key"), JSON.stringify({ pid: 777, sessionId: "from-the-key" }));
    const asked: number[] = [];
    const watcher = startWatcher({
      env,
      store: createStore(),
      sinceMs: DAY,
      intervalMs: 3_600_000,
      rescanMs: 5_000,
      now: () => T0,
      alive: (pid) => {
        asked.push(pid);
        return true;
      },
    });
    watcher.stop();
    expect(asked).toEqual([]);
  });

  it("reads a live session's transcript however old it is, from the cwd's slug dir", () => {
    const { env, config, sessions } = registryEnv();
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "sess-old",
        status: "idle",
        name: "app-56",
        nameSource: "derived",
        cwd: "/w/app",
        startedAt: T0 - 2 * DAY,
      }),
    );
    // opened two days ago: outside the --since window, so only the registry's word brings it in
    const old = writeText(
      join(config, "projects", "-w-app", "sess-old.jsonl"),
      jsonl([userLine(T0 - 2 * DAY), assistantLine(T0 - 2 * DAY + 1_000, "req-old")]),
    );
    utimesSync(old, new Date(T0 - 2 * DAY), new Date(T0 - 2 * DAY));
    const store = createStore();
    manualWatcher(env, store);
    expect(store.sessionDetail("sess-old")).toMatchObject({
      live: true,
      status: "idle",
      name: "app-56",
      cwd: "/w/app",
      startedAt: T0 - 2 * DAY,
    });
    expect(store.requests({ session: "sess-old" }).map((request) => request.id)).toEqual(["req-old"]);
  });

  it("reads a live session's subagents from the start, then the lines they grow by", () => {
    const { env, config, sessions } = registryEnv();
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "sess-live",
        status: "busy",
        cwd: "/w/app",
        startedAt: T0 - 2 * DAY,
      }),
    );
    const subagents = join(config, "projects", "-w-app", "sess-live", "subagents");
    writeText(
      join(subagents, "agent-w1.jsonl"),
      jsonl([
        assistantLine(T0 + 1_000, "sreq-1"),
        assistantLine(T0 + 2_000, "sreq-2"),
        assistantLine(T0 + 3_000, "sreq-3"),
      ]),
    );
    const store = createStore();
    const { tick } = manualWatcher(env, store);
    expect(store.requests({ session: "sess-live" }).map((request) => request.id)).toEqual([
      "sreq-3",
      "sreq-2",
      "sreq-1",
    ]);
    appendText(
      join(subagents, "agent-w1.jsonl"),
      jsonl([assistantLine(T0 + 4_000, "sreq-4"), assistantLine(T0 + 5_000, "sreq-5")]),
    );
    tick(1_000); // no rescan needed: the tail reads on from its stored offset
    expect(store.requests({ session: "sess-live" }).map((request) => request.id)).toEqual([
      "sreq-5",
      "sreq-4",
      "sreq-3",
      "sreq-2",
      "sreq-1",
    ]);
  });

  it("discovers a subagent file a live session created after start, whatever its age", () => {
    const { env, config, sessions } = registryEnv();
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "sess-live",
        status: "busy",
        cwd: "/w/app",
        startedAt: T0 - 2 * DAY,
      }),
    );
    writeText(join(config, "projects", "-w-app", "sess-live.jsonl"), jsonl([userLine(T0 - 2 * DAY)]));
    const store = createStore();
    const { tick } = manualWatcher(env, store);
    expect(store.requests({ session: "sess-live" })).toHaveLength(0);
    // the session spawns a subagent after we first saw it; its file is already old by the clock
    const late = writeText(
      join(config, "projects", "-w-app", "sess-live", "subagents", "agent-late.jsonl"),
      jsonl([assistantLine(T0 - 2 * DAY, "sreq-late")]),
    );
    utimesSync(late, new Date(T0 - 10 * DAY), new Date(T0 - 10 * DAY));
    tick(5_000); // the next rescan re-lists the live session's subagents
    expect(store.requests({ session: "sess-live" }).map((request) => request.id)).toEqual(["sreq-late"]);
  });

  it("finds a registry session's transcript by search when its cwd maps to no project dir", () => {
    const { env, config, sessions } = registryEnv();
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "sess-odd",
        status: "busy",
        cwd: "/elsewhere/odd cwd+",
        startedAt: T0,
      }),
    );
    writeText(
      join(config, "projects", "-w-app", "sess-odd.jsonl"),
      jsonl([
        { type: "user", timestamp: iso(T0 - 3 * DAY), cwd: "/w/app", slug: "odd-session" },
        assistantLine(T0 - 3 * DAY + 1_000, "req-odd"),
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    expect(store.sessionDetail("sess-odd")).toMatchObject({
      live: true,
      status: "working",
      name: "odd-session", // no registry name, so the transcript's own naming stands
    });
    expect(store.requests({ session: "sess-odd" }).map((request) => request.id)).toEqual(["req-odd"]);
  });
});

describe("session names and repos from transcripts", () => {
  it("names a session after its title lines and keeps the latest of each", () => {
    const { env, config } = makeEnv();
    const projects = join(config, "projects", "-w-app");
    writeText(
      join(projects, "sess-a.jsonl"),
      jsonl([
        { type: "user", timestamp: iso(T0), cwd: "/w/app", slug: "porting", gitBranch: "feat/a" },
        { type: "custom-title", customTitle: "Port the router" },
        { type: "ai-title", aiTitle: "Porting the router", sessionId: "sess-a" },
      ]),
    );
    const store = createStore();
    manualWatcher(env, store);
    expect(store.sessionList().find((session) => session.id === "sess-a")).toMatchObject({
      name: "Port the router",
      branch: "feat/a",
    });
  });

  it("derives a session's repo from its cwd, worktrees folded into their main checkout", () => {
    const repo = mkdtempSync(join(tmpdir(), "radar-repo-"));
    mkdirSync(join(repo, ".git"));
    const { env, config } = makeEnv();
    writeText(
      join(config, "projects", "-w-app", "sess-a.jsonl"),
      jsonl([{ type: "user", timestamp: iso(T0), cwd: join(repo, "src") }]),
    );
    const store = createStore();
    manualWatcher(env, store);
    expect(store.sessionList().find((session) => session.id === "sess-a")?.repo).toBe(repo);
  });
});

describe("the interval", () => {
  it("survives a throwing tick and keeps ingesting afterwards", async () => {
    const { env } = makeEnv();
    const path = writeText(
      todaySpool(env),
      jsonl([{ ts: new Date().toISOString(), event: "UserPromptSubmit", session_id: "s1", prompt: "a" }]),
    );
    const real = createStore();
    const trip = { on: false };
    const store: Store = {
      ...real,
      addSpoolLine: (line: SpoolLine) => {
        if (trip.on) throw new Error("boom");
        real.addSpoolLine(line);
      },
    };
    const watcher = startWatcher({ env, store, sinceMs: DAY, intervalMs: 10, rescanMs: 5_000 });
    trip.on = true;
    await new Promise((sleep) => setTimeout(sleep, 30)); // ticks throw; the watcher must not die
    trip.on = false;
    appendText(
      path,
      `${JSON.stringify({ ts: new Date().toISOString(), event: "Stop", session_id: "s1" })}\n`,
    );
    await waitFor("the next healthy tick", 2_000, () => real.events({ limit: 10 }).length === 2);
    watcher.stop();
  });

  it("stops ingesting once stopped", async () => {
    const { env } = makeEnv();
    const path = writeText(
      todaySpool(env),
      jsonl([{ ts: new Date().toISOString(), event: "UserPromptSubmit", session_id: "s1", prompt: "a" }]),
    );
    const store = createStore();
    const watcher = startWatcher({ env, store, sinceMs: DAY, intervalMs: 10, rescanMs: 5_000 });
    expect(store.events({ limit: 10 })).toHaveLength(1);
    watcher.stop();
    appendText(
      path,
      `${JSON.stringify({ ts: new Date().toISOString(), event: "Stop", session_id: "s1" })}\n`,
    );
    await new Promise((sleep) => setTimeout(sleep, 60));
    expect(store.events({ limit: 10 })).toHaveLength(1);
  });

  it("yields to the event loop while a large first catch-up is still running", async () => {
    const { env } = makeEnv();
    const lines: SpoolLine[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      lines.push({
        ts: iso(T0 + i),
        event: "UserPromptSubmit",
        session_id: `s${i % 40}`,
        prompt: `prompt ${i}`,
      });
    }
    writeText(todaySpool(env), jsonl(lines));
    const real = createStore();
    let seen = 0;
    // ~0.2 ms of work per line: a ~20 ms slice holds ~100 lines, so the 2,000-line backlog spans slices
    const store: Store = {
      ...real,
      addSpoolLine: (line: SpoolLine) => {
        const until = performance.now() + 0.2;
        while (performance.now() < until) {
          // stay busy, like a real ingest line does
        }
        real.addSpoolLine(line);
        seen += 1;
      },
    };
    const watcher = startWatcher({ env, store, sinceMs: DAY, intervalMs: 3_600_000 });
    try {
      let ingestedWhenTimerRan = -1;
      setTimeout(() => {
        ingestedWhenTimerRan = seen;
      }, 5);
      await waitFor("the whole backlog", 10_000, () => (seen === 2_000 ? true : null));
      // the timer fired while the scan was still short of the end: the loop got a turn mid-catch-up
      expect(ingestedWhenTimerRan).toBeGreaterThanOrEqual(0);
      expect(ingestedWhenTimerRan).toBeLessThan(2_000);
      expect(real.sessionList()).toHaveLength(40);
    } finally {
      watcher.stop();
    }
  });
});

describe("loopbackHost", () => {
  it("names a router on this machine and nothing else", () => {
    expect(loopbackHost("http://127.0.0.1:18787")).toBe("127.0.0.1:18787");
    expect(loopbackHost("http://localhost:8080/v1")).toBe("localhost:8080");
    expect(loopbackHost("http://[::1]:9000")).toBe("[::1]:9000");
    expect(loopbackHost("https://api.anthropic.com")).toBeNull();
    expect(loopbackHost("not a url")).toBeNull();
  });
});

describe("tail eviction", () => {
  /** A watcher the test drives by hand, with the watcher itself in hand for its tail count. */
  function manual(
    env: NodeJS.ProcessEnv,
    store: Store,
  ): { tick(advanceMs: number): void; tracked(): number } {
    let clock = T0;
    const watcher = startWatcher({
      env,
      store,
      sinceMs: DAY,
      intervalMs: 3_600_000,
      rescanMs: 5_000,
      now: () => clock,
    });
    return {
      tick(advanceMs: number): void {
        clock += advanceMs;
        watcher.pollOnce();
      },
      tracked: () => watcher.tracked(),
    };
  }

  /** A projects tree with a registry-named session and a discovery-found one beside it. */
  function seeded(): {
    env: NodeJS.ProcessEnv;
    config: string;
    sessions: string;
    live: string;
    quiet: string;
  } {
    const { env, config } = makeEnv();
    const sessions = join(config, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeText(
      join(sessions, "81812.json"),
      JSON.stringify({ pid: process.pid, sessionId: "sess-live", status: "busy", cwd: "/w/app" }),
    );
    const live = writeText(
      join(config, "projects", "-w-app", "sess-live.jsonl"),
      jsonl([userLine(T0), assistantLine(T0 + 1_000, "req-live")]),
    );
    const quiet = writeText(
      join(config, "projects", "-w-app", "quiet.jsonl"),
      jsonl([userLine(T0), assistantLine(T0 + 1_000, "req-quiet")]),
    );
    return { env, config, sessions, live, quiet };
  }

  it("drops a quiet unregistered transcript on a rescan and keeps a live session's", () => {
    const { env, quiet } = seeded();
    const store = createStore();
    const watcher = manual(env, store);
    expect(watcher.tracked()).toBe(2); // both files tailed from the first pass
    utimesSync(quiet, new Date(T0 - 2 * DAY), new Date(T0 - 2 * DAY));
    watcher.tick(5_000); // the rescan: the quiet file is past the since window and nobody names it
    expect(watcher.tracked()).toBe(1);
    watcher.tick(5_000); // and it stays dropped, however many rescans follow
    expect(watcher.tracked()).toBe(1);
  });

  it("brings a dropped file back when it changes again, without doubling its rows", () => {
    const { env, quiet } = seeded();
    const store = createStore();
    const watcher = manual(env, store);
    utimesSync(quiet, new Date(T0 - 2 * DAY), new Date(T0 - 2 * DAY));
    watcher.tick(5_000); // dropped
    expect(watcher.tracked()).toBe(1);
    appendText(quiet, `${JSON.stringify(assistantLine(T0 + 2_000, "req-newer"))}\n`);
    watcher.tick(5_000); // the fresh mtime re-discovers it like any new file
    expect(watcher.tracked()).toBe(2);
    expect(
      store
        .requests({})
        .map((request) => request.id)
        .sort(),
    ).toEqual(["req-live", "req-newer", "req-quiet"]);
    watcher.tick(5_000); // quiet again (no change since), still held: within the window
    expect(watcher.tracked()).toBe(2);
  });
});

describe("the ingest backlog word", () => {
  it("stands while a first pass spans slices and falls once the backlog drains", async () => {
    const { env } = makeEnv();
    const lines: SpoolLine[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      lines.push({
        ts: iso(T0 + i),
        event: "UserPromptSubmit",
        session_id: `s${i % 40}`,
        prompt: `prompt ${i}`,
      });
    }
    writeText(todaySpool(env), jsonl(lines));
    const real = createStore();
    let seen = 0;
    const store: Store = {
      ...real,
      addSpoolLine: (line: SpoolLine) => {
        const until = performance.now() + 0.2;
        while (performance.now() < until) {
          // stay busy, like a real ingest line does
        }
        real.addSpoolLine(line);
        seen += 1;
      },
    };
    const watcher = startWatcher({ env, store, sinceMs: DAY, intervalMs: 3_600_000 });
    try {
      watcher.pollOnce();
      await waitFor("the catch-up to be under way", 10_000, () => (seen > 0 && seen < 2_000 ? true : null));
      expect(watcher.catchingUp()).toBe(true);
      await waitFor("the whole backlog", 10_000, () => (seen === 2_000 ? true : null));
      await new Promise((sleep) => setTimeout(sleep, 20)); // the pass's last slice ends
      expect(watcher.catchingUp()).toBe(false);
      watcher.pollOnce(); // a quiet tick's pass runs to completion inside the call
      expect(watcher.catchingUp()).toBe(false);
    } finally {
      watcher.stop();
    }
  });
});
