import { utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startWatcher } from "../src/ingest/watch.ts";
import type { SpoolLine } from "../src/shared/model.ts";
import { spoolDir } from "../src/shared/paths.ts";
import { DEFAULT_UPSTREAM } from "../src/shared/provider.ts";
import { createStore, type Store } from "../src/store/store.ts";
import { appendText, iso, jsonl, makeEnv, waitFor, writeText } from "./helpers.ts";

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

function assistantLine(ts: number, requestId: string): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: iso(ts),
    requestId,
    message: {
      model: "claude-sonnet-5-5",
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
      id: `route:s9:${T1}:ok`,
      sessionId: "s9",
      agentId: "main",
      model: "glm-5.3",
      upstream: "http://127.0.0.1:8787",
      ts: T1,
      latencyMs: 42,
      stopReason: "ok",
      provider: "route",
    });
    expect(routed[0]?.tokens).toEqual({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6 });
    expect(store.requests({ session: "s10" })[0]).toMatchObject({
      upstream: DEFAULT_UPSTREAM,
      latencyMs: null,
      stopReason: null,
    });
    expect(store.events({ limit: 100 })).toEqual([]);
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
      upstream: "http://127.0.0.1:8787", // enriched from the spool's SessionStart
      provider: "Anthropic",
    });
    expect(store.requests({}).find((request) => request.id === "req-ref")).toMatchObject({
      sessionId: "referenced",
      upstream: "", // no SessionStart taught us this session's base URL
    });
    expect(store.sessionDetail("sess-a")).toMatchObject({
      cwd: "/w/app",
      project: "app",
      ccVersion: "2.0.0",
    });
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

describe("zai jobs", () => {
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
    expect(store.sessionDetail("zai:j2")?.agents.find((agent) => agent.id === "j2")?.live).toBe(false);
    expect(store.requests({ session: "zai:j1" })[0]).toMatchObject({
      id: "zreq-1",
      agentId: "j1",
      model: "glm-5.3",
      provider: "Z.ai",
      latencyMs: 1_000,
    });
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
});
