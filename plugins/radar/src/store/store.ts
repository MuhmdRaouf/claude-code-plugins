/**
 * The in-memory model, rebuilt from disk on start and fed incrementally after that. Bounded: at most
 * MAX_SESSIONS sessions and MAX_RECORDS request/tool/event records, shed oldest-timestamp first in
 * batches, a live session's live agents kept while anything less protected remains. Reads group records
 * by session once per version (cached), so a full projection costs one pass, not sessions × records.
 */
import { existsSync, readFileSync } from "node:fs";
import { type CostSplit, costByFamily, costOfAll } from "../cost/prices.ts";
import { contextOf, contextWindow } from "../shared/context.ts";
import {
  type Activity,
  type AgentKind,
  type AgentView,
  type ApiErrorRecord,
  addTokens,
  type CaptureRecord,
  type EventRecord,
  MAX_RECORDS,
  MAX_SESSIONS,
  type ModelRow,
  NOTICE_EVENT,
  OUTSIDE_SESSION,
  promptTitle,
  type RegistrySession,
  type RequestRecord,
  type RouterEventRecord,
  type SessionView,
  type SpoolLine,
  type Summary,
  type Tokens,
  type ToolCallRecord,
  totalTokens,
  UNATTACHED_NAME,
  type UpstreamRow,
  ZERO_TOKENS,
} from "../shared/model.ts";
import { repoName, repoOf } from "../shared/repo.ts";
import { activityOf } from "./activity.ts";
import { modelRows, percentile, summarize, toolCounts, upstreamRows } from "./aggregate.ts";
import { combine, fillUpstream, fromRouter, MATCH_MS, matchDistance, refresh } from "./merge.ts";

export type SessionListItem = {
  id: string;
  project: string | null;
  cwd: string | null;
  name: string | null;
  branch: string | null;
  repo: string | null;
  parentSessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  live: boolean;
  /** Working or idle, from Claude Code's registry; null when the store cannot tell. */
  status: "working" | "idle" | null;
  /** Request activity in 48 buckets: a live session's last 15 minutes, an ended one's whole span. */
  activity: Activity;
  model: string | null;
  agentCount: number;
  /** How many of those agents are live now (the card's "N live"); the total stays its own number. */
  liveAgentCount: number;
  requestCount: number;
  tokens: number;
  lastAt: number;
  external: boolean;
  title: string | null;
  /** Estimated USD at list price; null when none of its models is priced. */
  costUsd?: number | null;
  /** The same requests' cost split by model family — the session header's "X Claude / Y GLM" reads
   *  this, so it covers the very requests the card's `costUsd` sums and adds up to it. */
  costSplitUsd?: CostSplit;
  /** What the session's main agent is doing right now — its newest call's one-line what and when that
   *  request went out — for the rail card's now line. Null once the session is no longer live. */
  now?: { what: string | null; ts: number } | null;
  /** How full that same call's context window is, and how large the window is, for the card's gauge.
   *  Null once the session is no longer live. */
  context?: { used: number; window: number } | null;
};

/** A session list item with its jobs folded under it: the shape /api/sessions serves — main sessions
 *  and the Unattached group at the top level, every job a child of the session that submitted it. */
export type SessionTreeItem = SessionListItem & { jobs?: SessionTreeItem[] };

/** A session radar only saw through a provider plugin: the same rule the dashboard's rail applies. */
const isJobItem = (item: SessionListItem): boolean => item.external || item.id.includes(":");

/** The session's newest main-agent request that is one call and not a run total: what the rail card's
 *  now line reads and what its context gauge measures. Null when the session has no such request —
 *  a subagent's calls never speak for the session, and a run total is no one call's context. */
function currentCall(requests: RequestRecord[]): RequestRecord | null {
  let current: RequestRecord | null = null;
  for (const request of requests) {
    if (request.agentId !== "main" || request.totals === true) continue;
    if (current === null || request.ts >= current.ts) current = request;
  }
  return current;
}

/** The rail card's now line and context gauge, from the session's own requests: its newest main call,
 *  and how full that call's context window is. Both null once the session is no longer live, or when
 *  it has no main-agent call to quote. */
function cardPresence(
  requests: RequestRecord[],
  live: boolean,
): {
  now: { what: string | null; ts: number } | null;
  context: { used: number; window: number } | null;
} {
  if (!live) return { now: null, context: null };
  const current = currentCall(requests);
  if (current === null) return { now: null, context: null };
  return {
    now: { what: current.what ?? null, ts: current.ts },
    context: { used: contextOf(current), window: contextWindow(requests) },
  };
}

/**
 * The session list as the tree the API serves: a job is never a top-level session item. A job whose
 * submitting session is listed hangs under it (a job of a job under their first main ancestor); one
 * whose chain leads nowhere — no origin, or a parent the list does not know — joins the Unattached
 * group, where history keeps the traffic no session owns.
 */
export function sessionTree(items: SessionListItem[]): SessionTreeItem[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  /** The nearest non-job ancestor of a job, or null when its chain ends without one. */
  const ancestorOf = (job: SessionListItem): SessionListItem | null => {
    const seen = new Set<string>([job.id]);
    let current = job;
    for (;;) {
      const next = current.parentSessionId === null ? null : byId.get(current.parentSessionId);
      if (next === null || next === undefined || seen.has(next.id)) return null;
      if (!isJobItem(next)) return next;
      seen.add(next.id);
      current = next;
    }
  };
  const tree = new Map<string, SessionTreeItem>(
    items.filter((item) => !isJobItem(item)).map((item) => [item.id, { ...item }] as const),
  );
  const unattached = tree.get(OUTSIDE_SESSION);
  for (const item of items) {
    if (!isJobItem(item)) continue;
    const parent = ancestorOf(item) ?? unattached;
    if (parent === undefined) continue; // no Unattached item in this list: the job has nowhere to hang
    const holder = tree.get(parent.id);
    if (holder === undefined) continue;
    const jobs = holder.jobs ?? [];
    jobs.push({ ...item });
    holder.jobs = jobs;
  }
  return [...tree.values()];
}

type AgentState = {
  id: string;
  parentId: string | null;
  kind: AgentKind;
  name: string | null;
  agentType: string | null;
  description: string | null;
  model: string | null;
  live: boolean;
  startedAt: number | null;
  endedAt: number | null;
  title: string | null;
};

/** The names a session's transcript carries; the latest value of each stands. */
type SessionTitles = {
  customTitle: string | null;
  agentName: string | null;
  aiTitle: string | null;
  slug: string | null;
};

type SessionState = {
  id: string;
  cwd: string | null;
  upstream: string | null;
  ccVersion: string | null;
  titles: SessionTitles;
  branch: string | null;
  /** A job's workspace repo root; a plain session derives its repo from cwd, cached per cwd. */
  repo: string | null;
  parentSessionId: string | null;
  external: boolean;
  startedAt: number | null;
  /** The start the registry named for the session, while it lists it: what a live session displays. */
  registryStartedAt: number | null;
  endedAt: number | null;
  /** Only Claude Code's registry (or a SessionStart hook, until the next rescan) says a session is live. */
  live: boolean;
  /** The registry's name for the session, when the user named it; else the transcript titles stand. */
  registryName: string | null;
  /** The registry's own derived name for the session; outranked by every human and transcript choice. */
  registryDerivedName: string | null;
  /** The registry's busy/idle state, as long as the session is live. */
  status: "working" | "idle" | null;
  model: string | null;
  lastAt: number;
  agents: Map<string, AgentState>;
};

/** One agent's records within a session, pre-computed so a view never filters the session's records. */
type AgentSlice = {
  requests: RequestRecord[];
  tools: ToolCallRecord[];
  failed: number;
  lastRequest: RequestRecord | undefined;
  lastTs: number;
  tokens: Tokens;
};

/** Records grouped by session (and per-agent inside), rebuilt lazily when the version moves. */
type SessionSlice = {
  requests: RequestRecord[];
  tools: ToolCallRecord[];
  failed: number;
  tokens: Tokens;
  byAgent: Map<string, AgentSlice>;
};

type Projection = Map<string, SessionSlice>;

const EMPTY_AGENT_SLICE: AgentSlice = {
  requests: [],
  tools: [],
  failed: 0,
  lastRequest: undefined,
  lastTs: 0,
  tokens: ZERO_TOKENS,
};

const EMPTY_SLICE: SessionSlice = {
  requests: [],
  tools: [],
  failed: 0,
  tokens: ZERO_TOKENS,
  byAgent: new Map(),
};

function sliceOf(map: Projection, sessionId: string): SessionSlice {
  let slice = map.get(sessionId);
  if (slice === undefined) {
    slice = { requests: [], tools: [], failed: 0, tokens: ZERO_TOKENS, byAgent: new Map() };
    map.set(sessionId, slice);
  }
  return slice;
}

function agentSliceOf(slice: SessionSlice, agentId: string): AgentSlice {
  let mine = slice.byAgent.get(agentId);
  if (mine === undefined) {
    mine = { requests: [], tools: [], failed: 0, lastRequest: undefined, lastTs: 0, tokens: ZERO_TOKENS };
    slice.byAgent.set(agentId, mine);
  }
  return mine;
}

/** A tool call into a slice's totals, under its agent when the caller means one. */
function countTool(target: { tools: ToolCallRecord[]; failed: number }, tool: ToolCallRecord): void {
  target.tools.push(tool);
  if (!tool.ok) target.failed += 1;
}

/** Per-agent roll-ups once the grouping is done: the request split, each agent's clock and tokens. */
function rollUpSlice(slice: SessionSlice): void {
  slice.tokens = ZERO_TOKENS;
  for (const request of slice.requests) {
    slice.tokens = addTokens(slice.tokens, request.tokens);
    agentSliceOf(slice, request.agentId).requests.push(request);
  }
  for (const mine of slice.byAgent.values()) {
    mine.lastRequest = mine.requests.at(-1);
    mine.lastTs = mine.requests.reduce((acc, r) => Math.max(acc, r.ts), 0);
    mine.tokens = mine.requests.reduce((acc, r) => addTokens(acc, r.tokens), ZERO_TOKENS);
  }
}

/** A request's captured input and output text, keyed by the id the request is stored under. */
export type ContentRecord = { requestId: string; input: string | null; output: string | null };

export type Change = {
  sessions: boolean;
  /** Every session the change touched (its records' sessions, or the one an upsert/end named). */
  touched: string[];
  requests: RequestRecord[];
  events: EventRecord[];
  tools: ToolCallRecord[];
  content: ContentRecord[];
  /** Distinct prompt captures the change brought (a spool capture line); only the history writer reads
   *  them, so the store holds none. */
  captures?: CaptureRecord[];
};

export type RequestFilter = {
  session?: string;
  agent?: string;
  model?: string;
  since?: number;
  limit?: number;
};

/** What the models tables can be narrowed to: a time window and the picked sessions. Absent = all. */
export type ModelsScope = { from?: number; to?: number; sessions?: string[] };

export type SessionUpsert = {
  id: string;
  cwd?: string;
  upstream?: string;
  startedAt?: number;
  external?: boolean;
  ccVersion?: string;
  /** Naming data from the transcript; the latest value of each wins. */
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  slug?: string;
  branch?: string;
  /** What a job ingest knows outright; when absent a plain session derives its repo from cwd. */
  repo?: string;
  parentSessionId?: string;
};

export type Store = {
  addSpoolLine(line: SpoolLine): void;
  /** The transcript's input/output capture rides with its request; the stored id (a route pairing may
   *  have renamed it) keys the content, so it always lands beside the request it belongs to. */
  addRequest(record: RequestRecord, content?: { input: string | null; output: string | null }): void;
  /** One distinct prompt capture, passed straight through to the history writer: the store itself keeps
   *  none (nothing in the dashboard reads it live, and the bytes belong on disk once). */
  addCapture(record: CaptureRecord): void;
  addToolCall(record: ToolCallRecord): void;
  upsertSession(input: SessionUpsert): void;
  endSession(id: string, endedAt: number): void;
  /** Claude Code's own live-session registry, rescanned every few seconds: what is live, and how it is. */
  applyRegistry(entries: RegistrySession[], now: number): void;
  upsertAgent(input: AgentUpsert): void;
  endAgent(sessionId: string, agentId: string, endedAt: number): void;
  summary(): Summary;
  sessionList(): SessionListItem[];
  /** How many sessions the store knows, without building a single view: what a health check reads. */
  sessionCount(): number;
  sessionDetail(id: string): SessionView | null;
  requests(filter: RequestFilter): RequestRecord[];
  requestsFor(filter: { session?: string; since?: number }): RequestRecord[];
  events(filter: { session?: string; since?: number; limit?: number }): EventRecord[];
  /** Recent tool calls, newest first; `failed` keeps only the ones that errored. */
  tools(filter: { session?: string; failed?: boolean; limit?: number }): ToolCallRecord[];
  /** The models tab's tables. Without a scope this is the whole store's cached answer — the one the
   *  snapshot pushes; a scope (a window, the picked sessions) aggregates those requests fresh. */
  models(scope?: ModelsScope): {
    models: ModelRow[];
    upstreams: UpstreamRow[];
    tools: { name: string; count: number; failures: number }[];
  };
  /** A 429/5xx seen anywhere (transcript retry, route line, router event); kept for the retry-storm alert. */
  addApiError(record: ApiErrorRecord): void;
  /** A router health event (fallback, refusal, rate limit, budget stop, restart). */
  addRouterEvent(record: RouterEventRecord): void;
  apiErrors(): ApiErrorRecord[];
  routerEvents(): RouterEventRecord[];
  /** Every request, tool call and event held, unsorted — the alert engine's input. */
  raw(): { requests: RequestRecord[]; tools: ToolCallRecord[]; events: EventRecord[] };
  onUpdate(listener: (change: Change) => void): () => void;
  version(): number;
};

/** Side records (API errors, router events) are small and only matter while recent: keep the newest few. */
const MAX_SIDE_RECORDS = 5000;

/** Eviction sheds a tenth of the cap in one pass, so a pass costs a tenth of an insert amortised — a
 *  per-insert eviction would mean a full scan of the store on every catch-up line. */
const EVICT_BATCH = Math.ceil(MAX_RECORDS / 10);

/** One record the eviction pass considers: which collection holds it, its own timestamp, and whether a
 *  live session's live agent owns it. `id` breaks exact ties (and is unique within a source). */
type EvictionCandidate = { rank: 0 | 1; ts: number; source: 0 | 1 | 2; id: string };

/** The records a mutation just placed, pinned against the one eviction its own inserts triggered. */
type EvictionPin = { source: 0 | 1 | 2; id: string };

const NO_PINS: EvictionPin[] = [];

/**
 * Would `a` be shed after `b` — more protected (a live agent's), or equally protected but newer? The
 * total order a bounded max-heap sorts by: its root is always the record of the current eviction batch
 * that has the least claim on being kept, the next to make room for a better candidate.
 */
function outlives(a: EvictionCandidate, b: EvictionCandidate): boolean {
  if (a.rank !== b.rank) return a.rank > b.rank;
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.source !== b.source) return a.source > b.source;
  return a.id > b.id;
}

/** Pushes one candidate under the `outlives` order, sifting it up towards the root it may have displaced. */
function heapPush(heap: EvictionCandidate[], candidate: EvictionCandidate): void {
  heap.push(candidate);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    const kid = heap[child];
    const up = heap[parent];
    if (kid === undefined || up === undefined || !outlives(kid, up)) break;
    heap[parent] = kid;
    heap[child] = up;
    child = parent;
  }
}

/** Removes the root — the batch's least keepable record — and restores the heap in one sift-down. */
function heapPop(heap: EvictionCandidate[]): void {
  const last = heap.pop();
  const root = heap[0];
  if (last === undefined || root === undefined) return;
  heap[0] = last;
  let parent = 0;
  for (;;) {
    const left = parent * 2 + 1;
    const leftChild = heap[left];
    if (leftChild === undefined) break;
    const rightChild = heap[left + 1];
    let worst = leftChild;
    let worstAt = left;
    if (rightChild !== undefined && outlives(rightChild, leftChild)) {
      worst = rightChild;
      worstAt = left + 1;
    }
    const top = heap[parent];
    if (top === undefined || !outlives(worst, top)) break;
    heap[parent] = worst;
    heap[worstAt] = top;
    parent = worstAt;
  }
}

/** How recent a subagent's last request (or start) must be for it to read as live. */
const SUBAGENT_LIVE_MS = 5 * 60_000;

/** A percentile over fewer timed requests than this says nothing; the view shows a dash instead. */
const MIN_P95_SAMPLES = 5;

/** The only filesystem the store touches: stat and read a `.git`, to name the repo a session works in. */
const REPO_FS = {
  exists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

function tsToMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function projectOf(cwd: string | null): string | null {
  if (cwd === null || cwd === "") return null;
  const base = cwd
    .split("/")
    .filter((part) => part !== "")
    .pop();
  return base ?? cwd;
}

function earlierStarted(state: SessionState, startedAt: number | undefined): void {
  if (startedAt === undefined) return;
  if (state.startedAt === null || startedAt < state.startedAt) state.startedAt = startedAt;
}

/** First writer wins each fact; a later upsert only fills what is still blank. */
function applySessionUpsert(state: SessionState, input: SessionUpsert): void {
  if (input.cwd !== undefined && state.cwd === null) state.cwd = input.cwd;
  if (input.upstream !== undefined && state.upstream === null) state.upstream = input.upstream;
  if (input.ccVersion !== undefined && state.ccVersion === null) state.ccVersion = input.ccVersion;
  earlierStarted(state, input.startedAt);
  if (input.external !== undefined) {
    state.external = input.external;
    // a job's lifecycle is the job files' business, not the registry's: it runs while its job says so
    if (input.external) state.live = true;
  }
  applySessionNaming(state, input);
}

/** The naming side of an upsert: names and branch change as the session runs, repo and parent do not.
 *  A blank value changes nothing, so an empty line can never erase a name. */
function applySessionNaming(state: SessionState, input: SessionUpsert): void {
  if (input.customTitle !== undefined && input.customTitle !== "")
    state.titles.customTitle = input.customTitle;
  if (input.agentName !== undefined && input.agentName !== "") state.titles.agentName = input.agentName;
  if (input.aiTitle !== undefined && input.aiTitle !== "") state.titles.aiTitle = input.aiTitle;
  if (input.slug !== undefined && input.slug !== "") state.titles.slug = input.slug;
  if (input.branch !== undefined && input.branch !== "") state.branch = input.branch;
  if (input.repo !== undefined) state.repo = input.repo;
  if (input.parentSessionId !== undefined) state.parentSessionId = input.parentSessionId;
}

/** First non-empty of the four names a transcript can give a session, in that order. */
function sessionName(titles: SessionTitles): string | null {
  return titles.customTitle ?? titles.agentName ?? titles.aiTitle ?? titles.slug;
}

/** The registry's status word as the view states it: busy is working, idle is idle, the rest unknown. */
function registryStatusOf(status: string | null): "working" | "idle" | null {
  return status === "busy" ? "working" : status === "idle" ? "idle" : null;
}

/** The view name, in the order anyone may name a session: the user's registry name, the transcript's
 *  titles (custom title, agent name, AI title, slug), the registry's own derived name, the repo's name,
 *  and finally the id's first eight characters — never null, never a path. The unattached pseudo
 *  session always reads as its own group, never as a project or an id. */
function viewName(state: SessionState, repo: string | null): string | null {
  if (state.id === OUTSIDE_SESSION) return UNATTACHED_NAME;
  return (
    state.registryName ??
    sessionName(state.titles) ??
    state.registryDerivedName ??
    (repo === null ? null : repoName(repo)) ??
    `Session ${state.id.slice(0, 8)}`
  );
}

/** The unattached traffic is never open: it reads as ended at its last activity, so history keeps it
 *  out of the live scope and groups it under its own name. */
function viewEndedAt(state: SessionState): number | null {
  if (state.id === OUTSIDE_SESSION && state.lastAt > 0) return Math.max(state.endedAt ?? 0, state.lastAt);
  return state.endedAt;
}

type AgentUpsert = {
  sessionId: string;
  id: string;
  parentId?: string | null;
  kind?: AgentKind;
  name?: string | null;
  agentType?: string | null;
  description?: string | null;
  model?: string | null;
  title?: string | null;
};

function applyAgentUpsert(target: AgentState, input: AgentUpsert): void {
  if (input.parentId !== undefined) target.parentId = input.parentId;
  if (input.kind !== undefined) target.kind = input.kind;
  if (input.name !== undefined && input.name !== null) target.name = input.name;
  if (input.agentType !== undefined && input.agentType !== null) target.agentType = input.agentType;
  if (input.description !== undefined && input.description !== null) target.description = input.description;
  if (input.model !== undefined && input.model !== null && target.model === null) {
    target.model = input.model;
  }
  if (input.title !== undefined) target.title = input.title;
  if (input.kind === "external") target.live = true;
}

/**
 * An agent's display name. A subagent is its meta file's type and task ("Explore — find the flaky
 * test"), else the head of its first prompt, else the name a source gave it, else just "Subagent" —
 * never the raw `agent-…` id. Main and job agents keep the names their own sources gave them.
 */
function agentNameOf(agent: AgentState): string | null {
  if (agent.kind === "main") return agent.name ?? "main";
  if (agent.agentType !== null) {
    return agent.description === null || agent.description === ""
      ? agent.agentType
      : `${agent.agentType} — ${agent.description}`;
  }
  if (agent.title !== null && agent.title !== "") return agent.title;
  if (agent.name !== null) return agent.name;
  return agent.kind === "subagent" ? "Subagent" : agent.id;
}

/** How many fresh entries a prune reads past before it stops: the walk costs what it drops plus this
 *  many checks, so a burst of calls inside the match window (which nothing can prune) pays a constant
 *  per insert, and a catch-up's stale tail still goes in one pass — the advancing frontier turns it
 *  stale, and the next call's walk deletes it where it stands. */
const PRUNE_LOOKAHEAD = 8;

/**
 * Delete a key's waiting entries the incoming call can no longer pair with: a twin must sit within
 * MATCH_MS of it, and a record the store's caps evicted can never pair at all. Dropped where the call
 * arrives, walking from the front, so the closest-fit scan reads genuinely recent candidates and the
 * waiting maps stay flat — a catch-up or an uptime can otherwise queue thousands of calls that will
 * never meet their pair.
 */
export function pruneWaiting(
  waiting: Set<string> | Map<string, string>,
  atTs: number,
  recordOf: (id: string) => { ts: number } | undefined,
): void {
  let fresh = 0;
  for (const id of waiting.keys()) {
    const record = recordOf(id);
    if (record === undefined || atTs - record.ts > MATCH_MS) {
      waiting.delete(id);
      continue;
    }
    fresh += 1;
    if (fresh >= PRUNE_LOOKAHEAD) break;
  }
}

export function createStore(): Store {
  let seq = 0;
  let ver = 0;
  /** repoOf per cwd, computed once: walking up to the nearest .git is disk work no view should repeat. */
  const repoCache = new Map<string, string | null>();
  const repoFor = (cwd: string | null): string | null => {
    if (cwd === null) return null;
    let repo = repoCache.get(cwd);
    if (repo === undefined) {
      repo = repoOf(cwd, REPO_FS);
      repoCache.set(cwd, repo);
    }
    return repo;
  };
  const sessions = new Map<string, SessionState>();
  const requests = new Map<string, RequestRecord>();
  const tools = new Map<string, ToolCallRecord>();
  const events: EventRecord[] = [];
  const listeners = new Set<(change: Change) => void>();
  const apiErrors: ApiErrorRecord[] = [];
  const routerEvents: RouterEventRecord[] = [];
  /** tool_use ids seen in a PreToolUse spool line but not finished there; transcript pairing completes them. */
  const pendingToolStarts = new Map<string, number>();
  let cache: { version: number; projection: Projection } | null = null;
  /** Built session views per (session, version): list, detail and summary reads within one version are free. */
  let views: { version: number; bySession: Map<string, SessionView> } | null = null;
  /** Newest-first record order per version: the list reads slice it, never re-sorting the store per call. */
  let order: { version: number; requests: RequestRecord[]; tools: ToolCallRecord[] } | null = null;
  /** Derived whole-store answers (the session list, the summary, the model tables), one build per
   *  version: a burst of reads — a connecting stream, back-to-back list routes — is answered free. */
  type Cached<T> = { version: number; at: number; value: T };
  const listCache: { current: Cached<SessionListItem[]> | null } = { current: null };
  const summaryCache: { current: Cached<Summary> | null } = { current: null };
  const modelsCache: {
    current: Cached<{
      models: ModelRow[];
      upstreams: UpstreamRow[];
      tools: { name: string; count: number; failures: number }[];
    }> | null;
  } = { current: null };
  /** Claude Code's own error notices per session, per agent: errors with no model request behind them. */
  const notices = new Map<string, Map<string, number>>();

  function noticesOf(sessionId: string, agentId?: string): number {
    const bySession = notices.get(sessionId);
    if (bySession === undefined) return 0;
    if (agentId !== undefined) return bySession.get(agentId) ?? 0;
    let total = 0;
    for (const count of bySession.values()) total += count;
    return total;
  }

  function countNotice(sessionId: string, agentId: string | null): void {
    const bySession = notices.get(sessionId) ?? new Map<string, number>();
    const key = agentId ?? "main";
    bySession.set(key, (bySession.get(key) ?? 0) + 1);
    notices.set(sessionId, bySession);
  }

  function session(id: string): SessionState {
    let state = sessions.get(id);
    if (state === undefined) {
      state = {
        id,
        cwd: null,
        upstream: null,
        ccVersion: null,
        titles: { customTitle: null, agentName: null, aiTitle: null, slug: null },
        branch: null,
        repo: null,
        parentSessionId: null,
        external: false,
        startedAt: null,
        registryStartedAt: null,
        endedAt: null,
        // nothing is live because the store saw it: only the registry (or a SessionStart hook, or a
        // job's own files) makes a session live, so a read transcript can never pose as an open one
        live: false,
        registryName: null,
        registryDerivedName: null,
        status: null,
        model: null,
        lastAt: 0,
        agents: new Map<string, AgentState>(),
      };
      sessions.set(id, state);
    }
    return state;
  }

  function agent(sessionId: string, agentId: string): AgentState {
    const state = session(sessionId);
    let existing = state.agents.get(agentId);
    if (existing === undefined) {
      existing = {
        id: agentId,
        parentId: agentId === "main" ? null : "main",
        kind: agentId === "main" ? "main" : "subagent",
        // a subagent starts unnamed: its id is never a display name, and only its meta file, its first
        // prompt or an explicit upsert may name it
        name: agentId === "main" ? "main" : null,
        agentType: null,
        description: null,
        model: null,
        live: false,
        startedAt: null,
        endedAt: null,
        title: null,
      };
      state.agents.set(agentId, existing);
    }
    return existing;
  }

  function touch(sessionId: string, ts: number): void {
    const state = session(sessionId);
    if (ts > state.lastAt) state.lastAt = ts;
    if (state.startedAt === null || ts < state.startedAt) state.startedAt = ts;
  }

  function projection(): Projection {
    if (cache !== null && cache.version === ver) return cache.projection;
    const map: Projection = new Map();
    groupRecords(map);
    for (const slice of map.values()) rollUpSlice(slice);
    cache = { version: ver, projection: map };
    return map;
  }

  /** Requests and tools into per-session slices, split per agent as the session's own index. */
  function groupRecords(map: Projection): void {
    for (const request of requests.values()) {
      sliceOf(map, request.sessionId).requests.push(request);
    }
    for (const tool of tools.values()) {
      const slice = sliceOf(map, tool.sessionId);
      countTool(slice, tool);
      countTool(agentSliceOf(slice, tool.agentId ?? "main"), tool);
    }
  }

  function dropSession(sessionId: string): void {
    sessions.delete(sessionId);
    notices.delete(sessionId);
    for (const [id, record] of requests) if (record.sessionId === sessionId) requests.delete(id);
    for (const [id, record] of tools) if (record.sessionId === sessionId) tools.delete(id);
  }

  function evictSessions(): void {
    if (sessions.size <= MAX_SESSIONS) return;
    const ordered = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt);
    for (const victim of ordered.slice(0, sessions.size - MAX_SESSIONS)) dropSession(victim.id);
  }

  /** 1 while the record belongs to a live session's live agent — the dashboard's very subject: such a
   *  record is offered to eviction only once nothing less protected remains to shed instead. */
  function rankOf(sessionId: string | null, agentId: string | null): 0 | 1 {
    if (sessionId === null) return 0;
    const state = sessions.get(sessionId);
    if (state === undefined || !state.live) return 0;
    return state.agents.get(agentId ?? "main")?.live === true ? 1 : 0;
  }

  /**
   * Sheds records past the cap, oldest by their own timestamps first — request `ts`, tool `startedAt`,
   * event `ts` — never by insertion order: catch-up feeds files in no particular time order, so an
   * insertion-order drain dropped a live session's newest requests while day-old records survived. One
   * pass per batch picks the victims with a heap bounded by the batch size (no full sort), and a live
   * agent's records rank behind everything less protected, however old they are. `pins` are the records
   * the caller just placed: this pass must never undo the very inserts that triggered it.
   */
  function evictRecords(pins: EvictionPin[] = NO_PINS): void {
    const excess = requests.size + tools.size + events.length - MAX_RECORDS;
    if (excess <= 0) return;
    const picks = oldestRecords(Math.max(excess, EVICT_BATCH), pins);
    applyEvictions(picks);
  }

  /** The single pass: offers every record to a heap that keeps only the `batch` best eviction picks. */
  function oldestRecords(batch: number, pins: EvictionPin[]): EvictionCandidate[] {
    const heap: EvictionCandidate[] = [];
    const offer = (candidate: EvictionCandidate): void => {
      if (pinned(pins, candidate)) return;
      const worst = heap[0];
      if (heap.length < batch) {
        heapPush(heap, candidate);
      } else if (worst !== undefined && !outlives(candidate, worst)) {
        heapPop(heap);
        heapPush(heap, candidate);
      }
    };
    for (const [id, record] of requests) {
      offer({ rank: rankOf(record.sessionId, record.agentId), ts: record.ts, source: 0, id });
    }
    for (const [id, record] of tools) {
      offer({ rank: rankOf(record.sessionId, record.agentId), ts: record.startedAt, source: 1, id });
    }
    for (const record of events) {
      offer({
        rank: rankOf(record.sessionId, record.agentId),
        ts: record.ts,
        source: 2,
        id: String(record.seq),
      });
    }
    return heap;
  }

  /** Is the candidate one of the records this pass must never undo the insertion of? */
  function pinned(pins: EvictionPin[], candidate: EvictionCandidate): boolean {
    return pins.some((pin) => pin.source === candidate.source && pin.id === candidate.id);
  }

  /** Deletes the picked records from where they live; the events array compacts in place, once. */
  function applyEvictions(picks: EvictionCandidate[]): void {
    let eventsGone = false;
    for (const pick of picks) {
      if (pick.source === 0) requests.delete(pick.id);
      else if (pick.source === 1) tools.delete(pick.id);
      else eventsGone = true;
    }
    if (eventsGone) {
      const gone = new Set(picks.filter((pick) => pick.source === 2).map((pick) => pick.id));
      compactEvents(gone);
    }
  }

  /** Drops the evicted events where they stand, keeping the array's order for the rest. */
  function compactEvents(gone: Set<string>): void {
    let write = 0;
    for (const event of events) {
      if (gone.has(String(event.seq))) continue;
      events[write] = event;
      write += 1;
    }
    events.length = write;
  }

  function notify(change: Change): void {
    ver += 1;
    cache = null;
    views = null;
    order = null;
    listCache.current = null;
    summaryCache.current = null;
    modelsCache.current = null;
    for (const listener of listeners) listener(change);
  }

  /**
   * The cached whole-store answer, rebuilt when it does not match the version in hand. A version bump
   * alone is not fresh enough to reuse: `now` enters the views (a live session's activity window), so
   * an answer also expires by age — one build answers a burst of reads, a stale one is never served.
   */
  const DERIVED_TTL_MS = 1_000;

  function cached<T>(slot: { current: Cached<T> | null }, build: () => T): T {
    const held = slot.current;
    if (held !== null && held.version === ver && Date.now() - held.at < DERIVED_TTL_MS) return held.value;
    const value = build();
    slot.current = { version: ver, at: Date.now(), value };
    return value;
  }

  /** Every request and every tool call, newest first, one sort per version. */
  function newestFirst(): { requests: RequestRecord[]; tools: ToolCallRecord[] } {
    if (order !== null && order.version === ver) return order;
    order = {
      version: ver,
      requests: [...requests.values()].sort((a, b) => b.ts - a.ts),
      tools: [...tools.values()].sort((a, b) => b.startedAt - a.startedAt),
    };
    return order;
  }

  function markSessionLive(sessionId: string, ts: number): void {
    const state = session(sessionId);
    state.live = true;
    state.endedAt = null;
    if (state.startedAt === null || ts < state.startedAt) state.startedAt = ts;
    agent(sessionId, "main").live = true;
  }

  function markSessionEnded(sessionId: string, ts: number): void {
    const state = session(sessionId);
    state.live = false;
    state.endedAt = ts;
    for (const value of state.agents.values()) value.live = false;
  }

  function markSubagentLive(line: SpoolLine, ts: number, sessionId: string, agentId: string): void {
    const target = agent(sessionId, agentId);
    target.live = true;
    target.startedAt = ts;
    if (typeof line.agent_type === "string") target.name = line.agent_type;
    if (typeof line.prompt === "string") target.title = promptTitle(line.prompt);
  }

  function markSubagentEnded(sessionId: string, agentId: string, ts: number): void {
    const target = agent(sessionId, agentId);
    target.live = false;
    target.endedAt = ts;
  }

  /** Session and agent lifecycle from one spool line; needs the session/agent closures. */
  function applyLifecycle(
    line: SpoolLine,
    ts: number,
    sessionId: string | null,
    agentId: string | null,
  ): void {
    if (sessionId === null) return;
    switch (line.event) {
      case "SessionStart":
        markSessionLive(sessionId, ts);
        break;
      case "SessionEnd":
        markSessionEnded(sessionId, ts);
        break;
      case "SubagentStart":
        if (agentId !== null) markSubagentLive(line, ts, sessionId, agentId);
        break;
      case "SubagentStop":
        if (agentId !== null) markSubagentEnded(sessionId, agentId, ts);
        break;
      default:
        break;
    }
  }

  /**
   * Claude Code's own registry decides which main sessions are live, and what they are doing. A session
   * absent from it has ended — ended at its last activity, no SessionEnd hook required. A live session
   * ingest has not discovered yet (an idle one from days ago, outside the since window) is created right
   * here, so the registry's word is enough to be listed. Subagents are live while their parent is and
   * their last request — or their start — is under five minutes old; jobs keep the state their
   * own files give them. Jobs and the unattached pseudo session are never touched. One notification,
   * only when something actually moved.
   */
  function applyRegistry(entries: RegistrySession[], now: number): void {
    const live = new Map(entries.map((entry) => [entry.sessionId, entry] as const));
    const touched = new Set<string>();
    for (const state of sessions.values()) {
      if (state.external || state.id === OUTSIDE_SESSION) continue;
      applyRegistryEntry(state, live.get(state.id), touched);
    }
    createUnlisted(entries, touched);
    recomputeSubagents(touched, now);
    if (touched.size > 0)
      notify({ sessions: true, touched: [...touched], requests: [], events: [], tools: [], content: [] });
  }

  /** A registry entry with no session of its own yet: the registry's word creates it, live at once. */
  function createUnlisted(entries: RegistrySession[], touched: Set<string>): void {
    for (const entry of entries) {
      if (entry.sessionId === OUTSIDE_SESSION || sessions.has(entry.sessionId)) continue;
      applyRegistryEntry(session(entry.sessionId), entry, touched);
    }
  }

  /** One session against the registry: listed means live (with its state and name), absent means ended. */
  function applyRegistryEntry(
    state: SessionState,
    entry: RegistrySession | undefined,
    touched: Set<string>,
  ): void {
    if (entry === undefined) {
      endUnlisted(state, touched);
      return;
    }
    if (!state.live) {
      state.live = true;
      state.endedAt = null;
      agent(state.id, "main").live = true;
      touched.add(state.id);
    }
    applyRegistryOrigin(state, entry, touched);
    applyRegistryFacts(state, entry, touched);
  }

  /** Where and when the registry says the session runs; a transcript's own facts still win or keep.
   *  The start it names is the display truth while it lists the session: a transcript's earliest entry
   *  can reach back through resumes and read days older than the session actually open. */
  function applyRegistryOrigin(state: SessionState, entry: RegistrySession, touched: Set<string>): void {
    if (entry.cwd !== null && state.cwd === null) {
      state.cwd = entry.cwd;
      touched.add(state.id);
    }
    if (entry.startedAt !== state.registryStartedAt) {
      state.registryStartedAt = entry.startedAt;
      touched.add(state.id);
    }
    earlierStarted(state, entry.startedAt ?? undefined);
  }

  /** A session the registry no longer lists has ended at its last activity, hook or no hook. */
  function endUnlisted(state: SessionState, touched: Set<string>): void {
    if (!state.live) return;
    state.live = false;
    state.status = null;
    if (state.endedAt === null) state.endedAt = state.lastAt;
    agent(state.id, "main").live = false;
    touched.add(state.id);
  }

  /** The registry's busy/idle state and its names, applied when they differ from what is stored: a
   *  user-set name stands above everything radar could derive, a derived one only above the repo. */
  function applyRegistryFacts(state: SessionState, entry: RegistrySession, touched: Set<string>): void {
    const status = registryStatusOf(entry.status);
    if (status !== state.status) {
      state.status = status;
      touched.add(state.id);
    }
    const userName = entry.nameSource === "user" ? entry.name : null;
    if (userName !== state.registryName) {
      state.registryName = userName;
      touched.add(state.id);
    }
    const derived = entry.nameSource === "user" ? null : entry.name;
    if (derived !== state.registryDerivedName) {
      state.registryDerivedName = derived;
      touched.add(state.id);
    }
  }

  /** Subagent liveness after the registry pass: a live parent and work (or a start) under five minutes. */
  function recomputeSubagents(touched: Set<string>, now: number): void {
    const proj = projection();
    for (const state of sessions.values()) {
      if (state.external || state.id === OUTSIDE_SESSION) continue;
      recomputeSubagentsOf(state, proj.get(state.id), touched, now);
    }
  }

  /** One subagent against the clock: no recorded end, and work — or the start, before the first
   *  request arrived — under five minutes old. Most subagents never record an end, so recency is the
   *  whole test; an explicit end is never undone. */
  function subagentLive(agentState: AgentState, slice: SessionSlice | undefined, now: number): boolean {
    if (agentState.endedAt !== null) return false;
    const lastRequest = slice?.byAgent.get(agentState.id)?.lastTs ?? 0;
    const last = lastRequest > 0 ? lastRequest : (agentState.startedAt ?? 0);
    return now - last < SUBAGENT_LIVE_MS;
  }

  /** The one liveness rule, in one place, that every view reads through the stored flags: a subagent
   *  is live while its parent session is live and its last request — or its start — is under five
   *  minutes old; main and job agents keep the state their sources gave them. `recomputeSubagents`
   *  applies it on the registry's cadence and stores the word, so the list and the session views —
   *  built from the same flags at the same version — can never tell the reader two different things. */
  function agentLiveOf(
    agentState: AgentState,
    slice: SessionSlice | undefined,
    sessionLive: boolean,
    now: number,
  ): boolean {
    if (agentState.kind !== "subagent") return agentState.live;
    return sessionLive && subagentLive(agentState, slice, now);
  }

  /** One session's subagents against the one rule, moving only the ones whose state changed. */
  function recomputeSubagentsOf(
    state: SessionState,
    slice: SessionSlice | undefined,
    touched: Set<string>,
    now: number,
  ): void {
    for (const agentState of state.agents.values()) {
      if (agentState.kind !== "subagent") continue;
      const isLive = agentLiveOf(agentState, slice, state.live, now);
      if (isLive === agentState.live) continue;
      agentState.live = isLive;
      touched.add(state.id);
    }
  }

  /** Calls one source saw and the other has not yet, by session and model, waiting for their pair. */
  const lonelyRoutes = new Map<string, Map<string, string>>();
  const lonelyTranscripts = new Map<string, Set<string>>();
  /** A transcript request id stored under its router twin's id. A copy lands within moments of its
   *  route line, so a window this wide never misses one; dropping the oldest keeps the map flat. */
  const ALIASES_CAP = 512;
  const aliases = new Map<string, string>();
  /** Records whose tokens are the route line's own final usage: a later transcript copy of the same
   *  call only repeats what the (possibly rewritten) stream opened with, so it never downgrades them. */
  const routeTokenIds = new Set<string>();
  const pairKey = (r: RequestRecord): string => `${r.sessionId}\u0000${r.model}`;
  /** A key's waiting entries against the call arriving now, so the scan below walks candidates that
   *  can still pair, and the maps never hold a session's whole unpaired past. */
  const prune = (waiting: Set<string> | Map<string, string>, atTs: number): void =>
    pruneWaiting(waiting, atTs, (id) => requests.get(id));

  /** Store one request, folding it into the record of the same call when one is held. Returns what is stored. */
  function placeRequest(record: RequestRecord): RequestRecord {
    const id = aliases.get(record.id) ?? record.id;
    const existing = requests.get(id);
    let stored: RequestRecord;
    if (existing !== undefined) {
      stored = refresh(existing, record);
      if (routeTokenIds.has(stored.id) && !fromRouter(record) && totalTokens(existing.tokens) > 0) {
        stored = { ...stored, tokens: existing.tokens };
      }
    } else if (fromRouter(record)) stored = placeRoute(record);
    else stored = fillUpstream(placeTranscript(record));
    requests.set(stored.id, stored);
    return stored;
  }

  /** The held record among `ids` that `distance` scores closest, or null when none can be the same call. */
  function closest(
    ids: Iterable<string>,
    distance: (candidate: RequestRecord, id: string) => number | null,
  ): RequestRecord | null {
    let best: RequestRecord | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const candidate = requests.get(id);
      const apart = candidate === undefined ? null : distance(candidate, id);
      if (candidate !== undefined && apart !== null && apart < bestDistance) {
        best = candidate;
        bestDistance = apart;
      }
    }
    return best;
  }

  /** A spool line: join the closest transcript copy, else stand alone (under the main agent when untagged). */
  function placeRoute(route: RequestRecord): RequestRecord {
    const key = pairKey(route);
    const waiting = lonelyTranscripts.get(key) ?? new Set<string>();
    prune(waiting, route.ts);
    const best = closest(waiting, (candidate) => matchDistance(candidate, route, route.agentId));
    if (best !== null) {
      waiting.delete(best.id);
      if (totalTokens(route.tokens) > 0) routeTokenIds.add(best.id);
      return combine(best, route, best.id);
    }
    const routes = lonelyRoutes.get(key) ?? new Map<string, string>();
    prune(routes, route.ts);
    routes.set(route.id, route.agentId);
    lonelyRoutes.set(key, routes);
    return route.agentId === "" ? { ...route, agentId: "main" } : route;
  }

  /** A transcript copy stored under its router twin's id, oldest alias out once the window overflows. */
  function rememberAlias(copyId: string, heldId: string): void {
    aliases.set(copyId, heldId);
    if (aliases.size <= ALIASES_CAP) return;
    const oldest = aliases.keys().next();
    if (!oldest.done) aliases.delete(oldest.value);
  }

  /** A call with no twin in reach waits under its key, pruned against the call arriving now. */
  function waitTranscript(key: string, transcript: RequestRecord): RequestRecord {
    const transcripts = lonelyTranscripts.get(key) ?? new Set<string>();
    prune(transcripts, transcript.ts);
    transcripts.add(transcript.id);
    lonelyTranscripts.set(key, transcripts);
    return transcript;
  }

  /** A transcript call: join the closest waiting spool line, else wait for one. */
  function placeTranscript(transcript: RequestRecord): RequestRecord {
    const key = pairKey(transcript);
    const waiting = lonelyRoutes.get(key) ?? new Map<string, string>();
    prune(waiting, transcript.ts);
    const best = closest(waiting.keys(), (candidate, id) =>
      matchDistance(transcript, candidate, waiting.get(id) ?? ""),
    );
    if (best === null) return waitTranscript(key, transcript);
    waiting.delete(best.id);
    rememberAlias(transcript.id, best.id);
    if (totalTokens(best.tokens) > 0) routeTokenIds.add(best.id);
    return combine(transcript, best, best.id);
  }

  const allRequests = (): RequestRecord[] => [...requests.values()];
  const allTools = (): ToolCallRecord[] => [...tools.values()];

  function buildAgentView(sessionId: string, agentState: AgentState, slice: SessionSlice): AgentView {
    const mine = slice.byAgent.get(agentState.id) ?? EMPTY_AGENT_SLICE;
    const lastRequest = mine.lastRequest;
    const latencies = mine.requests
      .map((request) => request.latencyMs)
      .filter((v): v is number => v !== null);
    return {
      id: agentState.id,
      sessionId,
      parentId: agentState.parentId,
      kind: agentState.kind,
      name: agentNameOf(agentState),
      agentType: agentState.agentType,
      description: agentState.description,
      model: lastRequest?.model ?? agentState.model,
      requests: mine.requests.length,
      errors: mine.failed + noticesOf(sessionId, agentState.id),
      tools: mine.tools.length,
      tokens: mine.tokens,
      costUsd: costOfAll(mine.requests),
      live: agentState.live,
      lastAt: mine.lastTs > 0 ? mine.lastTs : (agentState.startedAt ?? agentState.endedAt ?? null),
      latencyP95: latencies.length < MIN_P95_SAMPLES ? null : percentile(latencies, 95),
    };
  }

  function buildSessionView(state: SessionState, proj: Projection): SessionView {
    const slice = proj.get(state.id) ?? EMPTY_SLICE;
    const agents = [...state.agents.values()].map((agentState) =>
      buildAgentView(state.id, agentState, slice),
    );
    agents.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    const lastRequest = slice.requests.at(-1);
    // The session runs what its main agent runs (a job's own agent when the session is a job): naming it
    // after the newest request from any agent would show an Opus session as its GLM subagent.
    const lead = state.external
      ? agents.find((agent) => agent.kind === "external")
      : agents.find((agent) => agent.id === "main");
    return {
      id: state.id,
      cwd: state.cwd,
      project: projectOf(state.cwd),
      name: viewName(state, state.repo ?? repoFor(state.cwd)),
      branch: state.branch,
      repo: state.repo ?? repoFor(state.cwd),
      parentSessionId: state.parentSessionId,
      // a session the registry lists (or listed) starts when the registry says it does: the records'
      // own earliest timestamp can reach back through resumes, past the session actually open
      startedAt: state.registryStartedAt ?? state.startedAt,
      endedAt: viewEndedAt(state),
      live: state.live,
      status: state.live ? state.status : null,
      activity: activityOf(
        slice.requests.map((request) => ({ ts: request.ts, model: request.model })),
        { live: state.live, start: state.startedAt, last: state.lastAt, now: Date.now() },
      ),
      model: lead?.model ?? state.model ?? lastRequest?.model ?? null,
      upstream: state.upstream ?? lastRequest?.upstream ?? "",
      ccVersion: state.ccVersion,
      requestCount: slice.requests.length,
      errorCount: slice.failed + noticesOf(state.id),
      toolCount: slice.tools.length,
      tokens: slice.tokens,
      agents,
      liveAgentCount: agents.reduce((sum, agent) => sum + (agent.live ? 1 : 0), 0),
      external: state.external,
    };
  }

  /** Built views live until the version moves: repeated reads within one version share one object. */
  function sessionView(state: SessionState): SessionView {
    if (views === null || views.version !== ver) views = { version: ver, bySession: new Map() };
    const cached = views.bySession.get(state.id);
    if (cached !== undefined) return cached;
    const view = buildSessionView(state, projection());
    views.bySession.set(state.id, view);
    return view;
  }

  /** Session-scoped facts a spool line can fill in once (first writer wins, later lines keep it). */
  function applyLineMeta(state: SessionState, line: SpoolLine): void {
    if (typeof line.cwd === "string" && state.cwd === null) state.cwd = line.cwd;
    if (typeof line.base_url === "string" && state.upstream === null) state.upstream = line.base_url;
    if (typeof line.cc_version === "string" && state.ccVersion === null) state.ccVersion = line.cc_version;
    if (typeof line.model_env?.ANTHROPIC_MODEL === "string" && state.model === null) {
      state.model = line.model_env.ANTHROPIC_MODEL;
    }
  }

  const store: Store = {
    addSpoolLine(line) {
      const ts = tsToMs(line.ts) ?? Date.now();
      const sessionId = typeof line.session_id === "string" ? line.session_id : null;
      const agentId = typeof line.agent_id === "string" ? line.agent_id : null;
      const change: Change = {
        sessions: false,
        touched: [],
        requests: [],
        events: [],
        tools: [],
        content: [],
      };
      if (sessionId !== null) {
        touch(sessionId, ts);
        applyLineMeta(session(sessionId), line);
        if (line.event === NOTICE_EVENT) countNotice(sessionId, agentId);
        change.sessions = true;
        change.touched.push(sessionId);
      }
      applyLifecycle(line, ts, sessionId, agentId);
      applyToolEvent(line, ts, sessionId, agentId, pendingToolStarts, tools, change);
      seq += 1;
      const record: EventRecord = {
        seq,
        ts,
        kind: line.event,
        sessionId,
        agentId,
        label: labelFor(line),
        payload: line,
      };
      events.push(record);
      change.events.push(record);
      evictSessions();
      evictRecords([
        { source: 2, id: String(record.seq) },
        ...change.tools.map((tool) => ({ source: 1 as const, id: tool.id })),
      ]);
      notify(change);
    },

    addRequest(record, content) {
      const merged = placeRequest(record);
      touch(merged.sessionId, merged.ts);
      const agentState = agent(merged.sessionId, merged.agentId);
      if (agentState.model === null) agentState.model = merged.model;
      evictRecords([{ source: 0, id: merged.id }]);
      notify({
        sessions: true,
        touched: [merged.sessionId],
        requests: [merged],
        events: [],
        tools: [],
        content: content === undefined ? [] : [{ requestId: merged.id, ...content }],
      });
    },

    addCapture(record) {
      notify({
        sessions: false,
        touched: [],
        requests: [],
        events: [],
        tools: [],
        content: [],
        captures: [record],
      });
    },

    addToolCall(record) {
      const existing = tools.get(record.id);
      const merged: ToolCallRecord = existing
        ? { ...existing, durationMs: record.durationMs ?? existing.durationMs, ok: record.ok || existing.ok }
        : record;
      tools.set(record.id, merged);
      touch(merged.sessionId, merged.startedAt);
      evictRecords([{ source: 1, id: merged.id }]);
      notify({
        sessions: true,
        touched: [merged.sessionId],
        requests: [],
        events: [],
        tools: [merged],
        content: [],
      });
    },

    upsertSession(input) {
      applySessionUpsert(session(input.id), input);
      agent(input.id, "main");
      evictSessions();
      notify({ sessions: true, touched: [input.id], requests: [], events: [], tools: [], content: [] });
    },

    endSession(id, endedAt) {
      markSessionEnded(id, endedAt);
      notify({ sessions: true, touched: [id], requests: [], events: [], tools: [], content: [] });
    },

    applyRegistry(entries, now) {
      applyRegistry(entries, now);
    },

    upsertAgent(input) {
      agent(input.sessionId, "main");
      applyAgentUpsert(agent(input.sessionId, input.id), input);
      notify({
        sessions: true,
        touched: [input.sessionId],
        requests: [],
        events: [],
        tools: [],
        content: [],
      });
    },

    endAgent(sessionId, agentId, endedAt) {
      const target = agent(sessionId, agentId);
      target.live = false;
      target.endedAt = endedAt;
      notify({ sessions: true, touched: [sessionId], requests: [], events: [], tools: [], content: [] });
    },

    summary() {
      return cached(summaryCache, () => {
        const viewList = [...sessions.values()].map((state) => sessionView(state));
        const summary = summarize(viewList, allRequests(), allTools(), Date.now());
        for (const id of sessions.keys()) summary.errors += noticesOf(id);
        return summary;
      });
    },

    sessionList() {
      return cached(listCache, () => {
        const proj = projection();
        return [...sessions.values()]
          .map((state) => {
            const view = sessionView(state);
            const title = [...state.agents.values()].find((a) => a.title !== null)?.title ?? null;
            const mine = proj.get(state.id)?.requests ?? [];
            const item: SessionListItem = {
              id: view.id,
              project: view.project,
              cwd: view.cwd,
              name: view.name,
              branch: view.branch,
              repo: view.repo,
              parentSessionId: view.parentSessionId,
              startedAt: view.startedAt,
              endedAt: view.endedAt,
              live: view.live,
              status: view.status,
              activity: view.activity,
              model: view.model,
              agentCount: view.agents.length,
              liveAgentCount: view.liveAgentCount,
              requestCount: view.requestCount,
              tokens: totalTokens(view.tokens),
              lastAt: state.lastAt,
              external: view.external,
              title,
              costUsd: costOfAll(mine),
              costSplitUsd: costByFamily(mine),
              ...cardPresence(mine, view.live),
            };
            return item;
          })
          .sort((a, b) => b.lastAt - a.lastAt);
      });
    },

    sessionCount() {
      return sessions.size;
    },

    sessionDetail(id) {
      const state = sessions.get(id);
      return state === undefined ? null : sessionView(state);
    },

    /** The newest `limit` records matching the filter, walked off the cached newest-first order: no
     *  per-call sort, no full copy — the walk stops once the page is full. */
    requests(filter) {
      const limit = filter.limit ?? 200;
      const match = matches(filter);
      return newestPage(newestFirst().requests, limit, match);
    },

    requestsFor(filter) {
      return allRequests().filter(matches(filter));
    },

    /** The newest `limit` events matching the filter: the last page of the append-only log, newest
     *  (last-written) first, walked backwards so no filter copy of the whole log is made. */
    events(filter) {
      return lastPage(events, filter.limit ?? 200, (event) => eventKeeps(filter, event));
    },

    tools(filter) {
      return newestPage(newestFirst().tools, filter.limit ?? 200, (tool) => toolKeeps(filter, tool));
    },

    models(scope) {
      const unscoped =
        scope === undefined ||
        (scope.from === undefined && scope.to === undefined && scope.sessions === undefined);
      if (unscoped) {
        return cached(modelsCache, () => ({
          models: modelRows(allRequests()),
          upstreams: upstreamRows(allRequests()),
          tools: toolCounts(allTools()),
        }));
      }
      // a scoped answer is bespoke to the ask, so it builds fresh: the requests inside the window and
      // the sessions named, the tool counts staying the store-wide ones the tools tab shows
      const requests = allRequests().filter(
        (r) =>
          (scope.from === undefined || r.ts >= scope.from) &&
          (scope.to === undefined || r.ts <= scope.to) &&
          (scope.sessions === undefined || scope.sessions.includes(r.sessionId)),
      );
      return {
        models: modelRows(requests),
        upstreams: upstreamRows(requests),
        tools: toolCounts(allTools()),
      };
    },

    addApiError(record) {
      apiErrors.push(record);
      if (apiErrors.length > MAX_SIDE_RECORDS) apiErrors.splice(0, apiErrors.length - MAX_SIDE_RECORDS);
      ver += 1;
    },

    addRouterEvent(record) {
      routerEvents.push(record);
      if (routerEvents.length > MAX_SIDE_RECORDS) {
        routerEvents.splice(0, routerEvents.length - MAX_SIDE_RECORDS);
      }
      ver += 1;
    },

    apiErrors() {
      return [...apiErrors];
    },

    routerEvents() {
      return [...routerEvents];
    },

    raw() {
      return { requests: allRequests(), tools: allTools(), events: [...events] };
    },

    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    version() {
      return ver;
    },
  };

  return store;
}

function matches(filter: RequestFilter): (r: RequestRecord) => boolean {
  return (r) =>
    (filter.session === undefined || r.sessionId === filter.session) &&
    (filter.agent === undefined || r.agentId === filter.agent) &&
    (filter.model === undefined || r.model === filter.model) &&
    (filter.since === undefined || r.ts >= filter.since);
}

/** The first `limit` of a newest-first source that `keep` admits — the whole page without a full copy. */
function newestPage<T>(source: T[], limit: number, keep: (item: T) => boolean): T[] {
  const out: T[] = [];
  for (const item of source) {
    if (!keep(item)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** The last `limit` of an append-ordered source that `keep` admits, last-written first. */
function lastPage<T>(source: T[], limit: number, keep: (item: T) => boolean): T[] {
  const out: T[] = [];
  for (let at = source.length - 1; at >= 0 && out.length < limit; at -= 1) {
    const item = source[at];
    if (item !== undefined && keep(item)) out.push(item);
  }
  return out;
}

function eventKeeps(filter: { session?: string; since?: number }, event: EventRecord): boolean {
  if (filter.session !== undefined && event.sessionId !== filter.session) return false;
  return filter.since === undefined || event.ts >= filter.since;
}

function toolKeeps(filter: { session?: string; failed?: boolean }, tool: ToolCallRecord): boolean {
  if (filter.session !== undefined && tool.sessionId !== filter.session) return false;
  return filter.failed !== true || !tool.ok;
}

/** Tool pairing across spool lines: PreToolUse seeds a start, the completion events close it. */
function applyToolEvent(
  line: SpoolLine,
  ts: number,
  sessionId: string | null,
  agentId: string | null,
  pendingToolStarts: Map<string, number>,
  tools: Map<string, ToolCallRecord>,
  change: Change,
): void {
  if (line.event !== "PreToolUse" && line.event !== "PostToolUse" && line.event !== "PostToolUseFailure")
    return;
  if (sessionId === null) return;
  const name = typeof line.tool_name === "string" ? line.tool_name : "unknown";
  const fallbackId = `hook:${sessionId}:${name}:${ts}`;
  const toolUseId = typeof line.tool_use_id === "string" ? line.tool_use_id : fallbackId;
  if (line.event === "PreToolUse") {
    pendingToolStarts.set(toolUseId, ts);
    return;
  }
  const startedAt = pendingToolStarts.get(toolUseId) ?? ts;
  pendingToolStarts.delete(toolUseId);
  const existing = tools.get(toolUseId);
  const record: ToolCallRecord = {
    id: toolUseId,
    sessionId,
    agentId,
    name,
    startedAt,
    durationMs: existing?.durationMs ?? (startedAt < ts ? ts - startedAt : null),
    ok: line.event === "PostToolUse",
  };
  tools.set(toolUseId, record);
  change.tools.push(record);
}

/** The first key holding a string (empty strings count), else undefined. */
function stringAt(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** "Read /a/b.ts": the tool plus the most telling string of its input. */
function toolLabel(name: string, input: unknown): string {
  const hint =
    typeof input === "object" && input !== null
      ? firstStringOf(input as Record<string, unknown>, [
          "file_path",
          "path",
          "command",
          "pattern",
          "url",
          "description",
        ])
      : undefined;
  return hint === undefined ? name : `${name} ${hint.slice(0, 90)}`;
}

/** One-line label for the timeline: what a hook event was about, without dumping its payload. */
function labelFor(line: SpoolLine): string | null {
  const text = stringAt(line, ["prompt", "message"]);
  if (text !== undefined) return text.slice(0, 120);
  if (typeof line.model === "string" && typeof line.upstream === "string") {
    return `${line.model} → ${line.upstream}`;
  }
  if (typeof line.tool_name === "string") return toolLabel(line.tool_name, line.tool_input);
  return stringAt(line, ["agent_type", "reason", "trigger", "source"]) ?? null;
}

function firstStringOf(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}
