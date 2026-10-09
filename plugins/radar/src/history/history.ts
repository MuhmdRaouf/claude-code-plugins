/**
 * The persistent history: one SQLite file holding whole session trees (main session, subagents, jobs),
 * their requests with gzipped input/output text, tool calls, events and file offsets. Survives restarts
 * and outlives the transcripts and worktrees, so the dashboard can show what ran after the raw data is
 * gone. All methods are synchronous after open; every write is a plain statement, and a read groups its
 * roll-ups over the trees an IN list names — one query per 400 roots, never one per root.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Activity, EventRecord, RequestRecord, Tokens, ToolCallRecord } from "../shared/model.ts";
import { ACTIVITY_BUCKETS, OUTSIDE_SESSION, UNATTACHED_NAME } from "../shared/model.ts";
import { repoName } from "../shared/repo.ts";
import { activityFromRows } from "../store/activity.ts";
import { type Db, openDb, type SqlValue } from "./driver.ts";
import { isizeOf, migrate } from "./schema.ts";

export type NodeKind = "main" | "subagent" | "job";

/** Column names map to camelCase fields; a null or absent field keeps the stored value on merge. */
export type NodeUpsert = {
  id: string;
  kind: NodeKind;
  sessionId: string;
  agentId: string;
  parentId?: string | null;
  label?: string | null;
  agentType?: string | null;
  description?: string | null;
  project?: string | null;
  cwd?: string | null;
  model?: string | null;
  provider?: string | null;
  toolUseId?: string | null;
  spawnDepth?: number | null;
  jobState?: string | null;
  /** The workspace a session tree ran in: the repo root, its branch, the session's own name, and the
   *  session a job was submitted from. They name the tree after the worktrees are deleted. */
  repo?: string | null;
  branch?: string | null;
  name?: string | null;
  parentSessionId?: string | null;
  startedAt?: number | null;
  lastAt?: number | null;
  /** Set when the view says the session ended; null clears a stale end (a session that came back). */
  endedAt?: number | null;
};

export type RootsQuery = {
  scope: "live" | "history";
  now: number;
  liveMs: number;
  limit: number;
  before?: number;
  search?: string;
  /** Exact match on the root's own repo (the workspace a session tree ran in). */
  repo?: string;
  /** Session ids the history scope keeps out: the registry's live ones, so a session that is open but
   *  quiet for a while never reads as ended. Applied in the query, so paging and counts stay exact. */
  excludeSessions?: string[];
};

export type RequestsQuery = {
  nodeId?: string;
  rootId?: string;
  before?: { ts: number; id: string };
  limit: number;
};

/** What the one Unattached group needs: the clock that tells a still-running job from an ended one. */
export type UnattachedQuery = { now: number; liveMs: number };

/** One token-flow read: the window, the width of a bar and how many bars the chart draws. */
export type FlowQuery = { from: number; to: number; bucketMs: number; buckets: number };

/** The flow a chart draws: one request count and one series per token kind, zero-filled, oldest bucket
 *  first. A request past the last bucket (the window's right edge, or a cap) counts in that last bucket. */
export type FlowSeries = {
  from: number;
  to: number;
  bucketMs: number;
  requests: number[];
  kinds: { input: number[]; output: number[]; cacheRead: number[]; cacheWrite: number[] };
};

/** One page of a request's rebuilt conversation: the newest `limit` messages, or the ones before `cursor`. */
export type ContextQuery = { limit: number; cursor?: string };

/** One turn of the conversation as the model saw it: one stored side of one request. */
export type ContextMessage = {
  role: "user" | "assistant";
  /** The first block's type ("text", "tool_result", "tool_use", "thinking", …): what the turn is made of. */
  kind: string;
  requestId: string;
  ts: number;
  /** The stored side's own byte size, the way content() counts it. */
  bytes: number;
  /** The first line of the first block that carries text, for the collapsed row. */
  preview: string;
  /** The side's blocks, wire shapes as stored (their texts are capped at capture). */
  blocks: unknown[];
};

/** A rebuilt conversation: every message up to and including the request's input, newest last. */
export type ContextAnswer = {
  requestId: string;
  nodeId: string;
  model: string;
  totals: {
    messages: number;
    /** The whole conversation's bytes divided by four, the usual characters-per-token rule of thumb. */
    approxTokens: number;
    /** The request's own reported usage; null when the provider sent none. */
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
    /** How much of that usage was cache (reads plus writes); 0 without a usage report. */
    cacheTokens: number;
  };
  messages: ContextMessage[];
  /** The cursor of the page before this one ("<ts>:<requestId>:<side>"), null at the conversation's start. */
  next: string | null;
};

/** One request's captured prompt: the system prompt and tool definitions the request carried, read back
 *  decompressed, with the plain size the capture weighed and the response headers the route stored. */
export type CaptureAnswer = {
  hash: string;
  system: unknown;
  tools: unknown;
  bytes: number;
  /** The allow-listed response headers the route event carried; null when it carried none. */
  headers: Record<string, string> | null;
};

/** The fields one request's cost estimate reads, joined with the node and tree it rolled into. */
export type CostRow = {
  nodeId: string;
  rootId: string;
  model: string | null;
  upstream: string | null;
  ts: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite1h: number | null;
  speed: string | null;
  geo: string | null;
  serviceTier: string | null;
};

type NodeFields = {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  sessionId: string;
  agentId: string;
  label: string | null;
  agentType: string | null;
  description: string | null;
  project: string | null;
  cwd: string | null;
  model: string | null;
  provider: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
  jobState: string | null;
  repo: string | null;
  branch: string | null;
  name: string | null;
  parentSessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastAt: number;
};

/** A top-level node with roll-ups over its whole tree. */
export type RootSummary = NodeFields & {
  requests: number;
  tokens: Tokens;
  nodes: number;
  liveNodes: number;
  lastAt: number;
  /** Request activity over 48 buckets, grouped in SQL over the whole tree. */
  activity: Activity;
};

/** Every node of one tree, each with its own request roll-up and live flag. */
export type TreeNodeRow = NodeFields & {
  live: boolean;
  requests: number;
  tokens: Tokens;
};

export type History = {
  transaction<T>(fn: () => T): T;
  upsertNode(n: NodeUpsert): void;
  endNode(id: string, at: number): void;
  putRequest(nodeId: string, r: RequestRecord): void;
  putContent(requestId: string, c: { input: string | null; output: string | null }): void;
  content(requestId: string): { input: string | null; output: string | null; bytes: number } | null;
  /** One distinct prompt's gzip bytes, stored once per hash: the first request carrying it wins, and the
   *  bytes go down exactly as they came, never re-expanded. */
  putCapture(c: { hash: string; gz: string; firstTs: number }): void;
  /** A request's captured prompt, decompressed on read; null when the request, its hash or its content
   *  is not in the store (a capture the router never wrote, or one that failed to parse). */
  capture(requestId: string): CaptureAnswer | null;
  putTool(nodeId: string, t: ToolCallRecord): void;
  addEvent(nodeId: string | null, e: EventRecord): void;
  offset(file: string): { offset: number; size: number; mtime: number } | null;
  setOffset(file: string, o: { offset: number; size: number; mtime: number }): void;
  roots(q: RootsQuery): RootSummary[];
  /** The one Unattached group — every job no session claims, rolled up together — or null when there is
   *  none. Its id is the unattached pseudo session, so the rail groups it on its own and its tree,
   *  requests and costs read through the same id. */
  unattached(q: UnattachedQuery): RootSummary | null;
  tree(rootId: string, q?: { now?: number; liveMs?: number }): TreeNodeRow[];
  requestsOf(q: RequestsQuery): RequestRecord[];
  /** The conversation a request sat in, rebuilt from the stored sides of its node's requests, paged from
   *  the newest message backwards; null when no request row carries the id. */
  context(requestId: string, q: ContextQuery): ContextAnswer | null;
  /** An agent's whole conversation — every stored turn of its requests, the newest answer included —
   *  paged the same way; null when no node carries the id, an empty conversation when the node holds
   *  no stored requests (an agent that never ran, not an unknown one). */
  agentTranscript(nodeId: string, q: ContextQuery): ContextAnswer | null;
  /** Every request of the named trees with the fields a cost estimate reads, in a few batched queries. */
  costRows(rootIds: string[]): CostRow[];
  /** Requests and token kinds per bucket over one window: one GROUP BY, bucket = (ts - from) / bucketMs. */
  flow(q: FlowQuery): FlowSeries;
  /** The repos top-level trees ran in, with their root counts, most-used first. */
  repos(): { repo: string; roots: number }[];
  /** The store's size, its row counts, and how many ended sessions history holds — the rail's History
   *  badge reads that count before the tab is ever opened, so it carries the live exclusions too. */
  stats(q: { now: number; liveMs: number; excludeSessions?: string[] }): {
    bytes: number;
    nodes: number;
    requests: number;
    roots: number;
  };
  prune(cutoff: number): number;
  clear(): void;
  close(): void;
};

type NodeRow = {
  id: string;
  kind: string;
  parent_id: string | null;
  root_id: string;
  session_id: string;
  agent_id: string;
  label: string | null;
  agent_type: string | null;
  description: string | null;
  project: string | null;
  cwd: string | null;
  model: string | null;
  provider: string | null;
  tool_use_id: string | null;
  spawn_depth: number | null;
  job_state: string | null;
  repo: string | null;
  branch: string | null;
  name: string | null;
  parent_session_id: string | null;
  started_at: number | null;
  last_at: number | null;
  ended_at: number | null;
};

type RequestRow = {
  id: string;
  session_id: string | null;
  agent_id: string | null;
  model: string | null;
  upstream: string | null;
  ts: number;
  latency_ms: number | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cache_write_1h: number | null;
  speed: string | null;
  geo: string | null;
  service_tier: string | null;
  stop_reason: string | null;
  error: string | null;
  parent_agent_id: string | null;
  provider: string | null;
  route: string | null;
  via: string | null;
  what: string | null;
  thinking: number | null;
  prompt_hash: string | null;
  headers: string | null;
  totals: number;
};

type RequestTotals = {
  node_id: string;
  requestCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

const NODE_COLUMNS =
  "id, kind, parent_id, root_id, session_id, agent_id, label, agent_type, description, project, cwd, " +
  "model, provider, tool_use_id, spawn_depth, job_state, repo, branch, name, parent_session_id, " +
  "started_at, last_at, ended_at";

const INSERT_NODE =
  "INSERT INTO nodes (id, kind, parent_id, root_id, session_id, agent_id, label, agent_type, description, " +
  "project, cwd, model, provider, tool_use_id, spawn_depth, job_state, repo, branch, name, " +
  "parent_session_id, started_at, last_at, ended_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_NODE =
  "UPDATE nodes SET kind = ?, parent_id = ?, root_id = ?, session_id = ?, agent_id = ?, label = ?, " +
  "agent_type = ?, description = ?, project = ?, cwd = ?, model = ?, provider = ?, tool_use_id = ?, " +
  "spawn_depth = ?, job_state = ?, repo = ?, branch = ?, name = ?, parent_session_id = ?, " +
  "started_at = ?, last_at = ?, ended_at = ? WHERE id = ?";

/** ON CONFLICT DO UPDATE, not REPLACE: re-putting a request must not cascade-delete its content row. */
const UPSERT_REQUEST =
  "INSERT INTO requests (id, node_id, session_id, agent_id, model, upstream, ts, latency_ms, " +
  "input, output, cache_read, cache_write, cache_write_1h, speed, geo, service_tier, stop_reason, " +
  "error, parent_agent_id, provider, route, via, what, thinking, prompt_hash, headers, totals) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, session_id = excluded.session_id, " +
  "agent_id = excluded.agent_id, model = excluded.model, upstream = excluded.upstream, ts = excluded.ts, " +
  "latency_ms = excluded.latency_ms, input = excluded.input, output = excluded.output, " +
  "cache_read = excluded.cache_read, cache_write = excluded.cache_write, " +
  "cache_write_1h = excluded.cache_write_1h, speed = excluded.speed, geo = excluded.geo, " +
  "service_tier = excluded.service_tier, stop_reason = excluded.stop_reason, error = excluded.error, " +
  "parent_agent_id = excluded.parent_agent_id, provider = excluded.provider, " +
  "route = excluded.route, via = excluded.via, what = excluded.what, " +
  "thinking = excluded.thinking, prompt_hash = excluded.prompt_hash, headers = excluded.headers, " +
  "totals = excluded.totals";
const REQUEST_COLUMNS =
  "id, node_id, session_id, agent_id, model, upstream, ts, latency_ms, input, output, cache_read, " +
  "cache_write, cache_write_1h, speed, geo, service_tier, stop_reason, error, " +
  "parent_agent_id, provider, route, via, what, thinking, prompt_hash, headers, totals";

/** Every node of the tree rooted at ?; plain UNION (not UNION ALL) stops a stray parent cycle. */
const TREE_IDS =
  "WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT n.id FROM nodes n JOIN tree ON n.parent_id = tree.id)";

/** The trees of the jobs no node claims: a job is top-level exactly when nothing holds its parent row —
 *  no origin session was ever written, or its row is gone. The history view shows them all as the one
 *  Unattached group (a job whose origin session exists reads inside that session's tree instead). */
const UNATTACHED_TREES =
  "(SELECT id FROM nodes j WHERE j.kind = 'job' AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = j.parent_id))";

/** A node is live when it moved within liveMs and nothing ended it; a tree is live when any node is. */
const LIVE_SQL = "last_at IS NOT NULL AND last_at >= ? AND ended_at IS NULL";

/** tree(rootId) reads the live rule with these when the caller gives no clock. */
const DEFAULT_LIVE_MS = 5 * 60_000;
const MAX_DEPTH = 64;

function likeOf(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function minOf(a: number | null, b: number | null | undefined): number | null {
  if (b === null || b === undefined) return a;
  return a === null ? b : Math.min(a, b);
}

function maxOf(a: number | null, b: number | null | undefined): number | null {
  if (b === null || b === undefined) return a;
  return a === null ? b : Math.max(a, b);
}

function tokensOf(t: RequestTotals | undefined): Tokens {
  return {
    input: t?.inputTokens ?? 0,
    output: t?.outputTokens ?? 0,
    cacheRead: t?.cacheReadTokens ?? 0,
    cacheWrite: t?.cacheWriteTokens ?? 0,
  };
}

function gzipOf(text: string | null): Uint8Array | null {
  return text === null ? null : gzipSync(Buffer.from(text, "utf8"));
}

/** One side of a content row as the merge rule reads it: the blob and its plain text length. */
export type StoredSide = { blob: Uint8Array | null; len: number | null };

/**
 * One side of a rewrite, decided by the stored length before anything decompresses: the stored blob
 * stands while the incoming text is not strictly longer, so a streamed message rewritten in place wins
 * and a short retry echo never erases what it held — and a kept side is reused as it stands, gzipped
 * fresh only when it grew. A null incoming keeps the stored side whatever it is.
 */
export function sideOfNext(stored: StoredSide, incoming: string | null): StoredSide {
  if (incoming === null) return stored;
  const len = Buffer.byteLength(incoming);
  if (stored.blob !== null && (stored.len ?? 0) >= len) return stored;
  return { blob: gzipOf(incoming), len };
}

function ungzipOf(blob: Uint8Array | null): string | null {
  return blob === null ? null : gunzipSync(Buffer.from(blob)).toString("utf8");
}

/** A capture blob's `{system, tools}` payload, or null when it does not read back as one. */
function capturePayloadOf(blob: Uint8Array): { system?: unknown; tools?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(ungzipOf(blob) ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as { system?: unknown; tools?: unknown };
  } catch {
    return null;
  }
}

/** The characters of a preview line before it is cut. */
const PREVIEW_CHARS = 200;

/** A stored side as the blocks it carries: a JSON array as it stands, plain text as one text block. */
function sideBlocks(text: string | null): unknown[] {
  if (text === null || text === "") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // a side that never was JSON is one text block
  }
  return [{ type: "text", text }];
}

/** The first line of the first block that carries text, cut for a collapsed row. */
function previewOf(blocks: unknown[]): string {
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || text === "") continue;
    const line = text.split("\n", 1)[0] ?? "";
    return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line;
  }
  return "";
}

/** What the first block is made of, for the collapsed row's kind. */
function kindOf(blocks: unknown[]): string {
  const first = blocks[0];
  if (typeof first !== "object" || first === null) return "unknown";
  const type = (first as { type?: unknown }).type;
  return typeof type === "string" && type !== "" ? type : "unknown";
}

/** The page cursor of one message: its request's ts and id plus which side of it, ids may hold colons. */
const messageKey = (message: { ts: number; requestId: string; side: 0 | 1 }): string =>
  `${message.ts}:${message.requestId}:${message.side}`;

/** One conversation turn with the paging side it came from. */
type ContextTurn = ContextMessage & { side: 0 | 1 };

/** One request row with its stored sides. */
type ContextRow = { id: string; ts: number; cin: Uint8Array | null; cout: Uint8Array | null };

/** One stored side as a turn, or null when the side holds nothing. */
function turnOf(
  role: "user" | "assistant",
  row: ContextRow,
  side: 0 | 1,
  text: string | null,
): ContextTurn | null {
  const blocks = sideBlocks(text);
  if (blocks.length === 0) return null;
  return {
    role,
    kind: kindOf(blocks),
    requestId: row.id,
    ts: row.ts,
    bytes: Buffer.byteLength(text ?? "", "utf8"),
    preview: previewOf(blocks),
    blocks,
    side,
  };
}

/** The page cursor of one message as its parts. */
type Cursor = { ts: number; requestId: string; side: 0 | 1 };

function cursorOf(raw: string): Cursor | null {
  const match = /^(\d+):(.+):([01])$/s.exec(raw);
  if (match === null) return null;
  return {
    ts: Number.parseInt(match[1] ?? "", 10),
    requestId: match[2] ?? "",
    side: match[3] === "1" ? 1 : 0,
  };
}

/** The row's user-side turn, pushed when the side holds one. */
function pushUserTurn(turns: ContextTurn[], row: ContextRow): void {
  const user = turnOf("user", row, 0, ungzipOf(row.cin));
  if (user !== null) turns.push(user);
}

/** The row's answer turn, pushed when the side holds one. */
function pushAnswerTurn(turns: ContextTurn[], row: ContextRow): void {
  const answer = turnOf("assistant", row, 1, ungzipOf(row.cout));
  if (answer !== null) turns.push(answer);
}

/** One row's turns, newest first: the answer (unless the row is the target — its own answer came
 *  after the input the model saw), then the input. */
function turnsOfRow(requestId: string, row: ContextRow): ContextTurn[] {
  const turns: ContextTurn[] = [];
  if (row.id !== requestId) pushAnswerTurn(turns, row);
  pushUserTurn(turns, row);
  return turns;
}

/** What one row hands a paged walk: its turns — the side before the cursor's turn alone on the
 *  cursor's own row — or "missing" when the cursor names a side the row does not carry. */
function rowTurns(requestId: string, row: ContextRow, cursor: Cursor | null): ContextTurn[] | "missing" {
  if (cursor !== null && row.id === cursor.requestId && row.ts === cursor.ts) {
    const held = cursor.side === 0 ? row.cin : row.cout;
    if (held === null) return "missing";
    const turns: ContextTurn[] = [];
    if (cursor.side === 1) pushUserTurn(turns, row);
    return turns;
  }
  return turnsOfRow(requestId, row);
}

/** The rows as turns, newest first, capped one past the page. */
function pageTurns(
  requestId: string,
  rows: ContextRow[],
  cursor: Cursor | null,
  limit: number,
): ContextTurn[] | null {
  const turns: ContextTurn[] = [];
  for (const row of rows) {
    const next = rowTurns(requestId, row, cursor);
    if (next === "missing") return null; // the cursor names a side the row lacks
    turns.push(...next);
    if (turns.length > limit) break; // the page and the next-older turn are in hand
  }
  return turns;
}

/**
 * One page of the conversation, read backwards from the target (or from the cursor's row) with a LIMIT,
 * so only the rows the page shows are ever decompressed: each fetched row yields its answer then its
 * input, newest first, until `limit` turns and the one older turn `next` names are in hand — the walk
 * fetches `limit + 2` rows, and a row yields two turns at most, so that always fits. A cursor skips the
 * sides at and after its own turn, and a cursor this node never named (or one naming a side the row
 * does not carry) answers an empty page, as a cursor to nothing always has.
 */
/** The empty page a cursor to nothing always answered. */
const EMPTY_PAGE: { messages: ContextMessage[]; next: string | null } = { messages: [], next: null };

/** The page and its cursor: the newest `limit` turns, oldest first; `next` names the page's own oldest
 *  turn, and the page before it is every turn older than that. */
function pageAnswer(
  turns: ContextTurn[],
  limit: number,
): { messages: ContextMessage[]; next: string | null } {
  const page = turns.slice(0, limit);
  const older = turns.length > limit ? page.at(-1) : undefined;
  return {
    messages: page
      .slice()
      .reverse()
      .map(({ side, ...message }) => message),
    next: older === undefined ? null : messageKey(older),
  };
}

function contextPageOf(
  db: Db,
  requestId: string,
  target: { node_id: string; ts: number },
  q: ContextQuery,
): { messages: ContextMessage[]; next: string | null } {
  const limit = Math.max(0, q.limit);
  const cursor = q.cursor === undefined ? null : cursorOf(q.cursor);
  if (q.cursor !== undefined && cursor === null) return EMPTY_PAGE;
  const bound = cursor ?? { ts: target.ts, requestId };
  const rows = db.all<ContextRow>(
    "SELECT r.id, r.ts, c.input AS cin, c.output AS cout FROM requests r " +
      "LEFT JOIN content c ON c.request_id = r.id " +
      "WHERE r.node_id = ? AND (r.ts < ? OR (r.ts = ? AND r.id <= ?)) ORDER BY r.ts DESC, r.id DESC LIMIT ?",
    [target.node_id, bound.ts, bound.ts, bound.requestId, limit + 2],
  );
  // a cursor this node never named — one of another node's rows, say — answers the empty page
  const head = rows[0];
  if (cursor !== null && (head === undefined || head.id !== cursor.requestId || head.ts !== cursor.ts)) {
    return EMPTY_PAGE;
  }
  const turns = pageTurns(requestId, rows, cursor, limit);
  return turns === null ? EMPTY_PAGE : pageAnswer(turns, limit);
}

/** A cursor's parts, `ts:requestId:side`; the id itself may hold colons (route ids do). */
function cursorParts(cursor: string): { ts: number; requestId: string } | null {
  const first = cursor.indexOf(":");
  const last = cursor.lastIndexOf(":");
  if (first < 0 || last <= first) return null;
  const ts = Number(cursor.slice(0, first));
  return Number.isFinite(ts) ? { ts, requestId: cursor.slice(first + 1, last) } : null;
}

/** One page of the node's whole conversation, oldest first, each request's input and its answer — the
 *  agent's transcript, its newest answer included, where the context view stops at the input. Only the
 *  requests the page needs are read and unzipped, newest first from the cursor's request: a main agent can
 *  hold thousands, and a live transcript asks again on every request it makes. The window widens only
 *  when sides without content leave it short of a page. */
function transcriptPage(
  db: Db,
  nodeId: string,
  q: ContextQuery,
): { messages: ContextMessage[]; next: string | null } {
  const at = q.cursor === undefined ? null : cursorParts(q.cursor);
  if (q.cursor !== undefined && at === null) return { messages: [], next: null };
  for (let take = Math.max(1, q.limit) + 1; ; take *= 4) {
    const rows = newestRows(db, nodeId, at, take);
    const page = contextPage(turnsOfRows(rows.reverse()), q);
    // a page that starts at the window's first turn is the conversation's start only when the window ran
    // out of requests; otherwise older ones may hold turns, so look further back
    if (page.next !== null || rows.length < take) return page;
  }
}

/** The node's newest `take` requests with their stored sides, from the cursor's request back. */
function newestRows(
  db: Db,
  nodeId: string,
  at: { ts: number; requestId: string } | null,
  take: number,
): ContextRow[] {
  return db.all<ContextRow>(
    "SELECT r.id, r.ts, c.input AS cin, c.output AS cout FROM requests r " +
      "LEFT JOIN content c ON c.request_id = r.id WHERE r.node_id = ? " +
      (at === null ? "" : "AND (r.ts < ? OR (r.ts = ? AND r.id <= ?)) ") +
      "ORDER BY r.ts DESC, r.id DESC LIMIT ?",
    at === null ? [nodeId, take] : [nodeId, at.ts, at.ts, at.requestId, take],
  );
}

/** Each request's input and answer as turns, in the rows' order; empty sides leave no turn. */
function turnsOfRows(rows: ContextRow[]): ContextTurn[] {
  const turns: ContextTurn[] = [];
  for (const row of rows) {
    const user = turnOf("user", row, 0, ungzipOf(row.cin));
    if (user !== null) turns.push(user);
    const answer = turnOf("assistant", row, 1, ungzipOf(row.cout));
    if (answer !== null) turns.push(answer);
  }
  return turns;
}

/** The header numbers: how many turns, roughly how many tokens, what the request itself reported. The
 *  counts come from one aggregate over the stored side lengths — the whole conversation weighed, none
 *  of it decompressed; the target's own answer never counted, for the model never saw it. */
function contextTotals(
  target: {
    input: number | null;
    output: number | null;
    cache_read: number | null;
    cache_write: number | null;
  },
  turns: { messages: number; bytes: number },
): ContextAnswer["totals"] {
  const usageTotal =
    (target.input ?? 0) + (target.output ?? 0) + (target.cache_read ?? 0) + (target.cache_write ?? 0);
  const usage =
    usageTotal === 0
      ? null
      : {
          input: target.input ?? 0,
          output: target.output ?? 0,
          cacheRead: target.cache_read ?? 0,
          cacheWrite: target.cache_write ?? 0,
        };
  return {
    messages: turns.messages,
    approxTokens: Math.round(turns.bytes / 4),
    usage,
    cacheTokens: usage === null ? 0 : usage.cacheRead + usage.cacheWrite,
  };
}

/** The newest `limit` turns, or those before `cursor`; `next` names the page before it, null at the start. */
function contextPage(
  turns: ContextTurn[],
  q: ContextQuery,
): { messages: ContextMessage[]; next: string | null } {
  let end = turns.length;
  if (q.cursor !== undefined) {
    const at = turns.findIndex((turn) => messageKey(turn) === q.cursor);
    if (at < 0) return { messages: [], next: null };
    end = at;
  }
  const start = Math.max(0, end - Math.max(0, q.limit));
  const older = start > 0 ? turns[start] : undefined;
  return {
    messages: turns.slice(start, end).map(({ side, ...message }) => message),
    next: older === undefined ? null : messageKey(older),
  };
}

/**
 * Walk parent links up to the top of the tree. A chain ending at a parent that has no row yet leaves
 * the node its own root; inserting that parent re-roots the subtree.
 */
function rootOf(db: Db, id: string): string {
  let current = id;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const row = db.get<{ parent_id: string | null }>("SELECT parent_id FROM nodes WHERE id = ?", [current]);
    if (row === undefined || row.parent_id === null || row.parent_id === current) return current;
    const parent = row.parent_id;
    const parentRow = db.get<{ parent_id: string | null }>("SELECT parent_id FROM nodes WHERE id = ?", [
      parent,
    ]);
    if (parentRow === undefined) return current;
    current = parent;
  }
  return current;
}

/** Point the node and every descendant at the new root (a re-parent moves the whole subtree). */
function reRoot(db: Db, id: string, root: string): void {
  db.run(`${TREE_IDS} UPDATE nodes SET root_id = ? WHERE id IN (SELECT id FROM tree)`, [id, root]);
}

/** An absent or null field is stored as SQL NULL. */
function field<T>(v: T | null | undefined): T | null {
  return v ?? null;
}

/** The merge rule for one field: a non-null incoming value wins, null or absent keeps the stored one. */
function pick<T>(incoming: T | null | undefined, stored: T | null): T | null {
  return incoming ?? stored;
}

function nodeFromUpsert(n: NodeUpsert): NodeRow {
  return {
    id: n.id,
    kind: n.kind,
    parent_id: field(n.parentId),
    root_id: n.parentId ?? n.id,
    session_id: n.sessionId,
    agent_id: n.agentId,
    label: field(n.label),
    agent_type: field(n.agentType),
    description: field(n.description),
    project: field(n.project),
    cwd: field(n.cwd),
    model: field(n.model),
    provider: field(n.provider),
    tool_use_id: field(n.toolUseId),
    spawn_depth: field(n.spawnDepth),
    job_state: field(n.jobState),
    repo: field(n.repo),
    branch: field(n.branch),
    name: field(n.name),
    parent_session_id: field(n.parentSessionId),
    started_at: field(n.startedAt),
    last_at: field(n.lastAt),
    ended_at: field(n.endedAt),
  };
}

/** A non-null incoming field overwrites; started_at keeps the minimum and last_at the maximum. */
function mergeNode(s: NodeRow, n: NodeUpsert): NodeRow {
  const lastAt = maxOf(s.last_at, n.lastAt);
  // a write after the end means the node came back; an explicit null ends the same, a stamp sets it
  let endedAt = s.ended_at !== null && lastAt !== null && lastAt > s.ended_at ? null : s.ended_at;
  if (n.endedAt === null) endedAt = null;
  else if (n.endedAt !== undefined) endedAt = maxOf(endedAt, n.endedAt);
  return {
    id: s.id,
    kind: n.kind,
    parent_id: pick(n.parentId, s.parent_id),
    root_id: s.root_id,
    session_id: n.sessionId,
    agent_id: n.agentId,
    label: pick(n.label, s.label),
    agent_type: pick(n.agentType, s.agent_type),
    description: pick(n.description, s.description),
    project: pick(n.project, s.project),
    cwd: pick(n.cwd, s.cwd),
    model: pick(n.model, s.model),
    provider: pick(n.provider, s.provider),
    tool_use_id: pick(n.toolUseId, s.tool_use_id),
    spawn_depth: pick(n.spawnDepth, s.spawn_depth),
    job_state: pick(n.jobState, s.job_state),
    repo: pick(n.repo, s.repo),
    branch: pick(n.branch, s.branch),
    name: pick(n.name, s.name),
    parent_session_id: pick(n.parentSessionId, s.parent_session_id),
    started_at: minOf(s.started_at, n.startedAt),
    last_at: lastAt,
    ended_at: endedAt,
  };
}

function nodeValues(row: NodeRow): SqlValue[] {
  return [
    row.kind,
    row.parent_id,
    row.root_id,
    row.session_id,
    row.agent_id,
    row.label,
    row.agent_type,
    row.description,
    row.project,
    row.cwd,
    row.model,
    row.provider,
    row.tool_use_id,
    row.spawn_depth,
    row.job_state,
    row.repo,
    row.branch,
    row.name,
    row.parent_session_id,
    row.started_at,
    row.last_at,
    row.ended_at,
  ];
}

function writeNode(db: Db, row: NodeRow, isNew: boolean): void {
  if (isNew) db.run(INSERT_NODE, [row.id, ...nodeValues(row)]);
  else db.run(UPDATE_NODE, [...nodeValues(row), row.id]);
}

/** A stored name that reads as an absolute path is the old repo fallback: the card is named by the
 *  repo's own name ("app"), never by a path — the full cwd stays on the node for the tooltip. */
function servedName(name: string | null): string | null {
  if (name === null || !name.startsWith("/")) return name;
  return repoName(name);
}

function nodeFields(row: NodeRow): NodeFields {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    parentId: row.parent_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    label: row.label,
    agentType: row.agent_type,
    description: row.description,
    project: row.project,
    cwd: row.cwd,
    model: row.model,
    provider: row.provider,
    toolUseId: row.tool_use_id,
    spawnDepth: row.spawn_depth,
    jobState: row.job_state,
    repo: row.repo,
    branch: row.branch,
    name: servedName(row.name),
    parentSessionId: row.parent_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastAt: row.last_at ?? 0,
  };
}

/** One root's roll-ups over its whole tree: what a per-root read assembled, now grouped per page. */
type RootRollup = {
  lastAt: number;
  requests: number;
  tokens: Tokens;
  nodes: number;
  liveNodes: number;
  activity: Activity;
};

/** One tree's activity window: a live one counts its requests in `liveMs` buckets ending now; an ended
 *  one stretches its whole span from start to last activity (a span nobody recorded falls back to the
 *  live window). SQLite's integer division puts each request in its bucket. */
function activityWindowOf(
  row: { started_at: number | null; last_at: number | null },
  scope: "live" | "history",
  now: number,
  liveMs: number,
): { start: number; bucketMs: number } {
  const live = scope === "live";
  const lastAt = row.last_at ?? 0;
  const start = live ? now - liveMs : (row.started_at ?? Math.max(0, lastAt - liveMs));
  const bucketMs = Math.max(1, Math.ceil((live ? liveMs : lastAt - start) / ACTIVITY_BUCKETS));
  return { start, bucketMs };
}

/** Roots rolled up per chunk of rows, never one root at a time: the three shapes a per-root read ran —
 *  the tree's nodes, its requests, its activity — each grouped over an IN list, so a page costs three
 *  queries per 400 roots. Each root's activity window rides in a VALUES table its requests join. */
const ROLLUP_CHUNK = 400;

function rollupRoots(
  db: Db,
  rows: NodeRow[],
  scope: "live" | "history",
  now: number,
  liveMs: number,
): Map<string, RootRollup> {
  const rollups = new Map<string, RootRollup>();
  for (let at = 0; at < rows.length; at += ROLLUP_CHUNK) {
    const chunk = rows.slice(at, at + ROLLUP_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    const ids = chunk.map((row) => row.id);
    const nodes = new Map(
      db
        .all<{ rootId: string; nodes: number; liveNodes: number | null; lastAt: number | null }>(
          `SELECT root_id AS rootId, COUNT(*) AS nodes, SUM(CASE WHEN ${LIVE_SQL} THEN 1 ELSE 0 END) AS liveNodes, ` +
            "MAX(last_at) AS lastAt FROM nodes WHERE root_id IN (" +
            marks +
            ") GROUP BY root_id",
          // the CASE's ? sits in the SELECT, ahead of the IN list's in the SQL text
          [now - liveMs, ...ids],
        )
        .map((row) => [row.rootId, row]),
    );
    const requests = new Map(
      db
        .all<RequestTotals & { rootId: string }>(
          "SELECT n.root_id AS rootId, COUNT(*) AS requestCount, SUM(r.input) AS inputTokens, " +
            "SUM(r.output) AS outputTokens, SUM(r.cache_read) AS cacheReadTokens, " +
            "SUM(r.cache_write) AS cacheWriteTokens FROM requests r JOIN nodes n ON n.id = r.node_id " +
            "WHERE n.root_id IN (" +
            marks +
            ") GROUP BY n.root_id",
          ids,
        )
        .map((row) => [row.rootId, row]),
    );
    const windows = chunk.map((row) => activityWindowOf(row, scope, now, liveMs));
    const buckets = db.all<{ rootId: string; bucket: number; model: string | null; c: number }>(
      `WITH w(root, start, bucket) AS (VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}) ` +
        "SELECT w.root AS rootId, (r.ts - w.start) / w.bucket AS bucket, r.model, COUNT(*) AS c " +
        "FROM requests r JOIN nodes n ON n.id = r.node_id JOIN w ON n.root_id = w.root " +
        "WHERE r.ts >= w.start GROUP BY w.root, bucket, r.model",
      chunk.flatMap((row, index) => {
        const window = windows[index];
        return [row.id, window?.start ?? 0, window?.bucketMs ?? 1];
      }),
    );
    for (const [index, row] of chunk.entries()) {
      const nodesRow = nodes.get(row.id);
      const requestsRow = requests.get(row.id);
      rollups.set(row.id, {
        lastAt: nodesRow?.lastAt ?? 0,
        requests: requestsRow?.requestCount ?? 0,
        tokens: tokensOf(requestsRow),
        nodes: nodesRow?.nodes ?? 0,
        liveNodes: nodesRow?.liveNodes ?? 0,
        activity: activityFromRows(
          buckets.filter((bucket) => bucket.rootId === row.id),
          windows[index]?.bucketMs ?? 1,
        ),
      });
    }
  }
  return rollups;
}

/** WHERE clauses and params for roots(): top-level main sessions only — live ones with a live node, in
 *  history the ended ones. Jobs are never roots: they read through their session's tree, and the ones
 *  no session claims come back as the one Unattached group from unattached(). */
function rootsWhere(q: RootsQuery): { where: string; params: SqlValue[] } {
  const clauses: string[] = ["n.parent_id IS NULL", "n.kind = 'main'"];
  const params: SqlValue[] = [];
  const at = `(SELECT 1 FROM nodes c WHERE c.root_id = n.id AND ${LIVE_SQL})`;
  clauses.push(q.scope === "live" ? `EXISTS ${at}` : `NOT EXISTS ${at}`);
  params.push(q.now - q.liveMs);
  if (q.scope === "history" && q.excludeSessions !== undefined && q.excludeSessions.length > 0) {
    clauses.push(`n.session_id NOT IN (${q.excludeSessions.map(() => "?").join(",")})`);
    params.push(...q.excludeSessions);
  }
  if (q.before !== undefined) {
    clauses.push("n.last_at < ?");
    params.push(q.before);
  }
  if (q.repo !== undefined) {
    clauses.push("n.repo = ?");
    params.push(q.repo);
  }
  if (q.search !== undefined) {
    clauses.push(
      "(n.project LIKE ? ESCAPE '\\' OR n.label LIKE ? ESCAPE '\\' OR n.model LIKE ? ESCAPE '\\' " +
        "OR n.cwd LIKE ? ESCAPE '\\' OR n.name LIKE ? ESCAPE '\\')",
    );
    const pattern = likeOf(q.search);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  return { where: clauses.join(" AND "), params };
}

/** The row's token counts; thinking only when the provider reported it. */
function rowTokens(row: RequestRow): RequestRecord["tokens"] {
  const tokens: RequestRecord["tokens"] = {
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheRead: row.cache_read ?? 0,
    cacheWrite: row.cache_write ?? 0,
  };
  if (row.thinking !== null) tokens.thinking = row.thinking;
  return tokens;
}

/** The two columns a request's capture link is stored in: its hash, and its headers as the JSON the row
 *  keeps (null when the route line recorded neither). */
function captureColumns(r: RequestRecord): [string | null, string | null] {
  return [r.promptHash ?? null, r.headers === undefined ? null : JSON.stringify(r.headers)];
}

/** The headers a request row's JSON says, or null when it says nothing readable. */
function headersOf(text: string | null): Record<string, string> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[name] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/** The columns the row may not have stored; present only when not null. */
function optionalsOf(row: RequestRow): Partial<RequestRecord> {
  const optional: Partial<RequestRecord> = {};
  if (row.route !== null) optional.route = row.route;
  if (row.via !== null) optional.via = row.via;
  if (row.what !== null) optional.what = row.what;
  if (row.error !== null) optional.error = row.error;
  if (row.parent_agent_id !== null) optional.parentAgentId = row.parent_agent_id;
  if (row.prompt_hash !== null) optional.promptHash = row.prompt_hash;
  const headers = headersOf(row.headers);
  if (headers !== null) optional.headers = headers;
  if (row.totals === 1) optional.totals = true;
  return optional;
}

/** How the request billed beyond its token counts; absent when the column is null. */
function billingOf(row: RequestRow): Partial<RequestRecord> {
  const billing: Partial<RequestRecord> = {};
  if (row.cache_write_1h !== null) billing.cacheWrite1h = row.cache_write_1h;
  if (row.speed !== null) billing.speed = row.speed;
  if (row.geo !== null) billing.geo = row.geo;
  if (row.service_tier !== null) billing.serviceTier = row.service_tier;
  return billing;
}

function toRequest(row: RequestRow): RequestRecord {
  const r: RequestRecord = {
    id: row.id,
    sessionId: row.session_id ?? "",
    agentId: row.agent_id ?? "",
    model: row.model ?? "",
    upstream: row.upstream ?? "",
    ts: row.ts,
    latencyMs: row.latency_ms,
    tokens: rowTokens(row),
    stopReason: row.stop_reason,
    provider: row.provider ?? "",
  };
  Object.assign(r, optionalsOf(row), billingOf(row));
  return r;
}

/**
 * Open the history file (creating its 0700 directory first, the file chmodded 0600), migrate it, and
 * return the repository. The history writer (writer.ts) feeds it from the store's updates. Tests hand
 * an already-opened `underlying` Db in, so a wrapper can count what a read costs.
 */
export async function openHistory(file: string, underlying?: Db): Promise<History> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = underlying ?? (await openDb(file));
  migrate(db);
  chmodSync(file, 0o600);

  /** Insert or merge, then re-point the subtree when the parent moved or the node was adopted. */
  function upsertNode(n: NodeUpsert): void {
    const stored = db.get<NodeRow>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`, [n.id]);
    const isNew = stored === undefined;
    const next = isNew ? nodeFromUpsert(n) : mergeNode(stored, n);
    const parentChanged = !isNew && stored.parent_id !== next.parent_id;
    writeNode(db, next, isNew);
    const root = rootOf(db, next.id);
    // a fresh node may be adopted by children that named it as parent before it existed
    if (isNew || parentChanged || root !== next.root_id) reRoot(db, next.id, root);
  }

  let depth = 0;
  const history: History = {
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth += 1;
      db.run("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.run("COMMIT");
        return out;
      } catch (e) {
        try {
          db.run("ROLLBACK");
        } catch {
          // the statement that failed had already rolled the transaction back
        }
        throw e;
      } finally {
        depth -= 1;
      }
    },

    upsertNode,

    endNode(id: string, at: number): void {
      db.run(
        "UPDATE nodes SET ended_at = CASE WHEN ended_at IS NULL OR ended_at < ? THEN ? ELSE ended_at END " +
          "WHERE id = ?",
        [at, at, id],
      );
    },

    putRequest(nodeId: string, r: RequestRecord): void {
      db.run(UPSERT_REQUEST, [
        r.id,
        nodeId,
        r.sessionId,
        r.agentId,
        r.model,
        r.upstream,
        r.ts,
        r.latencyMs,
        r.tokens.input,
        r.tokens.output,
        r.tokens.cacheRead,
        r.tokens.cacheWrite,
        r.cacheWrite1h ?? null,
        r.speed ?? null,
        r.geo ?? null,
        r.serviceTier ?? null,
        r.stopReason,
        r.error ?? null,
        r.parentAgentId ?? null,
        r.provider,
        r.route ?? null,
        r.via ?? null,
        r.what ?? null,
        r.tokens.thinking ?? null,
        ...captureColumns(r),
        r.totals === true ? 1 : 0,
      ]);
      // a request after the node's end is a session that came back: move last_at, clear the end
      db.run(
        "UPDATE nodes SET last_at = CASE WHEN last_at IS NULL OR last_at < ? THEN ? ELSE last_at END, " +
          "ended_at = CASE WHEN ended_at IS NOT NULL AND ended_at < ? THEN NULL ELSE ended_at END WHERE id = ?",
        [r.ts, r.ts, r.ts, nodeId],
      );
    },

    /** Each side merges on its own through sideOfNext: the stored lengths decide before anything is
     *  decompressed, a kept side's blob goes back as it stands, and only the side that grew is gzipped. */
    putContent(requestId: string, c: { input: string | null; output: string | null }): void {
      const stored = db.get<{
        input: Uint8Array | null;
        output: Uint8Array | null;
        in_len: number | null;
        out_len: number | null;
      }>("SELECT input, output, in_len, out_len FROM content WHERE request_id = ?", [requestId]);
      const fresh = (text: string | null): StoredSide =>
        text === null ? { blob: null, len: null } : { blob: gzipOf(text), len: Buffer.byteLength(text) };
      const input =
        stored === undefined
          ? fresh(c.input)
          : sideOfNext({ blob: stored.input, len: stored.in_len }, c.input);
      const output =
        stored === undefined
          ? fresh(c.output)
          : sideOfNext({ blob: stored.output, len: stored.out_len }, c.output);
      db.run(
        "INSERT OR REPLACE INTO content (request_id, input, output, bytes, in_len, out_len) VALUES (?, ?, ?, ?, ?, ?)",
        [requestId, input.blob, output.blob, (input.len ?? 0) + (output.len ?? 0), input.len, output.len],
      );
    },

    content(requestId: string) {
      const row = db.get<{ input: Uint8Array | null; output: Uint8Array | null; bytes: number }>(
        "SELECT input, output, bytes FROM content WHERE request_id = ?",
        [requestId],
      );
      if (row === undefined) return null;
      return { input: ungzipOf(row.input), output: ungzipOf(row.output), bytes: row.bytes };
    },

    putCapture(c: { hash: string; gz: string; firstTs: number }): void {
      // The bytes go down as they came; the plain size is read off the gzip trailer, so nothing expands.
      const blob = Buffer.from(c.gz, "base64");
      db.run("INSERT OR IGNORE INTO captures (hash, gz, bytes, first_ts) VALUES (?, ?, ?, ?)", [
        c.hash,
        blob,
        isizeOf(blob),
        c.firstTs,
      ]);
    },

    capture(requestId: string): CaptureAnswer | null {
      const row = db.get<{ prompt_hash: string | null; headers: string | null }>(
        "SELECT prompt_hash, headers FROM requests WHERE id = ?",
        [requestId],
      );
      if (row === undefined || row.prompt_hash === null) return null;
      const stored = db.get<{ gz: Uint8Array; bytes: number }>(
        "SELECT gz, bytes FROM captures WHERE hash = ?",
        [row.prompt_hash],
      );
      if (stored === undefined) return null;
      const payload = capturePayloadOf(stored.gz);
      if (payload === null) return null;
      return {
        hash: row.prompt_hash,
        system: payload.system ?? null,
        tools: payload.tools ?? null,
        bytes: stored.bytes,
        headers: headersOf(row.headers),
      };
    },

    putTool(nodeId: string, t: ToolCallRecord): void {
      db.run(
        "INSERT OR REPLACE INTO tools (id, node_id, session_id, agent_id, name, started_at, duration_ms, ok, " +
          "input_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          t.id,
          nodeId,
          t.sessionId,
          t.agentId,
          t.name,
          t.startedAt,
          t.durationMs,
          t.ok ? 1 : 0,
          t.inputKey ?? null,
        ],
      );
    },

    addEvent(nodeId: string | null, e: EventRecord): void {
      db.run(
        "INSERT OR IGNORE INTO events (seq, ts, kind, session_id, agent_id, label, payload, node_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [e.seq, e.ts, e.kind, e.sessionId, e.agentId, e.label, JSON.stringify(e.payload ?? null), nodeId],
      );
    },

    offset(file: string) {
      return (
        db.get<{ offset: number; size: number; mtime: number }>(
          "SELECT offset, size, mtime FROM offsets WHERE file = ?",
          [file],
        ) ?? null
      );
    },

    setOffset(file: string, o: { offset: number; size: number; mtime: number }): void {
      db.run("INSERT OR REPLACE INTO offsets (file, offset, size, mtime) VALUES (?, ?, ?, ?)", [
        file,
        o.offset,
        o.size,
        o.mtime,
      ]);
    },

    roots(q: RootsQuery): RootSummary[] {
      const { where, params } = rootsWhere(q);
      const rows = db.all<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM nodes n WHERE ${where} ORDER BY last_at DESC LIMIT ?`,
        [...params, q.limit],
      );
      const rollups = rollupRoots(db, rows, q.scope, q.now, q.liveMs);
      return rows.map((row) => {
        const rollup = rollups.get(row.id);
        return {
          ...nodeFields(row),
          lastAt: rollup?.lastAt ?? 0,
          requests: rollup?.requests ?? 0,
          tokens: rollup?.tokens ?? tokensOf(undefined),
          nodes: rollup?.nodes ?? 0,
          liveNodes: rollup?.liveNodes ?? 0,
          activity:
            rollup?.activity ??
            activityFromRows([], activityWindowOf(row, q.scope, q.now, q.liveMs).bucketMs),
        };
      });
    },

    unattached(q: UnattachedQuery): RootSummary | null {
      const trees = db.all<{ id: string; started_at: number | null }>(
        `SELECT id, started_at FROM nodes j WHERE j.kind = 'job' ` +
          "AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.id = j.parent_id)",
      );
      if (trees.length === 0) return null;
      const ids = trees.map((tree) => tree.id);
      const marks = ids.map(() => "?").join(",");
      const at = q.now - q.liveMs;
      const nodes = db.get<{
        nodes: number;
        liveNodes: number | null;
        lastAt: number | null;
        startedAt: number | null;
        endedAt: number | null;
      }>(
        `SELECT COUNT(*) AS nodes, SUM(CASE WHEN ${LIVE_SQL} THEN 1 ELSE 0 END) AS liveNodes, ` +
          "MAX(last_at) AS lastAt, MIN(started_at) AS startedAt, MAX(ended_at) AS endedAt " +
          `FROM nodes WHERE root_id IN (${marks})`,
        [at, ...ids],
      );
      const requests = db.get<RequestTotals>(
        `SELECT COUNT(*) AS requestCount, SUM(input) AS inputTokens, SUM(output) AS outputTokens, ` +
          "SUM(cache_read) AS cacheReadTokens, SUM(cache_write) AS cacheWriteTokens FROM requests " +
          `WHERE node_id IN (SELECT id FROM nodes WHERE root_id IN (${marks}))`,
        ids,
      );
      // the group's span stretches from its earliest start to its last activity, as an ended root's does
      const startedAt = nodes?.startedAt ?? null;
      const lastAt = nodes?.lastAt ?? 0;
      const start = startedAt ?? Math.max(0, lastAt - q.liveMs);
      const bucketMs = Math.max(1, Math.ceil((lastAt - start) / ACTIVITY_BUCKETS));
      const buckets = db.all<{ bucket: number; model: string | null; c: number }>(
        "SELECT (r.ts - ?) / ? AS bucket, r.model, COUNT(*) AS c FROM requests r " +
          `WHERE r.node_id IN (SELECT id FROM nodes WHERE root_id IN (${marks})) AND r.ts >= ? ` +
          "GROUP BY bucket, r.model",
        [start, bucketMs, ...ids, start],
      );
      return {
        id: OUTSIDE_SESSION,
        kind: "job",
        parentId: null,
        sessionId: OUTSIDE_SESSION,
        agentId: "",
        label: null,
        agentType: null,
        description: null,
        project: null,
        cwd: null,
        model: null,
        provider: null,
        toolUseId: null,
        spawnDepth: null,
        jobState: null,
        repo: null,
        branch: null,
        name: UNATTACHED_NAME,
        parentSessionId: null,
        startedAt,
        endedAt: nodes?.endedAt ?? null,
        lastAt,
        requests: requests?.requestCount ?? 0,
        tokens: tokensOf(requests),
        nodes: nodes?.nodes ?? 0,
        liveNodes: nodes?.liveNodes ?? 0,
        activity: activityFromRows(buckets, bucketMs),
      };
    },

    tree(rootId: string, q?: { now?: number; liveMs?: number }): TreeNodeRow[] {
      const now = q?.now ?? Date.now();
      const liveMs = q?.liveMs ?? DEFAULT_LIVE_MS;
      // the Unattached group's tree is the union of the job trees no session claims
      const unattached = rootId === OUTSIDE_SESSION ? ` OR root_id IN ${UNATTACHED_TREES}` : "";
      const rows = db.all<NodeRow & { live: number }>(
        `SELECT ${NODE_COLUMNS}, CASE WHEN ${LIVE_SQL} THEN 1 ELSE 0 END AS live FROM nodes ` +
          `WHERE (root_id = ?${unattached}) ` +
          "ORDER BY (id = ?) DESC, live DESC, last_at DESC, id DESC",
        [now - liveMs, rootId, rootId],
      );
      const totals = new Map(
        db
          .all<RequestTotals>(
            "SELECT node_id, COUNT(*) AS requestCount, SUM(input) AS inputTokens, SUM(output) AS outputTokens, " +
              "SUM(cache_read) AS cacheReadTokens, SUM(cache_write) AS cacheWriteTokens FROM requests " +
              `WHERE node_id IN (SELECT id FROM nodes WHERE root_id = ?${unattached}) GROUP BY node_id`,
            [rootId],
          )
          .map((t) => [t.node_id, t]),
      );
      return rows.map((row) => {
        const t = totals.get(row.id);
        return {
          ...nodeFields(row),
          live: row.live === 1,
          requests: t?.requestCount ?? 0,
          tokens: tokensOf(t),
        };
      });
    },

    requestsOf(q: RequestsQuery): RequestRecord[] {
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      if (q.nodeId !== undefined) {
        clauses.push("node_id = ?");
        params.push(q.nodeId);
      } else if (q.rootId !== undefined) {
        // the Unattached group's requests are the ones its job trees hold
        const unattached = q.rootId === OUTSIDE_SESSION ? ` OR root_id IN ${UNATTACHED_TREES}` : "";
        clauses.push(`node_id IN (SELECT id FROM nodes WHERE root_id = ?${unattached})`);
        params.push(q.rootId);
      }
      if (q.before !== undefined) {
        clauses.push("(ts < ? OR (ts = ? AND id < ?))");
        params.push(q.before.ts, q.before.ts, q.before.id);
      }
      params.push(q.limit);
      const filter = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")} ` : "";
      return db
        .all<RequestRow>(
          `SELECT ${REQUEST_COLUMNS} FROM requests ${filter}ORDER BY ts DESC, id DESC LIMIT ?`,
          params,
        )
        .map(toRequest);
    },

    context(requestId: string, q: ContextQuery): ContextAnswer | null {
      const target = db.get<{
        node_id: string;
        ts: number;
        model: string | null;
        input: number | null;
        output: number | null;
        cache_read: number | null;
        cache_write: number | null;
      }>("SELECT node_id, ts, model, input, output, cache_read, cache_write FROM requests WHERE id = ?", [
        requestId,
      ]);
      if (target === undefined) return null;
      const counted = db.get<{ messages: number | null; bytes: number | null }>(
        "SELECT COALESCE(SUM(CASE WHEN c.input IS NOT NULL THEN 1 ELSE 0 END + " +
          "CASE WHEN c.output IS NOT NULL AND r.id != ? THEN 1 ELSE 0 END), 0) AS messages, " +
          "COALESCE(SUM(CASE WHEN r.id = ? THEN COALESCE(c.in_len, 0) " +
          "ELSE COALESCE(c.in_len, 0) + COALESCE(c.out_len, 0) END), 0) AS bytes " +
          "FROM requests r LEFT JOIN content c ON c.request_id = r.id " +
          "WHERE r.node_id = ? AND (r.ts < ? OR (r.ts = ? AND r.id <= ?))",
        [requestId, requestId, target.node_id, target.ts, target.ts, requestId],
      );
      const page = contextPageOf(db, requestId, target, q);
      return {
        requestId,
        nodeId: target.node_id,
        model: target.model ?? "",
        totals: contextTotals(target, { messages: counted?.messages ?? 0, bytes: counted?.bytes ?? 0 }),
        messages: page.messages,
        next: page.next,
      };
    },

    agentTranscript(nodeId: string, q: ContextQuery): ContextAnswer | null {
      const node = db.get<{ model: string | null }>("SELECT model FROM nodes WHERE id = ?", [nodeId]);
      if (node === undefined) return null;
      const target = db.get<{
        id: string;
        ts: number;
        model: string | null;
        input: number | null;
        output: number | null;
        cache_read: number | null;
        cache_write: number | null;
      }>(
        "SELECT id, ts, model, input, output, cache_read, cache_write FROM requests " +
          "WHERE node_id = ? ORDER BY ts DESC, id DESC LIMIT 1",
        [nodeId],
      );
      if (target === undefined) {
        // the node exists but nothing was stored under it: an empty conversation, not an unknown agent
        return {
          requestId: "",
          nodeId,
          model: node.model ?? "",
          totals: { messages: 0, approxTokens: 0, usage: null, cacheTokens: 0 },
          messages: [],
          next: null,
        };
      }
      const page = transcriptPage(db, nodeId, q);
      // the totals count every stored side in SQL, never by unzipping the whole conversation
      const sides = db.get<{ messages: number; bytes: number }>(
        "SELECT COUNT(c.input) + COUNT(c.output) AS messages, COALESCE(SUM(c.bytes), 0) AS bytes " +
          "FROM requests r JOIN content c ON c.request_id = r.id WHERE r.node_id = ?",
        [nodeId],
      ) ?? { messages: 0, bytes: 0 };
      return {
        requestId: target.id,
        nodeId,
        model: target.model ?? node.model ?? "",
        totals: contextTotals(target, sides),
        messages: page.messages,
        next: page.next,
      };
    },

    /** One query per 400 trees, never one per row: the page's cost roll-up reads every request it names
     *  once, joined with the node and tree each landed on, and the route sums prices in memory. A request
     *  of an unattached job answers to the Unattached group's id, not to its job's own. */
    costRows(rootIds: string[]): CostRow[] {
      const rows: CostRow[] = [];
      for (let at = 0; at < rootIds.length; at += 400) {
        const chunk = rootIds.slice(at, at + 400);
        const marks = chunk.map(() => "?").join(",");
        const group = chunk.includes(OUTSIDE_SESSION) ? ` OR n.root_id IN ${UNATTACHED_TREES}` : "";
        rows.push(
          ...db.all<CostRow>(
            `SELECT n.id AS nodeId, CASE WHEN n.root_id IN ${UNATTACHED_TREES} THEN ? ELSE n.root_id END AS rootId, ` +
              "r.model, r.upstream, r.ts, r.input, r.output, " +
              "r.cache_read AS cacheRead, r.cache_write AS cacheWrite, r.cache_write_1h AS cacheWrite1h, " +
              "r.speed, r.geo, r.service_tier " +
              `FROM requests r JOIN nodes n ON n.id = r.node_id WHERE n.root_id IN (${marks})${group}`,
            [OUTSIDE_SESSION, ...chunk],
          ),
        );
      }
      return rows;
    },

    /** One GROUP BY over the requests table. The bucket is the truncating division of the offset by the bar
     *  width — spelled CAST(… AS INTEGER) because node:sqlite binds JS numbers as REAL — and the scalar MIN
     *  clamps the right edge (and a capped bucket count) into the last bar, so nothing is lost. */
    flow(q: FlowQuery): FlowSeries {
      const requests = new Array<number>(q.buckets).fill(0);
      const kinds = {
        input: new Array<number>(q.buckets).fill(0),
        output: new Array<number>(q.buckets).fill(0),
        cacheRead: new Array<number>(q.buckets).fill(0),
        cacheWrite: new Array<number>(q.buckets).fill(0),
      };
      const rows = db.all<{
        bucket: number;
        requests: number;
        input: number | null;
        output: number | null;
        cacheRead: number | null;
        cacheWrite: number | null;
      }>(
        "SELECT MIN(CAST((ts - ?) / ? AS INTEGER), ?) AS bucket, COUNT(*) AS requests, SUM(input) AS input, " +
          "SUM(output) AS output, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite " +
          "FROM requests WHERE ts >= ? AND ts <= ? GROUP BY bucket",
        [q.from, q.bucketMs, q.buckets - 1, q.from, q.to],
      );
      for (const row of rows) {
        requests[row.bucket] = row.requests;
        kinds.input[row.bucket] = row.input ?? 0;
        kinds.output[row.bucket] = row.output ?? 0;
        kinds.cacheRead[row.bucket] = row.cacheRead ?? 0;
        kinds.cacheWrite[row.bucket] = row.cacheWrite ?? 0;
      }
      return { from: q.from, to: q.to, bucketMs: q.bucketMs, requests, kinds };
    },

    repos() {
      // the picker names roots: main sessions only, exactly what roots() can list
      return db.all<{ repo: string; roots: number }>(
        "SELECT repo, COUNT(*) AS roots FROM nodes WHERE parent_id IS NULL AND kind = 'main' AND repo IS NOT NULL " +
          "GROUP BY repo ORDER BY roots DESC, repo ASC",
      );
    },

    stats(q) {
      const pages = db.get<{ page_count: number | bigint }>("PRAGMA page_count");
      const size = db.get<{ page_size: number | bigint }>("PRAGMA page_size");
      const nodes = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM nodes");
      const requests = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM requests");
      // the same predicate roots() pages by, as one COUNT: the badge's number is the list's, not an
      // approximation that drifts the moment a live session is kept out
      const { where, params } = rootsWhere({
        scope: "history",
        now: q.now,
        liveMs: q.liveMs,
        limit: 0,
        ...(q.excludeSessions === undefined ? {} : { excludeSessions: q.excludeSessions }),
      });
      const roots = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM nodes n WHERE ${where}`, params);
      return {
        bytes: Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0),
        nodes: nodes?.c ?? 0,
        requests: requests?.c ?? 0,
        roots: roots?.c ?? 0,
      };
    },

    /** Remove whole trees nothing in has touched since cutoff; a tree with one recent node survives. */
    prune(cutoff: number): number {
      const stale = db.all<{ id: string }>(
        "SELECT id FROM nodes r WHERE r.parent_id IS NULL AND r.last_at IS NOT NULL AND r.last_at < ? " +
          "AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.root_id = r.id AND (c.last_at IS NULL OR c.last_at >= ?))",
        [cutoff, cutoff],
      );
      for (const root of stale) {
        db.run("DELETE FROM events WHERE node_id IN (SELECT id FROM nodes WHERE root_id = ?)", [root.id]);
        db.run("DELETE FROM tools WHERE node_id IN (SELECT id FROM nodes WHERE root_id = ?)", [root.id]);
        // content goes with its request row, through ON DELETE CASCADE
        db.run("DELETE FROM requests WHERE node_id IN (SELECT id FROM nodes WHERE root_id = ?)", [root.id]);
        db.run("DELETE FROM nodes WHERE root_id = ?", [root.id]);
      }
      return stale.length;
    },

    clear(): void {
      for (const table of ["content", "requests", "tools", "events", "offsets", "nodes", "captures"])
        db.run(`DELETE FROM ${table}`);
    },

    close(): void {
      db.close();
    },
  };
  return history;
}
