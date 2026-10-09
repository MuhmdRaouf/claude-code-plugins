import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/history/driver.ts";
import type { History } from "../src/history/history.ts";
import { openHistory } from "../src/history/history.ts";
import { attachHistoryWriter } from "../src/history/writer.ts";
import { startWatcher } from "../src/ingest/watch.ts";
import { OUTSIDE_SESSION, type SpoolLine } from "../src/shared/model.ts";
import { claudeConfigDir, spoolDir } from "../src/shared/paths.ts";
import { createStore, type Store } from "../src/store/store.ts";
import { iso, jsonl, makeEnv, makeRequest, makeTool, writeText } from "./helpers.ts";

const T0 = 1_700_000_000_000;

let dir: string;
let store: Store;
let history: History;
let writer: { flush(): void; stop(): void } | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-writer-"));
  store = createStore();
});

afterEach(() => {
  writer?.stop();
  writer = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A writer over a fresh history file in the temp dir. */
async function attach(): Promise<History> {
  history = await openHistory(join(dir, "history.db"));
  writer = attachHistoryWriter({ store, history });
  return history;
}

/** Every event row the writer logged, straight from sqlite (the History interface has no events reader). */
async function eventRows(file: string): Promise<{ kind: string; node_id: string | null }[]> {
  const db = await openDb(file);
  const rows = db.all<{ kind: string; node_id: string | null }>(
    "SELECT kind, node_id FROM events ORDER BY seq",
  );
  db.close();
  return rows;
}

function spoolLine(event: string, sessionId: string): SpoolLine {
  return { ts: iso(T0 + 5), event, session_id: sessionId };
}

describe("node mapping", () => {
  it("maps the main session and its subagents, nested ones included", async () => {
    const h = await attach();
    store.upsertSession({ id: "s1", cwd: "/work/app", branch: "main", customTitle: "Fix the login" });
    store.upsertAgent({ sessionId: "s1", id: "w1", kind: "subagent", parentId: "main", name: "scout" });
    store.upsertAgent({ sessionId: "s1", id: "w2", kind: "subagent", parentId: "w1", name: "deep" });
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", agentId: "w2", ts: T0 }));
    writer?.flush();
    const rows = h.tree("s1/main").sort((a, b) => a.id.localeCompare(b.id));
    expect(rows.map((n) => [n.id, n.kind, n.parentId])).toEqual([
      ["s1/main", "main", null],
      ["s1/w1", "subagent", "s1/main"],
      ["s1/w2", "subagent", "s1/w1"],
    ]);
    expect(rows[0]).toMatchObject({
      name: "Fix the login",
      branch: "main",
      project: "app",
      cwd: "/work/app",
    });
    expect(rows.find((n) => n.id === "s1/w1")).toMatchObject({ name: "scout", agentType: null });
    expect(h.requestsOf({ nodeId: "s1/w2", limit: 10 }).map((r) => r.id)).toEqual(["r1"]);
  });

  it("maps a job session with and without a parent, its own agent on the job node", async () => {
    const h = await attach();
    store.upsertSession({ id: "s1", cwd: "/work/app" });
    store.upsertSession({
      id: "zai:j1",
      external: true,
      parentSessionId: "s1",
      repo: "/work/app",
      branch: "feat",
    });
    store.upsertAgent({ sessionId: "zai:j1", id: "j1", kind: "external", name: "j1" });
    store.upsertAgent({ sessionId: "zai:j1", id: "w1", kind: "subagent", parentId: "j1", name: "hand" });
    store.upsertSession({ id: "zai:j2", external: true });
    writer?.flush();
    const j1 = h.tree("s1/main").find((n) => n.id === "job:zai:j1");
    expect(j1).toMatchObject({
      kind: "job",
      parentId: "s1/main",
      sessionId: "zai:j1",
      agentId: "j1",
      repo: "/work/app",
      branch: "feat",
      parentSessionId: "s1",
    });
    expect(h.tree("s1/main").find((n) => n.id === "zai:j1/w1")).toMatchObject({
      kind: "subagent",
      parentId: "job:zai:j1",
    });
    expect(h.tree("job:zai:j2").map((n) => [n.id, n.kind, n.parentId])).toEqual([
      ["job:zai:j2", "job", null],
    ]);
  });

  it("ends a session's node when the store ends it, and a later request revives it", async () => {
    const h = await attach();
    store.upsertSession({ id: "s1", cwd: "/work/app" });
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", ts: T0 }));
    store.endSession("s1", T0 + 100);
    writer?.flush();
    expect(h.tree("s1/main")[0]?.endedAt).toBe(T0 + 100);
    store.addRequest(makeRequest({ id: "r2", sessionId: "s1", ts: T0 + 200 }));
    writer?.flush();
    expect(h.tree("s1/main")[0]?.endedAt).toBeNull();
  });
});

describe("the unattached group", () => {
  it("keeps sessionless requests out of the live scope, grouped as Unattached in history", async () => {
    const h = await attach();
    store.addRequest(makeRequest({ id: "r9", sessionId: OUTSIDE_SESSION, ts: T0, model: "glm-5.3" }));
    writer?.flush();
    const now = T0 + 1;
    const liveScope = h.roots({ scope: "live", now, liveMs: 60_000, limit: 10 });
    expect(liveScope).toEqual([]); // traffic with no session is never a live session
    const past = h.roots({ scope: "history", now: T0 + 60_000, liveMs: 60_000, limit: 10 });
    expect(past.map((root) => [root.id, root.name])).toEqual([["outside-a-session/main", "Unattached"]]);
  });
});

describe("records", () => {
  it("writes the requests, tools and events of an update beside their nodes", async () => {
    const h = await attach();
    const file = join(dir, "history.db");
    store.upsertSession({ id: "s1", cwd: "/work/app" });
    store.addRequest(
      makeRequest({
        id: "r1",
        sessionId: "s1",
        ts: T0,
        cacheWrite1h: 33,
        speed: "fast",
        geo: "us",
        serviceTier: "priority",
      }),
    );
    store.addToolCall(makeTool({ id: "t1", sessionId: "s1", agentId: "main" }));
    store.addSpoolLine(spoolLine("UserPromptSubmit", "s1"));
    writer?.flush();
    expect(h.requestsOf({ nodeId: "s1/main", limit: 10 })).toEqual([
      makeRequest({
        id: "r1",
        sessionId: "s1",
        ts: T0,
        cacheWrite1h: 33,
        speed: "fast",
        geo: "us",
        serviceTier: "priority",
      }),
    ]);
    const db = await openDb(file);
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tools")?.c).toBe(1);
    db.close();
    expect(await eventRows(file)).toEqual([{ kind: "UserPromptSubmit", node_id: "s1/main" }]);
  });

  it("keeps a request's failure reason beside it and reads it back", async () => {
    const h = await attach();
    store.upsertSession({ id: "s1" });
    store.addRequest(
      makeRequest({
        id: "r1",
        sessionId: "s1",
        ts: T0,
        stopReason: "502",
        error: "connection failed (ECONNREFUSED)",
      }),
    );
    writer?.flush();
    expect(h.requestsOf({ nodeId: "s1/main", limit: 10 })).toEqual([
      makeRequest({
        id: "r1",
        sessionId: "s1",
        ts: T0,
        stopReason: "502",
        error: "connection failed (ECONNREFUSED)",
      }),
    ]);
  });

  it("keeps a route line's parent agent on the record and reads it back", async () => {
    const h = await attach();
    store.upsertSession({ id: "s1" });
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", ts: T0, parentAgentId: "a31cd" }));
    writer?.flush();
    expect(h.requestsOf({ nodeId: "s1/main", limit: 10 })).toEqual([
      makeRequest({ id: "r1", sessionId: "s1", ts: T0, parentAgentId: "a31cd" }),
    ]);
  });

  it("carries the request's captured input and output, merging a longer later chunk", async () => {
    const h = await attach();
    store.upsertSession({ id: "s1", cwd: "/work/app" });
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", ts: T0 }), {
      input: '[{"type":"text","text":"a full prompt text"}]',
      output: '[{"type":"text","text":"He"}]',
    });
    writer?.flush();
    expect(h.content("r1")).toMatchObject({ input: '[{"type":"text","text":"a full prompt text"}]' });
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", ts: T0 + 1 }), {
      input: null,
      output: '[{"type":"text","text":"Hello"}]',
    });
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", ts: T0 + 2 }), {
      input: '[{"type":"text","text":"tiny"}]',
      output: '[{"type":"text","text":"ok"}]',
    });
    writer?.flush();
    expect(h.content("r1")).toEqual({
      input: '[{"type":"text","text":"a full prompt text"}]', // a shorter later chunk never erases what it held
      output: '[{"type":"text","text":"Hello"}]',
      bytes:
        Buffer.byteLength('[{"type":"text","text":"a full prompt text"}]') +
        Buffer.byteLength('[{"type":"text","text":"Hello"}]'),
    });
  });
});

describe("the whole ingest path", () => {
  it("writes what the watcher ingests: nodes, the request and its captured text", async () => {
    const { env } = makeEnv();
    const h = await attach();
    writeText(
      join(claudeConfigDir(env), "projects", "proj", "s1.jsonl"),
      jsonl([
        { type: "user", timestamp: iso(T0), cwd: "/w/app", message: { content: "Fix the login bug" } },
        {
          type: "assistant",
          timestamp: iso(T0 + 1000),
          requestId: "req_1",
          message: {
            model: "claude-sonnet-5-5",
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "On it" },
              { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          timestamp: iso(T0 + 2000),
          message: {
            content: [{ type: "tool_result", tool_use_id: "tu1", content: "file one\nfile two" }],
          },
        },
        {
          type: "assistant",
          timestamp: iso(T0 + 3000),
          requestId: "req_2",
          message: {
            model: "claude-sonnet-5-5",
            usage: { input_tokens: 20, output_tokens: 6 },
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Done" }],
          },
        },
      ]),
    );
    writeText(join(spoolDir(env), "spool.jsonl"), jsonl([spoolLine("SessionStart", "s1")]));
    const watcher = startWatcher({ env, store, sinceMs: 86_400_000, intervalMs: 3_600_000 });
    try {
      writer?.flush();
      expect(store.sessionList().map((s) => s.id)).toEqual(["s1"]);
      expect(h.tree("s1/main").map((n) => n.id)).toEqual(["s1/main"]);
      expect(h.requestsOf({ nodeId: "s1/main", limit: 10 }).map((r) => r.id)).toEqual(["req_2", "req_1"]);
      const first = h.content("req_1");
      expect(JSON.parse(first?.input ?? "[]")).toEqual([{ type: "text", text: "Fix the login bug" }]);
      expect(JSON.parse(first?.output ?? "[]")).toEqual([
        { type: "text", text: "On it" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ]);
      const second = h.content("req_2");
      expect(JSON.parse(second?.input ?? "[]")).toEqual([
        { type: "tool_result", tool_use_id: "tu1", text: "file one\nfile two" },
      ]);
      expect(JSON.parse(second?.output ?? "[]")).toEqual([{ type: "text", text: "Done" }]);
    } finally {
      watcher.stop();
    }
  });
});

describe("containment", () => {
  it("detaches after one failed write and the store keeps working", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing: History = {
      transaction: () => {
        throw new Error("disk gone");
      },
      close(): void {},
    } as unknown as History;
    const w = attachHistoryWriter({ store, history: throwing });
    try {
      expect(() => store.upsertSession({ id: "s1" })).not.toThrow();
      store.addRequest(makeRequest({ id: "r1" }));
      w.flush();
      expect(store.sessionList().map((s) => s.id)).toEqual(["s1"]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("history write failed");
    } finally {
      w.stop();
      errorSpy.mockRestore();
    }
  });

  it("keeps the write load flat: 5,000 requests through the writer in under 2 s", async () => {
    const h = await attach();
    store.upsertSession({ id: "s1", cwd: "/w/app" });
    const started = performance.now();
    for (let i = 0; i < 5_000; i += 1) {
      store.addRequest(
        makeRequest({
          id: `r${i}`,
          sessionId: "s1",
          agentId: i % 10 === 0 ? "main" : `w${i % 3}`,
          ts: T0 + i,
        }),
      );
    }
    writer?.flush();
    const elapsed = performance.now() - started;
    expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 }).requests).toBe(5_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("coalescing", () => {
  it("queues many updates and writes them all in one transaction at the flush", async () => {
    const h = await openHistory(join(dir, "history.db"));
    let transactions = 0;
    const counting: History = {
      ...h,
      transaction: (fn) => {
        transactions += 1;
        return h.transaction(fn);
      },
    };
    const w = attachHistoryWriter({ store, history: counting });
    writer = w;
    store.upsertSession({ id: "s1", cwd: "/w/app" });
    for (let i = 0; i < 500; i += 1) {
      store.addRequest(makeRequest({ id: `r${i}`, sessionId: "s1", ts: T0 + i }));
    }
    store.addToolCall(makeTool({ id: "t1", sessionId: "s1" }));
    store.addSpoolLine(spoolLine("UserPromptSubmit", "s1"));
    expect(transactions).toBe(0); // nothing written while the batch waits
    w.flush();
    expect(transactions).toBe(1); // the whole batch went in one transaction
    expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 }).requests).toBe(500);
    expect(h.tree("s1/main").map((n) => n.id)).toEqual(["s1/main"]);
    const db = await openDb(join(dir, "history.db"));
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tools")?.c).toBe(1);
    db.close();
    expect(await eventRows(join(dir, "history.db"))).toEqual([
      { kind: "UserPromptSubmit", node_id: "s1/main" },
    ]);
  });

  it("flushes what is queued when the writer stops, losing nothing", async () => {
    const file = join(dir, "history.db");
    const w = attachHistoryWriter({ store, history: await openHistory(file) });
    writer = w;
    store.upsertSession({ id: "s1", cwd: "/w/app" });
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", ts: T0 }));
    w.stop(); // no explicit flush: stop must write the batch before closing
    const db = await openDb(file);
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM requests")?.c).toBe(1);
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM nodes")?.c).toBe(1);
    db.close();
  });

  it("flushes on the 500 ms timer without anyone asking", async () => {
    vi.useFakeTimers();
    try {
      const h = await attach();
      store.upsertSession({ id: "s1", cwd: "/w/app" });
      store.addRequest(makeRequest({ id: "r1", sessionId: "s1", ts: T0 }));
      expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 }).requests).toBe(0);
      vi.advanceTimersByTime(500);
      expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 }).requests).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-derives node rows only for the sessions a batch touched", async () => {
    const h = await openHistory(join(dir, "history.db"));
    const seen: string[] = [];
    const counting: History = {
      ...h,
      upsertNode: (node) => {
        seen.push(node.id);
        return h.upsertNode(node);
      },
    };
    const w = attachHistoryWriter({ store, history: counting });
    writer = w;
    store.upsertSession({ id: "s1", cwd: "/w/app" });
    store.upsertSession({ id: "s2", cwd: "/w/lib" });
    store.upsertAgent({ sessionId: "s2", id: "w9", kind: "subagent", name: "s2 worker" });
    w.flush();
    seen.length = 0;
    store.addRequest(makeRequest({ id: "r1", sessionId: "s1", agentId: "w1", ts: T0 }));
    w.flush();
    expect(seen).toEqual(["s1/main", "s1/w1"]); // s1's new agent only; s2's nodes were left alone
    w.stop();
  });
});
