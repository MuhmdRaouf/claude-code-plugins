import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bunDriver, type Db, openDb, type SqlValue } from "../src/history/driver.ts";
import {
  type ContextMessage,
  type History,
  type NodeUpsert,
  openHistory,
  type StoredSide,
  sideOfNext,
} from "../src/history/history.ts";
import { migrate, SCHEMA_VERSION } from "../src/history/schema.ts";
import { OUTSIDE_SESSION, type RequestRecord, UNATTACHED_NAME, ZERO_TOKENS } from "../src/shared/model.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-history-"));
});

afterEach(() => {
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
    model: "glm-5.3-flash",
    upstream: "https://api.z.ai",
    ts: 1000,
    latencyMs: 10,
    tokens: { ...ZERO_TOKENS, input: 10, output: 4 },
    stopReason: null,
    provider: "zai",
    ...overrides,
  };
}

/** A Db wrapper that remembers every read, so a test can pin the query count and the row bound. */
function countingDb(under: Db): {
  db: Db;
  alls: { sql: string; rows: number }[];
  gets: { sql: string }[];
} {
  const alls: { sql: string; rows: number }[] = [];
  const gets: { sql: string }[] = [];
  const db: Db = {
    exec: (sql) => under.exec(sql),
    all: <T>(sql: string, params?: readonly SqlValue[]) => {
      const rows = under.all<T>(sql, params);
      alls.push({ sql, rows: rows.length });
      return rows;
    },
    get: <T>(sql: string, params?: readonly SqlValue[]) => {
      gets.push({ sql });
      return under.get<T>(sql, params);
    },
    run: (sql, params) => under.run(sql, params),
    close: () => under.close(),
  };
  return { db, alls, gets };
}

const NOW = 1_000_000;
const LIVE = 60_000;
const HISTORY_Q = { scope: "history", now: NOW, liveMs: LIVE, limit: 50 } as const;
const LIVE_Q = { scope: "live", now: NOW, liveMs: LIVE, limit: 50 } as const;

describe("migration", () => {
  it("is a no-op the second time and records the version", async () => {
    const first = await openHistory(join(dir, "history.db"));
    first.upsertNode(node());
    first.close();
    const db = await openDb(join(dir, "history.db"));
    migrate(db);
    migrate(db);
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe(
      String(SCHEMA_VERSION),
    );
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).toHaveLength(8);
    db.close();
  });

  it("refuses a database written by a newer radar", async () => {
    const history = await openHistory(join(dir, "history.db"));
    history.close();
    const db = await openDb(join(dir, "history.db"));
    db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION + 1)]);
    expect(() => migrate(db)).toThrow(`newer radar (schema ${SCHEMA_VERSION + 1})`);
    db.close();
  });

  it("gives a fresh database every v2 column", async () => {
    const history = await openHistory(join(dir, "history.db"));
    history.close();
    const db = await openDb(join(dir, "history.db"));
    const columns = (table: string): string[] =>
      db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((column) => column.name);
    expect(columns("nodes")).toEqual(expect.arrayContaining(["repo", "branch", "name", "parent_session_id"]));
    expect(columns("requests")).toEqual(
      expect.arrayContaining(["cache_write_1h", "speed", "geo", "service_tier"]),
    );
    expect(columns("content")).toEqual(expect.arrayContaining(["in_len", "out_len"]));
    db.close();
  });

  it("upgrades a v1 database in place, keeping its rows", async () => {
    const file = join(dir, "history.db");
    const db = await openDb(file);
    // the v1 shape: no repo/branch/name/parent_session_id on nodes, no billing columns on requests
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL,
        session_id TEXT NOT NULL, agent_id TEXT NOT NULL, label TEXT, agent_type TEXT, description TEXT,
        project TEXT, cwd TEXT, model TEXT, provider TEXT, tool_use_id TEXT, spawn_depth INTEGER,
        job_state TEXT, started_at INTEGER, last_at INTEGER, ended_at INTEGER);
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, session_id TEXT, agent_id TEXT, model TEXT,
        upstream TEXT, ts INTEGER NOT NULL, latency_ms INTEGER, input INTEGER, output INTEGER,
        cache_read INTEGER, cache_write INTEGER, stop_reason TEXT, provider TEXT, route TEXT, via TEXT,
        totals INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
    `);
    db.run(
      "INSERT INTO nodes (id, kind, root_id, session_id, agent_id, label, last_at) " +
        "VALUES ('s1/main', 'main', 's1/main', 's1', 'main', 'before', 5)",
    );
    db.run("INSERT INTO requests (id, node_id, ts, totals) VALUES ('r1', 's1/main', 5, 0)");
    db.close();

    const history = await openHistory(file);
    history.putRequest("s1/main", req({ id: "r2", ts: 9, speed: "fast", cacheWrite1h: 3 }));
    const rows = history.requestsOf({ nodeId: "s1/main", limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(rows[0]?.speed).toBe("fast");
    expect(rows[0]?.cacheWrite1h).toBe(3);
    expect(rows[1]?.speed).toBeUndefined();
    history.upsertNode(
      node({
        id: "s1/ag",
        kind: "subagent",
        parentId: "s1/main",
        agentId: "ag",
        repo: "/w/app",
        name: "scout",
      }),
    );
    const ag = history.tree("s1/main").find((n) => n.id === "s1/ag");
    expect(ag).toMatchObject({ repo: "/w/app", name: "scout", parentSessionId: null });
    expect(history.tree("s1/main")[0]).toMatchObject({ label: "before", lastAt: 9 });
    history.close();

    const probe = await openDb(file);
    expect(probe.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe(
      String(SCHEMA_VERSION),
    );
    probe.close();
  });

  it("backfills a v5 content table's side lengths from the gzip trailers, keeping the blobs", async () => {
    const file = join(dir, "history.db");
    const db = await openDb(file);
    // the v5 shape: content carries no per-side lengths yet
    db.exec(`
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, session_id TEXT, agent_id TEXT, model TEXT,
        upstream TEXT, ts INTEGER NOT NULL, latency_ms INTEGER, input INTEGER, output INTEGER,
        cache_read INTEGER, cache_write INTEGER, cache_write_1h INTEGER, speed TEXT, geo TEXT,
        service_tier TEXT, stop_reason TEXT, error TEXT, parent_agent_id TEXT, provider TEXT,
        route TEXT, via TEXT, what TEXT, thinking INTEGER, totals INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE content (
        request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
        input BLOB, output BLOB, bytes INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '5');
    `);
    const input = gzipSync(Buffer.from("input side"));
    const output = gzipSync(Buffer.from("out"));
    db.run("INSERT INTO requests (id, node_id, ts, totals) VALUES ('r1', 's1/main', 5, 0)");
    db.run("INSERT INTO content (request_id, input, output, bytes) VALUES ('r1', ?, ?, ?)", [
      input,
      output,
      Buffer.byteLength("input side") + Buffer.byteLength("out"),
    ]);
    db.close();

    const history = await openHistory(file);
    // the migrated row answers exactly as it always did, now with lengths a weigh-only read can use
    expect(history.content("r1")).toEqual({
      input: "input side",
      output: "out",
      bytes: Buffer.byteLength("input side") + Buffer.byteLength("out"),
    });
    history.close();
    const probe = await openDb(file);
    const row = probe.get<{ in_len: number | null; out_len: number | null }>(
      "SELECT in_len, out_len FROM content WHERE request_id = 'r1'",
    );
    expect(row?.in_len).toBe(Buffer.byteLength("input side"));
    expect(row?.out_len).toBe(Buffer.byteLength("out"));
    probe.close();
  });

  it("creates a nested parent directory and leaves the database in WAL mode", async () => {
    const file = join(dir, "nested", "deeper", "history.db");
    const history = await openHistory(file);
    history.upsertNode(node({ lastAt: NOW }));
    history.close();
    const probe = await openDb(file);
    expect(probe.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    probe.close();
  });

  it("keeps the file at 0600", async () => {
    const history = await openHistory(join(dir, "history.db"));
    history.close();
    expect(statSync(join(dir, "history.db")).mode & 0o777).toBe(0o600);
  });
});

describe("nodes", () => {
  it("merges: minimum started_at, maximum last_at, null keeps the stored value", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ startedAt: 500, lastAt: 900, cwd: "/work/app", model: "m1", label: "first" }));
    h.upsertNode(node({ startedAt: 300, lastAt: 1200, model: "m2" }));
    h.upsertNode(node({ label: null, cwd: null }));
    const row = h.tree("s1/main")[0];
    expect(row).toMatchObject({
      startedAt: 300,
      lastAt: 1200,
      cwd: "/work/app",
      model: "m2",
      label: "first",
    });
    // a stored null takes the incoming value instead of keeping it
    h.upsertNode(node({ id: "s2/main", sessionId: "s2" }));
    h.upsertNode(node({ id: "s2/main", sessionId: "s2", startedAt: 77, lastAt: 88 }));
    expect(h.tree("s2/main")[0]).toMatchObject({ startedAt: 77, lastAt: 88 });
    h.close();
  });

  it("ends a node and revives it when a later write moves last_at past the end", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ lastAt: 100 }));
    h.endNode("s1/main", 800);
    expect(h.tree("s1/main")[0]?.endedAt).toBe(800);
    h.endNode("s1/main", 500); // an earlier end does not move it back
    expect(h.tree("s1/main")[0]?.endedAt).toBe(800);
    h.upsertNode(node({ lastAt: 900 }));
    expect(h.tree("s1/main")[0]?.endedAt).toBeNull();
    h.close();
  });

  it("moves the root_id of the node and its descendants when the parent changes", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "a/main" }));
    h.upsertNode(node({ id: "a/ag", kind: "subagent", parentId: "a/main", agentId: "ag", lastAt: 50 }));
    h.upsertNode(node({ id: "a/ag/sub", kind: "subagent", parentId: "a/ag", agentId: "sub", lastAt: 40 }));
    h.upsertNode(node({ id: "b/main", sessionId: "b" }));
    h.upsertNode(node({ id: "a/ag", parentId: "b/main" }));
    expect(h.tree("a/main").map((n) => n.id)).toEqual(["a/main"]);
    expect(h.tree("b/main").map((n) => n.id)).toEqual(["b/main", "a/ag", "a/ag/sub"]);
    h.close();
  });

  it("adopts children that named their parent before it existed", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "job:zai:1", kind: "job", parentId: "a/main", sessionId: "s", agentId: "job" }));
    expect(h.tree("a/main")).toEqual([]);
    h.upsertNode(node({ id: "a/main" }));
    expect(h.tree("a/main").map((n) => n.id)).toEqual(["a/main", "job:zai:1"]);
    h.close();
  });

  it("bumps last_at on putRequest, never lowering it with an older request", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ lastAt: 100 }));
    h.putRequest("s1/main", req({ id: "r1", ts: 400 }));
    expect(h.tree("s1/main")[0]?.lastAt).toBe(400);
    h.putRequest("s1/main", req({ id: "r2", ts: 200 }));
    expect(h.tree("s1/main")[0]?.lastAt).toBe(400);
    h.close();
  });
});

describe("content", () => {
  it("round-trips text including nulls and multi-byte characters, gzipped on disk", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node());
    h.putRequest("s1/main", req({ id: "r1" }));
    const text = "héllo ← 世界";
    h.putContent("r1", { input: text, output: null });
    expect(h.content("r1")).toEqual({ input: text, output: null, bytes: Buffer.byteLength(text) });
    h.putContent("r1", { input: null, output: "out" });
    expect(h.content("r1")).toEqual({
      input: text,
      output: "out",
      bytes: Buffer.byteLength(text) + 3,
    });
    expect(h.content("missing")).toBeNull();
    h.close();
    const db = await openDb(join(dir, "history.db"));
    const blob = db.get<{ input: Uint8Array | null; output: Uint8Array | null }>(
      "SELECT input, output FROM content WHERE request_id = 'r1'",
    );
    expect([...(blob?.input ?? [])].slice(0, 2)).toEqual([0x1f, 0x8b]); // stored as gzip, not plain text
    expect([...(blob?.output ?? [])].slice(0, 2)).toEqual([0x1f, 0x8b]);
    db.close();
  });

  it("drops content when its request row goes (ON DELETE CASCADE)", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node());
    h.putRequest("s1/main", req());
    h.putContent("r1", { input: "in", output: "out" });
    const db = await openDb(join(dir, "history.db"));
    db.run("DELETE FROM requests WHERE id = 'r1'");
    db.close();
    expect(h.content("r1")).toBeNull();
    h.close();
  });

  it("merges a streamed rewrite by length and keeps each side's plain text length beside the blob", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node());
    h.putRequest("s1/main", req({ id: "r1" }));
    h.putContent("r1", { input: "hello", output: null });
    h.putContent("r1", { input: "hello there", output: "an answer" }); // both sides grew
    expect(h.content("r1")).toEqual({
      input: "hello there",
      output: "an answer",
      bytes: Buffer.byteLength("hello there") + Buffer.byteLength("an answer"),
    });
    h.putContent("r1", { input: "no", output: null }); // a short retry echo never erases
    expect(h.content("r1")?.input).toBe("hello there");
    h.putContent("r1", { input: "hello _____", output: "answer!" }); // equal length keeps the stored side
    expect(h.content("r1")?.input).toBe("hello there");
    h.putContent("r1", { input: null, output: null }); // a null side keeps what is stored
    expect(h.content("r1")).toEqual({
      input: "hello there",
      output: "an answer",
      bytes: Buffer.byteLength("hello there") + Buffer.byteLength("an answer"),
    });
    h.close();
    const db = await openDb(join(dir, "history.db"));
    const row = db.get<{ in_len: number | null; out_len: number | null }>(
      "SELECT in_len, out_len FROM content WHERE request_id = 'r1'",
    );
    expect(row?.in_len).toBe(Buffer.byteLength("hello there"));
    expect(row?.out_len).toBe(Buffer.byteLength("an answer"));
    db.close();
  });
});

describe("sideOfNext", () => {
  const stored = (): { side: StoredSide; text: string } => {
    const text = "stored text";
    return { side: { blob: gzipSync(Buffer.from(text)), len: Buffer.byteLength(text) }, text };
  };

  it("hands the stored blob back untouched when the incoming text is not longer", () => {
    const { side, text } = stored();
    expect(sideOfNext(side, "short")).toBe(side); // the very blob object: nothing was decompressed
    expect(sideOfNext(side, text)).toBe(side); // equal length keeps the stored side
    expect(sideOfNext(side, null)).toBe(side);
  });

  it("gzips only a side that grew, and a missing stored side takes the incoming text", () => {
    const { side } = stored();
    const grown = sideOfNext(side, "stored text and more");
    expect(grown).not.toBe(side);
    expect(grown.blob === null ? null : gunzipSync(Buffer.from(grown.blob)).toString("utf8")).toBe(
      "stored text and more",
    );
    expect(grown.len).toBe(Buffer.byteLength("stored text and more"));
    const empty: StoredSide = { blob: null, len: null };
    const took = sideOfNext(empty, "fresh");
    expect(took.len).toBe(5);
    expect(took.blob === null ? null : gunzipSync(Buffer.from(took.blob)).toString("utf8")).toBe("fresh");
    expect(sideOfNext(empty, null)).toBe(empty);
  });
});

describe("offsets, tools and events", () => {
  it("stores and replaces one offset per file", async () => {
    const h = await openHistory(join(dir, "history.db"));
    expect(h.offset("spool/a.jsonl")).toBeNull();
    h.setOffset("spool/a.jsonl", { offset: 10, size: 5, mtime: 99 });
    expect(h.offset("spool/a.jsonl")).toEqual({ offset: 10, size: 5, mtime: 99 });
    h.setOffset("spool/a.jsonl", { offset: 20, size: 5, mtime: 99 });
    expect(h.offset("spool/a.jsonl")?.offset).toBe(20);
    h.close();
  });

  it("keeps tool calls and ignores a duplicate event seq", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.putTool("s1/main", {
      id: "t1",
      sessionId: "s1",
      agentId: "main",
      name: "Bash",
      startedAt: 5,
      durationMs: 1,
      ok: true,
      inputKey: "k1",
    });
    h.putTool("s1/main", {
      id: "t2",
      sessionId: "s1",
      agentId: null,
      name: "Read",
      startedAt: 6,
      durationMs: null,
      ok: false,
    });
    h.addEvent("s1/main", {
      seq: 1,
      ts: 7,
      kind: "PostToolUse",
      sessionId: "s1",
      agentId: "main",
      label: null,
      payload: { a: 1 },
    });
    h.addEvent(null, {
      seq: 1,
      ts: 7,
      kind: "PostToolUse",
      sessionId: null,
      agentId: null,
      label: null,
      payload: { a: 1 },
    });
    h.addEvent(null, {
      seq: 2,
      ts: 8,
      kind: "Notice",
      sessionId: null,
      agentId: null,
      label: "limit",
      payload: null,
    });
    const db = await openDb(join(dir, "history.db"));
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tools")?.c).toBe(2);
    expect(
      db.all<{ id: string; ok: number; input_key: string | null }>(
        "SELECT id, ok, input_key FROM tools ORDER BY id",
      ),
    ).toEqual([
      { id: "t1", ok: 1, input_key: "k1" },
      { id: "t2", ok: 0, input_key: null },
    ]);
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM events")?.c).toBe(2);
    expect(
      db.all<{ seq: number; node_id: string | null; payload: string }>(
        "SELECT seq, node_id, payload FROM events ORDER BY seq",
      ),
    ).toEqual([
      { seq: 1, node_id: "s1/main", payload: '{"a":1}' },
      { seq: 2, node_id: null, payload: "null" },
    ]);
    db.close();
    h.close();
  });
});

describe("roots", () => {
  it("splits live trees from history: main sessions only, a job never a top-level root", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "a/main", startedAt: 1, lastAt: NOW, cwd: "/work/app", project: "app" }));
    h.upsertNode(node({ id: "b/main", sessionId: "b", startedAt: 1, lastAt: NOW - 10 * LIVE }));
    h.endNode("b/main", NOW - 9 * LIVE);
    // a job of the ended session reads inside that session's tree, never beside it
    h.upsertNode(
      node({
        id: "job:zai:1",
        kind: "job",
        parentId: "b/main",
        sessionId: "b",
        agentId: "job",
        lastAt: NOW - 11 * LIVE,
        jobState: "awaiting_review",
      }),
    );
    h.upsertNode(
      node({
        id: "job:zai:2",
        kind: "job",
        sessionId: "zai:2",
        agentId: "job",
        lastAt: NOW - 12 * LIVE,
        jobState: "done",
      }),
    );
    expect(h.roots(LIVE_Q).map((r) => r.id)).toEqual(["a/main"]);
    expect(h.roots(HISTORY_Q).map((r) => r.id)).toEqual(["b/main"]);
    expect(h.tree("b/main").map((n) => n.id)).toEqual(["b/main", "job:zai:1"]);
    h.close();
  });

  it("rolls the jobs no session claims into one Unattached group root", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "job:zai:1", kind: "job", sessionId: "zai:1", agentId: "job", lastAt: NOW }));
    h.putRequest("job:zai:1", req({ id: "r1", ts: NOW - 1000, tokens: { ...ZERO_TOKENS, input: 6 } }));
    // a job of a job hangs under its parent job: still one group
    h.upsertNode(
      node({
        id: "job:zai:2",
        kind: "job",
        parentId: "job:zai:1",
        sessionId: "zai:2",
        agentId: "job",
        lastAt: NOW - 500,
      }),
    );
    // a job whose origin session is gone from the store reads as unclaimed too
    h.upsertNode(
      node({
        id: "job:kimi:3",
        kind: "job",
        parentId: "gone/main",
        sessionId: "kimi:3",
        agentId: "job",
        startedAt: NOW - 40 * LIVE,
        lastAt: NOW - 2 * LIVE,
      }),
    );
    h.putRequest("job:kimi:3", req({ id: "r2", sessionId: "kimi:3", ts: NOW - 2 * LIVE }));
    const group = h.unattached({ now: NOW, liveMs: LIVE });
    expect(group).toMatchObject({
      id: OUTSIDE_SESSION,
      sessionId: OUTSIDE_SESSION,
      kind: "job",
      name: UNATTACHED_NAME,
      parentId: null,
      repo: null,
      nodes: 3,
      liveNodes: 2, // the zai pair moved within the live window, the kimi job did not
      requests: 2,
      tokens: { input: 16, output: 4 },
      startedAt: NOW - 40 * LIVE,
      lastAt: NOW,
    });
    expect(group?.activity.counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(h.unattached({ now: NOW + 10 * LIVE, liveMs: LIVE })).toMatchObject({ liveNodes: 0 });
    h.close();
  });

  it("answers null from unattached() when every job found its session", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ lastAt: NOW }));
    h.upsertNode(
      node({
        id: "job:zai:1",
        kind: "job",
        parentId: "s1/main",
        sessionId: "s1",
        agentId: "job",
        lastAt: NOW,
      }),
    );
    expect(h.unattached({ now: NOW, liveMs: LIVE })).toBeNull();
    h.close();
  });

  it("reads the Unattached group's tree and requests through the group's id", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "job:zai:1", kind: "job", sessionId: "zai:1", agentId: "job", lastAt: NOW }));
    h.upsertNode(
      node({
        id: "job:zai:2",
        kind: "job",
        parentId: "job:zai:1",
        sessionId: "zai:2",
        agentId: "job",
        lastAt: NOW - LIVE - 1,
      }),
    );
    h.putRequest("job:zai:2", req({ id: "r1", sessionId: "zai:2", ts: NOW - LIVE - 1 }));
    h.upsertNode(node({ id: "a/main", lastAt: NOW - LIVE })); // a claimed job stays out of the group
    h.upsertNode(
      node({
        id: "job:zai:3",
        kind: "job",
        parentId: "a/main",
        sessionId: "zai:3",
        agentId: "job",
        lastAt: NOW - LIVE,
      }),
    );
    // live first, then by recency: the parent job outranks its quiet child
    expect(h.tree(OUTSIDE_SESSION).map((n) => n.id)).toEqual(["job:zai:1", "job:zai:2"]);
    expect(h.requestsOf({ rootId: OUTSIDE_SESSION, limit: 10 }).map((r) => r.id)).toEqual(["r1"]);
    expect(h.costRows([OUTSIDE_SESSION]).map((row) => row.rootId)).toEqual([OUTSIDE_SESSION]);
    h.close();
  });

  it("rolls requests, tokens and node counts up over the whole tree", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "a/main", startedAt: 1, lastAt: NOW }));
    h.upsertNode(
      node({ id: "a/ag", kind: "subagent", parentId: "a/main", agentId: "ag", lastAt: NOW - 1000 }),
    );
    h.upsertNode(
      node({
        id: "job:zai:1",
        kind: "job",
        parentId: "a/main",
        sessionId: "a",
        agentId: "job",
        lastAt: NOW - 2000,
      }),
    );
    h.putRequest(
      "a/main",
      req({ id: "r1", ts: NOW - 3000, tokens: { ...ZERO_TOKENS, input: 10, output: 4 } }),
    );
    h.putRequest("a/ag", req({ id: "r2", ts: NOW - 2000, tokens: { ...ZERO_TOKENS, input: 7, output: 2 } }));
    h.putRequest(
      "job:zai:1",
      req({ id: "r3", ts: NOW - 1000, tokens: { ...ZERO_TOKENS, input: 1, output: 1 } }),
    );
    const row = h.roots(LIVE_Q)[0];
    expect(row).toMatchObject({
      id: "a/main",
      requests: 3,
      nodes: 3,
      liveNodes: 3,
      lastAt: NOW,
      tokens: { input: 18, output: 7, cacheRead: 0, cacheWrite: 0 },
    });
    h.close();
  });

  it("pages roots by last_at with before", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "c/main", sessionId: "c", lastAt: 300 }));
    h.upsertNode(node({ id: "d/main", sessionId: "d", lastAt: 200 }));
    h.upsertNode(node({ id: "e/main", sessionId: "e", lastAt: 100 }));
    const first = h.roots({ ...HISTORY_Q, limit: 2 });
    expect(first.map((r) => r.id)).toEqual(["c/main", "d/main"]);
    const cutoff = first[1]?.lastAt;
    if (cutoff === undefined) throw new Error("expected a second root");
    const second = h.roots({ ...HISTORY_Q, limit: 2, before: cutoff });
    expect(second.map((r) => r.id)).toEqual(["e/main"]);
    h.close();
  });

  it("rolls a page of roots up with three queries per chunk, never three per root", async () => {
    const file = join(dir, "history.db");
    const writer = await openHistory(file);
    for (let at = 1; at <= 6; at += 1) {
      writer.upsertNode(node({ id: `t${at}/main`, sessionId: `t${at}`, lastAt: 600 - at }));
      writer.putRequest(`t${at}/main`, req({ id: `r${at}`, sessionId: `t${at}`, ts: 600 - at }));
    }
    writer.close();
    const count = countingDb(await openDb(file));
    const h = await openHistory(file, count.db);
    const alls = count.alls.length;
    const roots = h.roots({ ...HISTORY_Q, limit: 6 });
    expect(roots).toHaveLength(6);
    expect(roots[0]).toMatchObject({ id: "t1/main", requests: 1, nodes: 1, tokens: { input: 10 } });
    // the page plus the three roll-up shapes: the old read ran 1 + 3×6
    expect(count.alls.slice(alls)).toHaveLength(4);
    h.close();
  });

  it("keeps the roll-ups exact across a 400-root chunk boundary", async () => {
    const h = await openHistory(join(dir, "history.db"));
    for (let at = 1; at <= 401; at += 1) {
      h.upsertNode(node({ id: `t${at}/main`, sessionId: `t${at}`, lastAt: 600 - at }));
      h.putRequest(`t${at}/main`, req({ id: `r${at}`, sessionId: `t${at}`, ts: 600 - at }));
    }
    const roots = h.roots({ ...HISTORY_Q, limit: 401 });
    expect(roots).toHaveLength(401);
    const first = roots.find((root) => root.id === "t1/main");
    const last = roots.find((root) => root.id === "t401/main");
    expect(first).toMatchObject({ requests: 1, nodes: 1, tokens: { input: 10 } });
    expect(last).toMatchObject({ requests: 1, nodes: 1, tokens: { input: 10 } });
    expect(first?.activity.counts.some((c) => c > 0)).toBe(true);
    expect(last?.activity.counts.some((c) => c > 0)).toBe(true);
    h.close();
  });

  it("searches project, label, model and cwd case-insensitively", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "a/main", lastAt: NOW, project: "app", cwd: "/work/app", label: "Fix the bug" }));
    h.upsertNode(node({ id: "b/main", sessionId: "b", lastAt: NOW, cwd: "/other/site" }));
    const q = { ...LIVE_Q, search: "APP" };
    expect(h.roots(q).map((r) => r.id)).toEqual(["a/main"]);
    expect(h.roots({ ...LIVE_Q, search: "the bug" }).map((r) => r.id)).toEqual(["a/main"]);
    expect(h.roots({ ...LIVE_Q, search: "site" }).map((r) => r.id)).toEqual(["b/main"]);
    expect(h.roots({ ...LIVE_Q, search: "%zzz" })).toEqual([]);
    h.close();
  });

  it("groups each tree's requests into 48 activity buckets, live window or whole span", async () => {
    const h = await openHistory(join(dir, "history.db"));
    // an ended tree: its 80-minute run stretches start-to-last over 48 buckets of 100,000 ms
    h.upsertNode(node({ id: "a/main", startedAt: NOW - 4_800_000, lastAt: NOW }));
    h.putRequest("a/main", req({ id: "r1", ts: NOW - 4_750_000, model: "glm-5.3" }));
    h.putRequest("a/main", req({ id: "r2", ts: NOW - 30_000, model: "kimi-k2.5" }));
    h.endNode("a/main", NOW);
    // a live tree: its window is the last liveMs ending now, 60,000 ms here in buckets of 1,250
    h.upsertNode(node({ id: "b/main", sessionId: "b", startedAt: NOW - 4_800_000, lastAt: NOW }));
    h.putRequest("b/main", req({ id: "r3", sessionId: "b", ts: NOW - 30_000 }));
    const ended = h.roots(HISTORY_Q).find((r) => r.id === "a/main");
    expect(ended?.activity.bucketMs).toBe(100_000);
    expect(ended?.activity.counts[0]).toBe(1);
    expect(ended?.activity.counts[47]).toBe(1);
    expect(ended?.activity.models[0]).toBe("glm-5.3");
    expect(ended?.activity.models[47]).toBe("kimi-k2.5");
    const live = h.roots(LIVE_Q).find((r) => r.id === "b/main");
    expect(live?.activity.bucketMs).toBe(1_250);
    expect(live?.activity.counts[24]).toBe(1);
    expect(live?.activity.models[24]).toBe("glm-5.3-flash");
    // a tree without requests is 48 silent buckets
    h.upsertNode(node({ id: "c/main", sessionId: "c", startedAt: NOW - 1_000, lastAt: NOW }));
    const silent = h.roots(LIVE_Q).find((r) => r.id === "c/main");
    expect(silent?.activity.counts.every((count) => count === 0)).toBe(true);
    expect(silent?.activity.models.every((model) => model === "")).toBe(true);
    h.close();
  });
});

describe("tree", () => {
  it("orders the root first, then live before ended, then newest last_at", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "a/main", lastAt: NOW - 100 }));
    h.upsertNode(
      node({ id: "a/ended", kind: "subagent", parentId: "a/main", agentId: "ended", lastAt: NOW - 200 }),
    );
    h.upsertNode(node({ id: "a/live", kind: "subagent", parentId: "a/main", agentId: "live", lastAt: NOW }));
    h.endNode("a/ended", NOW - 199);
    h.putRequest("a/live", req({ id: "r1", ts: NOW }));
    const rows = h.tree("a/main", { now: NOW, liveMs: LIVE });
    expect(rows.map((n) => n.id)).toEqual(["a/main", "a/live", "a/ended"]);
    expect(rows.map((n) => n.live)).toEqual([true, true, false]);
    const live = rows[1];
    expect(live?.requests).toBe(1);
    expect(rows[2]?.requests).toBe(0);
    expect(h.tree("missing")).toEqual([]);
    h.close();
  });
});

describe("requestsOf", () => {
  it("reads by node and by tree with keyset paging and no duplicates across pages", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "a/main" }));
    h.upsertNode(node({ id: "a/ag", kind: "subagent", parentId: "a/main", agentId: "ag" }));
    h.putRequest("a/main", req({ id: "r1", ts: 100 }));
    h.putRequest("a/main", req({ id: "r3", ts: 100 }));
    h.putRequest("a/main", req({ id: "r2", ts: 200 }));
    h.putRequest("a/ag", req({ id: "r4", ts: 300, agentId: "ag" }));
    expect(h.requestsOf({ nodeId: "a/main", limit: 10 }).map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
    const page1 = h.requestsOf({ rootId: "a/main", limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(["r4", "r2"]);
    const page2 = h.requestsOf({ rootId: "a/main", limit: 2, before: { ts: 200, id: "r2" } });
    expect(page2.map((r) => r.id)).toEqual(["r3", "r1"]);
    expect([...page1, ...page2].map((r) => r.id)).toEqual(["r4", "r2", "r3", "r1"]);
    expect(h.requestsOf({ limit: 10 }).map((r) => r.id)).toEqual(["r4", "r2", "r3", "r1"]);
    h.close();
  });

  it("reads a sparse row with null columns as a well-formed record", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node());
    const db = await openDb(join(dir, "history.db"));
    db.run("INSERT INTO requests (id, node_id, ts, totals) VALUES ('raw', 's1/main', 5, 0)");
    db.close();
    expect(h.requestsOf({ nodeId: "s1/main", limit: 10 })).toEqual([
      {
        id: "raw",
        sessionId: "",
        agentId: "",
        model: "",
        upstream: "",
        ts: 5,
        latencyMs: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: null,
        provider: "",
      },
    ]);
    h.close();
  });

  it("round-trips every request field, what, thinking, route, via and totals", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node());
    h.putRequest(
      "s1/main",
      req({
        id: "full",
        route: "provider",
        via: "zai",
        totals: true,
        stopReason: "end_turn",
        latencyMs: 42,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 1 },
        what: "↳ prompt: fix the limiter  → Edit store.ts, Bash git status",
      }),
    );
    h.putRequest("s1/main", req({ id: "plain" }));
    const rows = h.requestsOf({ nodeId: "s1/main", limit: 10 });
    expect(rows).toEqual([
      req({
        id: "plain",
        ts: 1000,
      }),
      req({
        id: "full",
        route: "provider",
        via: "zai",
        totals: true,
        stopReason: "end_turn",
        latencyMs: 42,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 1 },
        what: "↳ prompt: fix the limiter  → Edit store.ts, Bash git status",
      }),
    ]);
    h.close();
  });
});

describe("context", () => {
  const TURNS = 120;

  /** A node whose every request carries a JSON input and output side, ts ascending from 1000. */
  async function conversation(name: string): Promise<History> {
    const h = await openHistory(join(dir, name));
    h.upsertNode(node());
    for (let at = 1; at <= TURNS; at += 1) {
      h.putRequest("s1/main", req({ id: `r${at}`, ts: 1000 + at }));
      h.putContent(`r${at}`, {
        input: JSON.stringify([{ type: "text", text: `in ${at}` }]),
        output: JSON.stringify([{ type: "text", text: `out ${at}` }]),
      });
    }
    return h;
  }

  /** The conversation as the reader sees it: one turn per stored side, the target's answer never there. */
  function expectedTurns(): { role: string; requestId: string; text: string }[] {
    const turns: { role: string; requestId: string; text: string }[] = [];
    for (let at = 1; at <= TURNS; at += 1) {
      turns.push({ role: "user", requestId: `r${at}`, text: `in ${at}` });
      if (at < TURNS) turns.push({ role: "assistant", requestId: `r${at}`, text: `out ${at}` });
    }
    return turns;
  }

  it("serves one page from a bounded read, never the whole conversation", async () => {
    const file = join(dir, "history.db");
    const writer = await conversation("history.db");
    writer.close();
    const count = countingDb(await openDb(file));
    const h = await openHistory(file, count.db);
    const alls = count.alls.length;
    const gets = count.gets.length;
    const page = h.context(`r${TURNS}`, { limit: 40 });
    const read = count.alls.slice(alls);
    expect(read).toHaveLength(1); // one page query — the old read selected every row of the node
    expect(read[0]?.rows).toBeLessThanOrEqual(42); // limit + 2 rows, never the whole conversation
    expect(count.gets.slice(gets)).toHaveLength(2); // the target and the sides' one aggregate
    expect(page?.messages).toHaveLength(40);
    expect(page?.totals.messages).toBe(2 * TURNS - 1); // every side but the target's own answer
    // the sides weigh what is stored — the JSON of each block list — minus the target's own answer
    const bytesOf = (side: string, at: number): number =>
      Buffer.byteLength(JSON.stringify([{ type: "text", text: `${side} ${at}` }]));
    let bytes = 0;
    for (let at = 1; at <= TURNS; at += 1) bytes += bytesOf("in", at) + bytesOf("out", at);
    expect(page?.totals.approxTokens).toBe(Math.round((bytes - bytesOf("out", TURNS)) / 4));
    h.close();
  });

  /** The conversation as paging rebuilds it: every page prepended, oldest first. */
  function pagedWhole(h: History, requestId: string, limit: number): ContextMessage[] {
    const paged: ContextMessage[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 40; pages += 1) {
      const page = h.context(requestId, cursor === null ? { limit } : { limit, cursor });
      if (page === null || page.messages.length === 0) break;
      paged.unshift(...page.messages);
      cursor = page.next;
      if (cursor === null) break;
    }
    return paged;
  }

  it("pages the whole conversation through next, oldest page first, in the stored order", async () => {
    const h = await conversation("history.db");
    const whole = h.context(`r${TURNS}`, { limit: 1000 });
    const paged = pagedWhole(h, `r${TURNS}`, 7);
    const slim = (messages: ContextMessage[]): unknown[] =>
      messages.map((message) => ({
        role: message.role,
        requestId: message.requestId,
        text: (message.blocks[0] as { text?: string }).text,
      }));
    expect(slim(whole?.messages ?? [])).toEqual(expectedTurns());
    expect(slim(paged)).toEqual(expectedTurns());
    h.close();
  });

  it("answers an empty page to a cursor the node never named", async () => {
    const h = await conversation("history.db");
    const page = h.context(`r${TURNS}`, { limit: 40, cursor: "1:r999:0" });
    expect(page?.messages).toEqual([]);
    expect(page?.next).toBeNull();
    h.close();
  });
});

describe("prune, clear and stats", () => {
  it("removes only trees where every node is old, rows included, and returns the count", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ id: "o/main", sessionId: "o", lastAt: 10 }));
    h.upsertNode(node({ id: "o/ag", kind: "subagent", parentId: "o/main", agentId: "ag", lastAt: 20 }));
    h.putRequest("o/main", req({ id: "old", ts: 10 }));
    h.putContent("old", { input: "in", output: "out" });
    h.putTool("o/main", {
      id: "t1",
      sessionId: "o",
      agentId: "main",
      name: "Bash",
      startedAt: 10,
      durationMs: 1,
      ok: true,
    });
    h.addEvent("o/main", {
      seq: 1,
      ts: 10,
      kind: "Notice",
      sessionId: "o",
      agentId: null,
      label: null,
      payload: null,
    });
    h.upsertNode(node({ id: "y/main", sessionId: "y", lastAt: 5000 }));
    h.putRequest("y/main", req({ id: "new", ts: 5000 }));
    // a tree whose subagent has no last_at is never stale
    h.upsertNode(node({ id: "n/main", sessionId: "n", lastAt: 5 }));
    h.upsertNode(node({ id: "n/ag", kind: "subagent", parentId: "n/main", agentId: "ag" }));
    expect(h.prune(1000)).toBe(1);
    expect(h.prune(1000)).toBe(0);
    expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 })).toMatchObject({ nodes: 3, requests: 1 });
    expect(h.content("old")).toBeNull();
    expect(h.requestsOf({ nodeId: "y/main", limit: 10 }).map((r) => r.id)).toEqual(["new"]);
    const db = await openDb(join(dir, "history.db"));
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tools")?.c).toBe(0);
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM events")?.c).toBe(0);
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE root_id = 'o/main'")?.c).toBe(0);
    db.close();
    h.close();
  });

  it("empties every table but meta on clear", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.upsertNode(node({ lastAt: NOW }));
    h.putRequest("s1/main", req());
    h.putContent("r1", { input: "in", output: null });
    h.setOffset("f", { offset: 1, size: 1, mtime: 1 });
    h.clear();
    expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 })).toMatchObject({ nodes: 0, requests: 0 });
    expect(h.offset("f")).toBeNull();
    const db = await openDb(join(dir, "history.db"));
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe(
      String(SCHEMA_VERSION),
    );
    expect(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM content")?.c).toBe(0);
    db.close();
    h.close();
  });

  it("counts file bytes, nodes and requests", async () => {
    const h = await openHistory(join(dir, "history.db"));
    expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 })).toMatchObject({ nodes: 0, requests: 0 });
    expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 }).bytes).toBeGreaterThan(0);
    h.upsertNode(node({ lastAt: NOW }));
    h.putRequest("s1/main", req());
    expect(h.stats({ now: Date.now(), liveMs: 15 * 60_000 })).toMatchObject({ nodes: 1, requests: 1 });
    h.close();
  });
});

describe("transactions and the driver", () => {
  it("commits, rolls back on throw, and runs nested calls without a second BEGIN", async () => {
    const h = await openHistory(join(dir, "history.db"));
    h.transaction(() => h.upsertNode(node({ id: "kept" })));
    expect(() =>
      h.transaction(() => {
        h.upsertNode(node({ id: "dropped" }));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    h.transaction(() => h.transaction(() => h.upsertNode(node({ id: "nested" }))));
    const ids = h.roots(HISTORY_Q).map((r) => r.id);
    expect(ids).toContain("kept");
    expect(ids).toContain("nested");
    expect(ids).not.toContain("dropped");
    h.close();
  });

  it("exposes exec, all, get and run with and without parameters", async () => {
    const db = await openDb(join(dir, "history.db"));
    migrate(db);
    expect(db.get<{ one: number }>("SELECT 1 AS one")?.one).toBe(1);
    expect(db.all<{ one: number }>("SELECT 1 AS one WHERE 0")).toEqual([]);
    expect(
      db.run("INSERT INTO offsets (file, offset, size, mtime) VALUES (?, ?, ?, ?)", ["f", 1, 2, 3]).changes,
    ).toBe(1);
    expect(db.all<{ file: string }>("SELECT file FROM offsets WHERE file = ?", ["f"])).toHaveLength(1);
    db.close();
  });

  it("adapts the bun:sqlite shape: rows, a null row read as undefined, changes as number", async () => {
    const rows = new Map<string, unknown[]>([
      ["SELECT 1 AS one", [{ one: 1 }]],
      ["SELECT 2 AS two", []],
    ]);
    let changes: { changes?: number | bigint } | undefined = { changes: 3n };
    const statement = {
      all: (sql: string) => rows.get(sql) ?? [],
      get: (sql: string) => (rows.get(sql) ?? [null])[0],
      run: () => changes,
    };
    class FakeDatabase {
      exec(): void {}
      query(sql: string) {
        return {
          ...statement,
          all: () => statement.all(sql),
          get: () => statement.get(sql),
          run: statement.run,
        };
      }
      close(): void {}
    }
    const db = bunDriver("unused", { Database: FakeDatabase });
    expect(db.get<{ one: number }>("SELECT 1 AS one")?.one).toBe(1);
    expect(db.get<{ two: number }>("SELECT 2 AS two")).toBeUndefined(); // bun returns null for no row
    expect(db.all<{ one: number }>("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    expect(db.all("SELECT 2 AS two")).toEqual([]);
    expect(db.run("anything").changes).toBe(3); // bigint changes become a number
    changes = undefined;
    expect(db.run("anything").changes).toBe(0);
    db.close();
  });
});
