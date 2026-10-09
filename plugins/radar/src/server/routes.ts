/**
 * API routing as a pure function: parse a pathname + query, return status/body. No sockets here, so tests
 * cover every route without an HTTP server. Query values are strings (or repeated); limits are clamped.
 * The /api/history routes read the same shapes out of the SQLite history; they 503 when it failed to open.
 */
import {
  ATTRIBUTION_BY,
  ATTRIBUTION_RANGES,
  type AttributionBy,
  type AttributionRange,
} from "../cost/attribution.ts";
import { addCost, PRICES_RETRIEVED, type PricedRequest, requestCost } from "../cost/prices.ts";
import type { CostRow, History } from "../history/history.ts";
import { bucketPlan } from "../shared/time-range.ts";
import { type Store, sessionTree } from "../store/store.ts";
import type { Insights } from "./insights.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

export type ApiRequest = { path: string; query: URLSearchParams };
export type ApiResponse = { status: number; body: unknown };

export type AppInfo = { version: string; startedAt: number; port: number };

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

/** A tree any node of which moved within this window is live; older ones read as history. */
export const HISTORY_LIVE_MS = 15 * 60_000;

function clampLimit(raw: string | null): number {
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function numParam(query: URLSearchParams, key: string): number | null {
  const raw = query.get(key);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A query string that means something only when present and non-empty. */
function strParam(query: URLSearchParams, key: string): string | undefined {
  const raw = query.get(key);
  return raw === null || raw === "" ? undefined : raw;
}

/** A path id, decoded; a malformed escape is the caller's typo, not a crash. */
function decodeOf(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** `{key: value}` when present, `{}` when not — keeps exactOptionalPropertyTypes honest. */
function maybe<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V };
}

function json(status: number, body: unknown): ApiResponse {
  return { status, body };
}

/** The paged record lists: requests, events and tool calls, newest first. */
function listRoute(store: Store, path: string, query: URLSearchParams): ApiResponse | null {
  if (path === "/api/requests") {
    return json(200, {
      requests: store.requests({
        ...maybe("session", query.get("session")),
        ...maybe("agent", query.get("agent")),
        ...maybe("model", query.get("model")),
        ...maybe("since", numParam(query, "since")),
        limit: clampLimit(query.get("limit")),
      }),
    });
  }
  if (path === "/api/events") {
    return json(200, {
      events: store.events({
        ...maybe("session", query.get("session")),
        ...maybe("since", numParam(query, "since")),
        limit: clampLimit(query.get("limit")),
      }),
    });
  }
  if (path === "/api/tools") {
    return json(200, {
      tools: store.tools({
        ...maybe("session", query.get("session")),
        ...(query.get("failed") === "1" ? { failed: true } : {}),
        limit: clampLimit(query.get("limit")),
      }),
    });
  }
  return null;
}

/** The models tab's tables: without a scope the whole store's cached answer, the one the snapshot
 *  pushes; a window and/or the picked sessions (comma-joined, as the hash carries them) aggregate
 *  those requests instead. */
function modelsRoute(store: Store, query: URLSearchParams): ApiResponse {
  const from = numParam(query, "from");
  const to = numParam(query, "to");
  const sessions = query
    .getAll("session")
    .flatMap((raw) => raw.split(","))
    .filter((id) => id !== "");
  return json(
    200,
    store.models({
      ...(from === null ? {} : { from }),
      ...(to === null ? {} : { to }),
      ...(sessions.length === 0 ? {} : { sessions }),
    }),
  );
}

function oneOf<T extends string>(allowed: readonly T[], raw: string | null, fallback: T): T | null {
  if (raw === null || raw === "") return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** The derived views: costs, budgets, alerts, settings, router health, the model advisor. */
function insightRoute(insights: Insights, path: string, query: URLSearchParams): ApiResponse | null {
  switch (path) {
    case "/api/alerts":
      return json(200, { alerts: insights.alerts() });
    case "/api/attribution": {
      const range = oneOf<AttributionRange>(ATTRIBUTION_RANGES, query.get("range"), "day");
      if (range === null) return json(400, { error: `range: one of ${ATTRIBUTION_RANGES.join(", ")}` });
      // by=tree asks for the drill-down; anything else names one flat grouping, repo by default
      if (query.get("by") === "tree") return json(200, { by: "tree", range, tree: insights.tree(range) });
      const by = oneOf<AttributionBy>(ATTRIBUTION_BY, query.get("by"), "repo");
      if (by === null) return json(400, { error: `by: one of ${ATTRIBUTION_BY.join(", ")}, tree` });
      return json(200, { by, range, rows: insights.attribution(by, range) });
    }
    case "/api/budgets":
      return json(200, { budgets: insights.budgets(), providers: insights.providers() });
    case "/api/budget-status":
      return json(200, insights.budgetStatus());
    case "/api/spend":
      return json(200, { todayUsd: insights.spendToday(), pricesRetrieved: PRICES_RETRIEVED });
    case "/api/settings":
      return json(200, { settings: insights.settings() });
    case "/api/router":
      return json(200, insights.routerHealth());
    case "/api/advisor":
      return json(200, insights.advisor());
    default:
      return null;
  }
}

function saved<T>(key: string, result: T | string): ApiResponse {
  return typeof result === "string" ? json(400, { error: result }) : json(200, { [key]: result });
}

function dismissAlert(insights: Insights, body: unknown): ApiResponse {
  const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !insights.dismiss(id)) return json(400, { error: "id: the alert's id" });
  return json(200, { dismissed: id });
}

/**
 * PUT /api/budgets, PUT /api/settings, POST /api/alerts/dismiss, POST /api/history/clear: validated JSON in,
 * the saved value out. The history clear needs the opened history, not the derived views.
 */
export function handleWrite(
  insights: Insights | undefined,
  method: string,
  path: string,
  body: unknown,
  history?: History | null,
): ApiResponse {
  if (insights === undefined) return json(503, { error: "not available" });
  const route = `${method} ${path}`;
  if (route === "PUT /api/budgets") return saved("budgets", insights.setBudgets(body));
  if (route === "PUT /api/settings") return saved("settings", insights.setSettings(body));
  if (route === "POST /api/alerts/dismiss") return dismissAlert(insights, body);
  if (route === "POST /api/history/clear") {
    if (history === undefined || history === null) return json(503, { error: "history unavailable" });
    history.clear();
    return json(200, { cleared: true });
  }
  return json(405, { error: "method not allowed" });
}

/** One price row per request, shaped the way requestCost reads a record. */
function pricedOf(row: CostRow): PricedRequest {
  return {
    model: row.model ?? "",
    upstream: row.upstream ?? "",
    ts: row.ts,
    tokens: {
      input: row.input ?? 0,
      output: row.output ?? 0,
      cacheRead: row.cacheRead ?? 0,
      cacheWrite: row.cacheWrite ?? 0,
    },
    ...(row.cacheWrite1h !== null ? { cacheWrite1h: row.cacheWrite1h } : {}),
    ...(row.speed !== null ? { speed: row.speed } : {}),
    ...(row.geo !== null ? { geo: row.geo } : {}),
    ...(row.serviceTier !== null ? { serviceTier: row.serviceTier } : {}),
  };
}

/** Sum one request's price into its group; an unpriced request is skipped, a mixed group sums the priced part. */
function addInto(totals: Map<string, number | null>, key: string, row: CostRow): void {
  const cost = requestCost(pricedOf(row));
  if (cost === null) return;
  totals.set(key, addCost(totals.get(key) ?? null, cost.usd));
}

/** Estimated USD per tree, read in batched queries: null when nothing in the tree had a price. */
function costsOfRoots(history: History, rootIds: string[]): Map<string, number | null> {
  const totals = new Map<string, number | null>(rootIds.map((id) => [id, null]));
  for (const row of history.costRows(rootIds)) addInto(totals, row.rootId, row);
  return totals;
}

/** Estimated USD per node of one tree, from the same single batched read. */
function costsOfNodes(history: History, rootId: string): Map<string, number | null> {
  const totals = new Map<string, number | null>();
  for (const row of history.costRows([rootId])) addInto(totals, row.nodeId, row);
  return totals;
}

/** The sessions the Live tab shows, by id: the registry's open mains, never jobs. History keeps these
 *  out, so a session that is open but has been quiet for a while never reads as ended. */
function liveSessionIds(store: Store): string[] {
  return store
    .sessionList()
    .filter((item) => item.live && !item.external && !item.id.includes(":"))
    .map((item) => item.id);
}

/** The one Unattached group the unfiltered first history page ends with: every job no session claims,
 *  rolled up together — never a top-level root per job, and never more than once across the pages. */
function unattachedGroup(history: History, query: URLSearchParams): ReturnType<History["unattached"]> {
  // any filter or page cursor hides it: it is the end of the unfiltered first page alone
  if (numParam(query, "before") !== null) return null;
  if (strParam(query, "q") !== undefined) return null;
  if (strParam(query, "repo") !== undefined) return null;
  return history.unattached({ now: Date.now(), liveMs: HISTORY_LIVE_MS });
}

function historyRoots(history: History, query: URLSearchParams, live: string[]): ApiResponse {
  const scope = oneOf<"live" | "history">(["live", "history"], query.get("scope"), "live");
  if (scope === null) return json(400, { error: "scope: one of live, history" });
  const limit = clampLimit(query.get("limit"));
  const before = numParam(query, "before");
  const search = strParam(query, "q");
  const repo = strParam(query, "repo");
  // one row past the page tells whether a next page exists, so `next` is null exactly at the end
  const found = history.roots({
    scope,
    now: Date.now(),
    liveMs: HISTORY_LIVE_MS,
    limit: limit + 1,
    ...(before === null ? {} : { before }),
    ...(search === undefined ? {} : { search }),
    ...(repo === undefined ? {} : { repo }),
    ...(scope === "history" && live.length > 0 ? { excludeSessions: live } : {}),
  });
  const more = found.length > limit;
  const roots = more ? found.slice(0, limit) : found;
  const group = scope === "history" ? unattachedGroup(history, query) : null;
  const costs = costsOfRoots(history, [
    ...roots.map((root) => root.id),
    ...(group === null ? [] : [group.id]),
  ]);
  const priced = (root: { id: string }): number | null => costs.get(root.id) ?? null;
  const page = [
    ...roots.map((root) => ({ ...root, costUsd: priced(root) })),
    ...(group === null ? [] : [{ ...group, costUsd: priced(group) }]),
  ];
  const last = roots[roots.length - 1];
  return json(200, {
    roots: page,
    next: more && last !== undefined ? last.lastAt : null,
  });
}

function historyTree(history: History, rawId: string): ApiResponse {
  const id = decodeOf(rawId);
  if (id === null) return json(400, { error: "id is not valid URI encoding" });
  if (id === "") return json(404, { error: "missing root id" });
  const nodes = history.tree(id, { now: Date.now(), liveMs: HISTORY_LIVE_MS });
  if (nodes.length === 0) return json(404, { error: `unknown root: ${id}` });
  const costs = costsOfNodes(history, id);
  return json(200, {
    nodes: nodes.map((node) => ({ ...node, costUsd: costs.get(node.id) ?? null })),
  });
}

/** `before` carries the last request of the previous page as "<ts>:<id>"; ids may hold colons. */
function beforeOf(raw: string | null): { ts: number; id: string } | string | undefined {
  if (raw === null || raw === "") return undefined;
  const match = /^(\d+):(.+)$/s.exec(raw);
  if (match === null) return "before: the last request as ts:id";
  return { ts: Number.parseInt(match[1] ?? "", 10), id: match[2] ?? "" };
}

function historyRequests(history: History, query: URLSearchParams): ApiResponse {
  const nodeId = strParam(query, "node");
  const rootId = strParam(query, "root");
  if (nodeId === undefined && rootId === undefined) {
    return json(400, { error: "node or root: name the request's node or its tree" });
  }
  const limit = clampLimit(query.get("limit"));
  const before = beforeOf(query.get("before"));
  if (typeof before === "string") return json(400, { error: before });
  // one row past the page tells whether a next page exists, so `next` is null exactly at the end
  const found = history.requestsOf({
    ...(nodeId === undefined ? { rootId: rootId ?? "" } : { nodeId }),
    limit: limit + 1,
    ...(before === undefined ? {} : { before }),
  });
  const more = found.length > limit;
  const requests = more ? found.slice(0, limit) : found;
  const last = requests[requests.length - 1];
  return json(200, {
    requests: requests.map((request) => ({ ...request, cost: requestCost(request) })),
    next: more && last !== undefined ? `${last.ts}:${last.id}` : null,
  });
}

/** A stored side as the dashboard reads it: its blocks back from JSON, or the plain text it was. */
function sideOf(text: string | null): unknown {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // a side that never was JSON comes back as the text it is
  }
  return text;
}

/** A content response never carries more than this much text; longer blocks are cut with a marker. */
const MAX_CONTENT_BYTES = 1024 * 1024;
const MIN_BLOCK_BYTES = 256;
const MARKER_RESERVE = 64; // room for the "…[truncated N bytes]" marker itself

const jsonOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const jsonBytes = (value: unknown): number => Buffer.byteLength(jsonOf(value), "utf8");

/** `capText`'s rule at any budget: cut on a code point boundary, then name the bytes that did not fit. */
function cutText(text: string, keepBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= keepBytes) return text;
  let kept = text.slice(0, Math.max(0, keepBytes));
  while (Buffer.byteLength(kept, "utf8") > keepBytes) kept = kept.slice(0, -1);
  return `${kept}…[truncated ${Buffer.byteLength(text, "utf8") - Buffer.byteLength(kept, "utf8")} bytes]`;
}

/** What one unit costs the response: a block's JSON, a text side's text, the JSON punctuation around them. */
function unitBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 2; // its quotes
  return jsonBytes(value);
}

function sideBytes(side: unknown[]): number {
  if (side[0] === null || side[0] === undefined) return 4; // "null"
  if (typeof side[0] === "string") return unitBytes(side[0]);
  let total = 2; // the brackets
  for (const block of side[0] as unknown[]) total += unitBytes(block) + 1; // a comma
  return total;
}

/** Cut one oversized unit down to about half its bytes, marker included; a block with no text of its own
 *  (a giant tool input) becomes a text block carrying a cut of its JSON. */
function shaveUnit(value: unknown, bytes: number): unknown {
  const keep = Math.max(MIN_BLOCK_BYTES, Math.floor(bytes / 2) - MARKER_RESERVE);
  if (typeof value === "string") return cutText(value, keep);
  const block = value as Record<string, unknown>;
  if (typeof value === "object" && value !== null && typeof block.text === "string") {
    return { ...block, text: cutText(block.text, keep) };
  }
  return { type: "text", text: cutText(jsonOf(value), keep) };
}

/** One shrinkable unit: a block of a block side, or a whole plain-text side, with its wire size. */
type ContentUnit = { side: number; at: number; bytes: number };

/** The biggest unit of one side, whichever of it and `best` is larger. */
function largestOfSide(at: number, held: unknown, best: ContentUnit | null): ContentUnit | null {
  if (held === null || held === undefined) return best;
  if (typeof held === "string") {
    const bytes = Buffer.byteLength(held, "utf8");
    return (best?.bytes ?? 0) < bytes ? { side: at, at: 0, bytes } : best;
  }
  let winner = best;
  const blocks = held as unknown[];
  for (let index = 0; index < blocks.length; index += 1) {
    const bytes = jsonBytes(blocks[index]);
    if ((winner?.bytes ?? 0) < bytes) winner = { side: at, at: index, bytes };
  }
  return winner;
}

/** The biggest unit left across both sides, or null when neither side holds one. */
function largestUnit(sides: unknown[][]): ContentUnit | null {
  let best: ContentUnit | null = null;
  for (let at = 0; at < sides.length; at += 1) {
    best = largestOfSide(at, sides[at]?.[0], best);
  }
  return best;
}

/** Cut one unit of one side in place. */
function cutUnit(side: unknown[], unit: ContentUnit): void {
  const held = side[0];
  const value = typeof held === "string" ? held : (held as unknown[])[unit.at];
  if (value === undefined) return;
  const shaved = shaveUnit(value, unit.bytes);
  if (typeof held === "string") side[0] = shaved;
  else (held as unknown[])[unit.at] = shaved;
}

/** Hold both sides to the cap by repeatedly cutting the biggest unit left; a text side counts as one unit. */
function capSides(sides: unknown[][]): void {
  const totalOf = (): number => sides.reduce((sum, side) => sum + sideBytes(side), 0);
  for (let guard = 0; guard < 4096 && totalOf() > MAX_CONTENT_BYTES; guard += 1) {
    const unit = largestUnit(sides);
    if (unit === null || unit.bytes <= MIN_BLOCK_BYTES) return; // nothing sizeable left; leave the rest
    const side = sides[unit.side];
    if (side === undefined) return;
    cutUnit(side, unit);
  }
}

function historyContent(history: History, rawId: string): ApiResponse {
  const id = decodeOf(rawId);
  if (id === null) return json(400, { error: "id is not valid URI encoding" });
  if (id === "") return json(404, { error: "missing request id" });
  const stored = history.content(id);
  if (stored === null) return json(404, { error: `unknown request: ${id}` });
  const sides: unknown[][] = [[sideOf(stored.input)], [sideOf(stored.output)]];
  capSides(sides);
  return json(200, { input: sides[0]?.[0] ?? null, output: sides[1]?.[0] ?? null, bytes: stored.bytes });
}

const DEFAULT_FLOW_BUCKETS = 60;

/** GET /api/history/flow?from=&to=&buckets=: the window's requests and token kinds as bars, one SQL
 *  GROUP BY. Both ends are required epochs, from < to; `buckets` is the target bar count, capped at 240. */
function historyFlow(history: History, query: URLSearchParams): ApiResponse {
  const from = numParam(query, "from");
  if (from === null) return json(400, { error: "from: epoch ms the window starts at" });
  const to = numParam(query, "to");
  if (to === null) return json(400, { error: "to: epoch ms the window ends at" });
  if (from >= to) return json(400, { error: "from must be before to" });
  const asked = Number.parseInt(query.get("buckets") ?? "", 10);
  const target = Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_FLOW_BUCKETS;
  const { bucketMs, buckets } = bucketPlan(from, to, target);
  return json(200, history.flow({ from, to, bucketMs, buckets }));
}

/** A context page holds this many messages unless the reader asks for another count. */
const CONTEXT_DEFAULT_LIMIT = 40;
const CONTEXT_MAX_LIMIT = 200;

/** What the rebuilt conversation cannot have: the transcript never carried them. */
export const CONTEXT_NOTE = "System prompt and tool definitions are not in the transcript.";

/** One context page's blocks never carry more than this much text; the older pages fetch on demand. */
const CONTEXT_MESSAGE_BUDGET = MAX_CONTENT_BYTES;

type CappedMessage = { blocks: unknown[] };

const messageWireBytes = (message: CappedMessage): number =>
  message.blocks.reduce<number>((sum, block) => sum + unitBytes(block) + 1, 2);

/** Where one block carries text, with its byte size; a block without text holds nothing. */
function textHolds(
  block: unknown,
): { holder: { text?: string; thinking?: string }; key: "text" | "thinking"; bytes: number }[] {
  if (typeof block !== "object" || block === null) return [];
  const holder = block as { text?: unknown; thinking?: unknown };
  return (["text", "thinking"] as const)
    .map((key) => ({ key, held: holder[key] }))
    .filter((entry): entry is { key: "text" | "thinking"; held: string } => typeof entry.held === "string")
    .map((entry) => ({
      holder: holder as { text?: string; thinking?: string },
      key: entry.key,
      bytes: Buffer.byteLength(entry.held, "utf8"),
    }));
}

/** The biggest text any block on the page carries, or null when no block carries text any more. */
function biggestContextText(
  messages: CappedMessage[],
): { holder: { text?: string; thinking?: string }; key: "text" | "thinking"; bytes: number } | null {
  let worst: ReturnType<typeof textHolds>[number] | null = null;
  for (const message of messages) {
    for (const block of message.blocks) {
      for (const hold of textHolds(block)) {
        if ((worst?.bytes ?? 0) < hold.bytes) worst = hold;
      }
    }
  }
  return worst;
}

/** Hold one page's texts to the budget by repeatedly cutting the biggest text left; blocks without text of
 *  their own (a giant tool input) stay whole, and the page stays honest about what was cut. */
function capContextPage(messages: CappedMessage[]): void {
  for (let guard = 0; guard < 4096; guard += 1) {
    const total = messages.reduce((sum, message) => sum + messageWireBytes(message), 0);
    if (total <= CONTEXT_MESSAGE_BUDGET) return;
    const worst = biggestContextText(messages);
    if (worst === null || worst.bytes <= MIN_BLOCK_BYTES) return;
    const keep = Math.max(MIN_BLOCK_BYTES, Math.floor(worst.bytes / 2) - MARKER_RESERVE);
    worst.holder[worst.key] = cutText(worst.holder[worst.key] ?? "", keep);
  }
}

/** The page query the conversation reads share: the clamped limit and the well-formed cursor. */
function contextQuery(query: URLSearchParams): { limit: number; cursor?: string } | ApiResponse {
  const rawCursor = query.get("cursor");
  if (rawCursor !== null && rawCursor !== "" && !/^(\d+):(.+):[01]$/s.test(rawCursor)) {
    return json(400, { error: "cursor: the page's oldest message as ts:requestId:side" });
  }
  const asked = numParam(query, "limit");
  const limit = asked === null ? CONTEXT_DEFAULT_LIMIT : Math.min(Math.max(asked, 1), CONTEXT_MAX_LIMIT);
  return {
    limit,
    ...(rawCursor === null || rawCursor === "" ? {} : { cursor: rawCursor }),
  };
}

/** The conversation a request sat in, rebuilt from the stored sides of its node's requests. */
function historyContext(history: History, rawId: string, query: URLSearchParams): ApiResponse {
  const id = decodeOf(rawId);
  if (id === null) return json(400, { error: "id is not valid URI encoding" });
  if (id === "") return json(404, { error: "missing request id" });
  const parsed = contextQuery(query);
  if ("status" in parsed) return parsed;
  const found = history.context(id, parsed);
  if (found === null) return json(404, { error: `unknown request: ${id}` });
  capContextPage(found.messages);
  return json(200, { ...found, note: CONTEXT_NOTE });
}

/** An agent's whole conversation, keyed by its history node — the context route's shape, with the
 *  newest answer included. A node with no stored requests answers an empty page, not a 404. */
function historyAgentTranscript(history: History, rawId: string, query: URLSearchParams): ApiResponse {
  const id = decodeOf(rawId);
  if (id === null) return json(400, { error: "id is not valid URI encoding" });
  if (id === "") return json(404, { error: "missing agent id" });
  const parsed = contextQuery(query);
  if ("status" in parsed) return parsed;
  const found = history.agentTranscript(id, parsed);
  if (found === null) return json(404, { error: `unknown agent: ${id}` });
  capContextPage(found.messages);
  return json(200, { ...found, note: CONTEXT_NOTE });
}

/** GET /api/history/request/<id>/capture: the request's stored prompt capture, decompressed on read,
 *  with the headers its route line recorded. 404 when the request carries none. */
function historyCapture(history: History, rawId: string): ApiResponse {
  const id = decodeOf(rawId);
  if (id === null) return json(400, { error: "id is not valid URI encoding" });
  if (id === "") return json(404, { error: "missing request id" });
  const found = history.capture(id);
  if (found === null) return json(404, { error: `no capture for request: ${id}` });
  return json(200, found);
}

/** The node id an agent-transcript path carries (`/api/history/agent/<id>/transcript`), or null when the
 *  path is not one. The id may hold slashes — subagent nodes are `<session>/<agentId>` — so both ends are
 *  matched and everything between them is the id. */
function agentTranscriptIdOf(path: string): string | null {
  const prefix = "/api/history/agent/";
  const suffix = "/transcript";
  return path.startsWith(prefix) && path.endsWith(suffix) ? path.slice(prefix.length, -suffix.length) : null;
}

/** The request id a capture path carries (`/api/history/request/<id>/capture`), or null when the path is
 *  not one; the id is everything between the prefix and the suffix, slashes included. */
function captureIdOf(path: string): string | null {
  const prefix = "/api/history/request/";
  const suffix = "/capture";
  return path.startsWith(prefix) && path.endsWith(suffix) ? path.slice(prefix.length, -suffix.length) : null;
}

/** The reads whose id sits between a prefix and a suffix: a request's capture, an agent's transcript. */
function historySuffixed(history: History, path: string, query: URLSearchParams): ApiResponse | null {
  const capture = captureIdOf(path);
  if (capture !== null) return historyCapture(history, capture);
  const agent = agentTranscriptIdOf(path);
  return agent === null ? null : historyAgentTranscript(history, agent, query);
}

/** The history reads, or null when the path is not one of them; the caller answers 503 without a history.
 *  `live` hands over the registry's open sessions lazily, so only the reads that exclude them build it. */
function historyRoute(
  history: History,
  insights: Insights | undefined,
  path: string,
  query: URLSearchParams,
  live: () => string[],
): ApiResponse | null {
  if (path === "/api/history/roots") return historyRoots(history, query, live());
  if (path === "/api/history/requests") return historyRequests(history, query);
  if (path === "/api/history/repos") return json(200, { repos: history.repos() });
  if (path === "/api/history/flow") return historyFlow(history, query);
  if (path === "/api/history/stats") {
    const ids = live();
    return json(200, {
      ...history.stats({
        now: Date.now(),
        liveMs: HISTORY_LIVE_MS,
        ...(ids.length > 0 ? { excludeSessions: ids } : {}),
      }),
      retentionDays: insights?.settings().historyRetentionDays ?? DEFAULT_SETTINGS.historyRetentionDays,
    });
  }
  if (path.startsWith("/api/history/tree/"))
    return historyTree(history, path.slice("/api/history/tree/".length));
  if (path.startsWith("/api/history/content/")) {
    return historyContent(history, path.slice("/api/history/content/".length));
  }
  if (path.startsWith("/api/history/context/")) {
    return historyContext(history, path.slice("/api/history/context/".length), query);
  }
  return historySuffixed(history, path, query);
}

const HISTORY_PATHS = new Set([
  "/api/history/roots",
  "/api/history/requests",
  "/api/history/repos",
  "/api/history/flow",
  "/api/history/stats",
]);

function isHistoryPath(path: string): boolean {
  return (
    HISTORY_PATHS.has(path) ||
    path.startsWith("/api/history/tree/") ||
    path.startsWith("/api/history/content/") ||
    path.startsWith("/api/history/context/") ||
    (path.startsWith("/api/history/request/") && path.endsWith("/capture")) ||
    (path.startsWith("/api/history/agent/") && path.endsWith("/transcript"))
  );
}

/** The /api/history reads, the 503 included; null when the path is not one of them. */
function historyAnswer(
  history: History | null | undefined,
  insights: Insights | undefined,
  path: string,
  query: URLSearchParams,
  live: () => string[],
): ApiResponse | null {
  if (!isHistoryPath(path)) return null;
  if (history === undefined || history === null) return json(503, { error: "history unavailable" });
  return historyRoute(history, insights, path, query, live);
}

/** One session's detail, or null when the path is not a session id. */
function sessionRoute(store: Store, path: string): ApiResponse | null {
  if (!path.startsWith("/api/sessions/")) return null;
  const id = decodeURIComponent(path.slice("/api/sessions/".length));
  if (id === "") return json(404, { error: "missing session id" });
  const session = store.sessionDetail(id);
  return session === null ? json(404, { error: `unknown session: ${id}` }) : json(200, { session });
}

/** Route one request; unknown /api paths get a 404 with the known routes listed. */
export function handleApi(
  store: Store,
  info: AppInfo,
  request: ApiRequest,
  insights?: Insights,
  history?: History | null,
): ApiResponse {
  const { path, query } = request;
  const derived = insights === undefined ? null : insightRoute(insights, path, query);
  if (derived !== null) return derived;
  const historic = historyAnswer(history, insights, path, query, () => liveSessionIds(store));
  if (historic !== null) return historic;
  if (path === "/api/summary") {
    return json(200, { summary: store.summary() });
  }
  if (path === "/api/sessions") {
    return json(200, { sessions: sessionTree(store.sessionList()) });
  }
  const session = sessionRoute(store, path);
  if (session !== null) return session;
  const listed = listRoute(store, path, query);
  if (listed !== null) return listed;
  if (path === "/api/models") return modelsRoute(store, query);
  if (path === "/api/health") {
    return json(200, {
      ok: true,
      version: info.version,
      startedAt: info.startedAt,
      port: info.port,
      sessions: store.sessionCount(),
      uptimeMs: Date.now() - info.startedAt,
    });
  }
  return json(404, { error: `no such route: ${path}`, routes: ROUTES });
}

export const ROUTES = [
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
] as const;
