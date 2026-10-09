/**
 * Client-side state: one plain object, updated immutably by messages off the wire (snapshot first, then the
 * stream). Type imports are erased at build time, so the browser bundle shares the server's record shapes
 * without pulling any of its code. Accumulations are capped so a days-long tab stays flat.
 */

import type { Alert } from "../alerts/engine.ts";
import type { Budget, BudgetStatus } from "../budget/budgets.ts";
import type { AdvisorReport } from "../cost/advisor.ts";
import type { AttributionNode, AttributionRange, AttributionRow } from "../cost/attribution.ts";
import * as prices from "../cost/prices.ts";
import type { FlowSeries, RootSummary, TreeNodeRow } from "../history/history.ts";
import type { RouterHealth } from "../router/health.ts";
import type { Settings } from "../server/settings.ts";
import type {
  AgentView,
  EventRecord,
  ModelRow,
  RequestRecord,
  SessionView,
  Summary,
  ToolCallRecord,
  UpstreamRow,
} from "../shared/model.ts";
import { providerOf } from "../shared/provider.ts";
import { DEFAULT_RANGE, rangeToHash, resolveRange, type TimeRange } from "../shared/time-range.ts";

import type { SessionListItem } from "../store/store.ts";
import { httpStatusOf } from "./app/inspector/util.ts";
import type { IconName } from "./icons.ts";

export type Tab =
  | "overview"
  | "agents"
  | "requests"
  | "tools"
  | "timeline"
  | "models"
  | "costs"
  | "alerts"
  | "router"
  | "settings";

/** The scope header's tabs in display order, each with its icon. */
export const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "requests", label: "Requests", icon: "arrows" },
  { id: "tools", label: "Tools", icon: "wrench" },
  { id: "timeline", label: "Timeline", icon: "clock" },
  { id: "models", label: "Models", icon: "cpu" },
  { id: "costs", label: "Costs", icon: "coins" },
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "router", label: "Router", icon: "route" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export type AttributionSortKey =
  | "label"
  | "requests"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "cost";

/** The budget being added or edited in settings; `id` null means a new one. */
export type BudgetDraft = {
  id: string | null;
  scope: string;
  period: Budget["period"];
  limit: string;
  action: Budget["action"];
};

/** The reader's theme choice; "system" follows prefers-color-scheme. */
export type ThemePref = "system" | "light" | "dark";

/** How times read: "relative" ("3m ago") or "absolute" (the wall clock). */
export type TimeMode = "relative" | "absolute";

type SortDir = "asc" | "desc";
export type RequestSortKey =
  | "time"
  | "agent"
  | "what"
  | "model"
  | "upstream"
  | "status"
  | "latency"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "stop"
  | "cost";
export type ToolSortKey = "time" | "tool" | "session" | "agent" | "duration" | "result";
export type Sort<K extends string> = { key: K; dir: SortDir };

/** The sessions rail's two tabs: today's live sessions and everything the history store kept. */
export type SessionsPanel = "live" | "history";

/** What the right pane narrows to when a history session or one of its agents is picked. */
export type HistoryScope = { rootId: string; nodeId: string | null };

/** A history session card's data: the store's summary with the estimated cost the route rolls in. */
export type HistoryRoot = RootSummary & { costUsd?: number | null };

/** The inspector's tabs: today's summary, the recorded sides, the rebuilt conversation, the raw record. */
export type DrawerTab = "overview" | "input" | "output" | "context" | "raw";

/** The inspector's tabs in display order, each with its label. */
export const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "context", label: "Context" },
  { id: "raw", label: "Raw" },
];

/** One stored side of a request, fetched once and cached: loading, the blocks, or why there is nothing. */
export type ContentState =
  | { status: "loading" }
  | { status: "ready"; input: unknown; output: unknown; bytes: number }
  | { status: "missing" }
  | { status: "off" }
  | { status: "error"; cause?: string };

/** One turn of a rebuilt conversation, as the context route serves it. */
export type ContextMessage = {
  role: "user" | "assistant";
  kind: string;
  requestId: string;
  ts: number;
  bytes: number;
  preview: string;
  /** Wire blocks, shaped loosely the way the stored sides are. */
  blocks: unknown[];
};

/** The rebuilt conversation's header numbers. */
export type ContextTotals = {
  messages: number;
  approxTokens: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  cacheTokens: number;
};

/** A request's rebuilt conversation, fetched once per open of its Context tab and paged backwards. */
export type ContextState =
  | { status: "loading" }
  | {
      status: "ready";
      messages: ContextMessage[];
      totals: ContextTotals;
      note: string | null;
      /** The cursor of the page before this one; null when the conversation is complete. */
      next: string | null;
      /** True while an earlier page is being fetched. */
      loadingOlder: boolean;
    }
  | { status: "missing" }
  | { status: "off" }
  | { status: "error"; cause?: string };

/** The prompt a request carried — its system prompt and tool definitions — as the capture route serves
 *  it, decompressed; missing when the request carried neither or no capture was stored. */
export type CaptureState =
  | { status: "loading" }
  | {
      status: "ready";
      hash: string;
      system: unknown;
      tools: unknown;
      bytes: number;
      headers: Record<string, string> | null;
    }
  | { status: "missing" }
  | { status: "error"; cause?: string };

/** The one tool of a captured prompt, as its wire shape carries it. */
export type CapturedTool = {
  name?: string;
  description?: string;
  input_schema?: unknown;
  [key: string]: unknown;
};

/** An agent's live transcript (the Agents view's slide-over), one at a time: the newest page of its
 *  conversation with the cursor to the page before, refreshed when the stream brings its new work. */
export type AgentTranscriptState =
  | { status: "loading" }
  | {
      status: "ready";
      /** The request the page answers — the agent's newest; a different id arriving means new work. */
      requestId: string;
      messages: ContextMessage[];
      totals: ContextTotals;
      note: string | null;
      /** The cursor of the page before this one; null when the conversation is complete. */
      next: string | null;
      /** True while an earlier page is being fetched. */
      loadingOlder: boolean;
    }
  | { status: "missing" }
  | { status: "off" }
  | { status: "error"; cause?: string };

/** One block of a stored side: the shapes the transcript writer kept (accessed loosely, it is wire data). */
export type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  /** A media block's kind and data size, which the ingest kept instead of the data itself. */
  media_type?: string;
  bytes?: number;
  /** How many bytes of a capped text did not fit at ingest; the UI says the original size with it. */
  truncated?: number;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

/** The models tab's tables as /api/models and the snapshot carry them. */
export type ModelsData = {
  models: ModelRow[];
  upstreams: UpstreamRow[];
  tools: { name: string; count: number; failures: number }[];
};

export type StreamMessage =
  | {
      type: "snapshot";
      summary: Summary;
      sessions: SessionListItem[];
      models: ModelsData;
      catchingUp: boolean;
    }
  | { type: "sessions"; summary: Summary; sessions: SessionListItem[]; models: ModelsData }
  | { type: "ingest"; catchingUp: boolean }
  | { type: "request"; request: RequestRecord }
  | { type: "tool"; tool: ToolCallRecord }
  | { type: "event"; event: EventRecord };

export type ClientState = {
  connected: boolean;
  /** The server is still reading its ingest backlog: the lists on screen fill in as it goes. */
  catchingUp: boolean;
  summary: Summary | null;
  /** The server's own boot time and uptime, from /api/health; null until the first polled answer.
   *  The summary's startedAt names the oldest session, not the process, so it never belongs here. */
  health: { startedAt: number; uptimeMs: number } | null;
  sessions: SessionListItem[];
  models: ModelsData | null;
  /** The /api/models answer for the picked sessions and range, with the scope key it answers (null =
   *  none yet). The snapshot's fleet-wide `models` keeps feeding the tools tab; the models tab reads
   *  this, so its rankings honour the same scope every other view does. */
  modelsScoped: { key: string; data: ModelsData } | null;
  /** Why the last models fetch failed (null = none); the tab says it when it has nothing else to show. */
  modelsError: string | null;
  requests: RequestRecord[];
  tools: ToolCallRecord[];
  events: EventRecord[];
  tab: Tab;
  /** The sessions the reader picked, in pick order; empty = every session is in scope. */
  selected: string[];
  /** DERIVED from `selected`: the one picked session, or null when none or several are picked. The
   *  session-only views (SessionAgentsView, the agent crumb) read this and need nothing else. */
  session: string | null;
  /** The picked agent inside the selected session (null = the whole session); scopes the row tables. */
  agent: string | null;
  /** The agent transcript slide-over's history node (null = closed); the URL hash carries it back. */
  agentNode: string | null;
  /** request id shown in the drawer (null = closed) */
  request: string | null;
  /** The one time range every view reads: a preset ending now, or a custom span. */
  range: TimeRange;
  /** Auto-refresh cadence in ms (0 = off); kept in localStorage, only meaningful while the range is open-ended. */
  refresh: 0 | 5000 | 15000 | 60000;
  /** The /api/history/flow answer the range runs on, with the range key it answers (null = none yet). */
  flow: { key: string; series: FlowSeries } | null;
  /** True while a flow fetch for the current range is in flight. */
  flowLoading: boolean;
  /** Why the last flow fetch failed (null = none); the chart says it when it has nothing else to show. */
  flowError: string | null;
  /** requests table: only this model (null = every model) */
  model: string | null;
  /** tools table: every call, or only the failed ones */
  toolFilter: "all" | "failed";
  theme: ThemePref;
  timeMode: TimeMode;
  requestSort: Sort<RequestSortKey>;
  toolSort: Sort<ToolSortKey>;
  /** collapsed agent-tree keys, by `${sessionId}/${agentId}` (empty agent id = whole session block) */
  collapsed: Set<string>;
  /** session ids whose never-ran subagents (no requests, no tool calls) are shown on the agents tab */
  emptyAgents: Set<string>;
  /** session details fetched on demand for the agents tab, by session id */
  details: Record<string, SessionView>;
  updatedAt: number | null;
  error: string | null;
  /** Active, undismissed alerts (polled from /api/alerts). */
  alerts: Alert[];
  budgetStatus: BudgetStatus | null;
  /** Estimated spend since local midnight, from the usage ledger; null = nothing priced today. */
  spendToday: number | null;
  attributionRange: AttributionRange;
  /** The costs drill-down (repos → sessions → agents → models); null until the first fetch lands. */
  attributionTree: AttributionNode[] | null;
  attributionSort: Sort<AttributionSortKey>;
  /** collapsed costs-tree keys, by `${kind}:${key}` */
  costsCollapsed: Set<string>;
  router: RouterHealth | null;
  advisor: AdvisorReport | null;
  /** Budgets as saved (settings tab); null until fetched. */
  budgets: Budget[] | null;
  /** Provider plugins a budget can be scoped to. */
  providers: string[];
  settings: Settings | null;
  draft: BudgetDraft | null;
  /** A problem saving settings, or a confirmation, shown in the settings tab. */
  formMessage: { tone: "ok" | "err"; text: string } | null;
  /** The sessions rail's tab; kept in the URL hash. */
  sessionsPanel: SessionsPanel;
  /** The live rail's filter text, narrowed over the open cards as it is typed. */
  liveInput: string;
  /** The repo the live rail is narrowed to (null = every repo). */
  liveRepo: string | null;
  /** The history rail's search box as typed; the fetch lags it by the debounce. */
  historyInput: string;
  /** The search text the current history page was fetched with. */
  historyQuery: string;
  /** The repo the history rail is narrowed to (null = every repo); kept in the URL hash. */
  historyRepo: string | null;
  /** The history roots fetched so far, and the cursor of the page after them (null = the end). */
  historyRoots: HistoryRoot[] | null;
  historyNext: number | null;
  /** The `q|repo` the current history page answers; a change refetches from the first page. */
  historyFetched: string | null;
  historyRootsLoading: boolean;
  historyRootsError: string | null;
  /** The repos the history picker offers, most used first. */
  historyRepos: { repo: string; roots: number }[] | null;
  /** Expanded session trees by session or root id (both rails share the toggle). */
  expanded: Set<string>;
  /** History trees fetched on first expand, by root id. */
  historyTrees: Record<string, TreeNodeRow[]>;
  /** Root ids whose tree fetch is in flight. */
  historyTreeLoading: Set<string>;
  /** The picked history session or agent the right pane narrows to; null = all sessions. */
  historyScope: HistoryScope | null;
  /** The scoped history requests (newest first) and the cursor of the page after them. */
  historyRequests: RequestRecord[] | null;
  historyRequestsNext: string | null;
  historyRequestsLoading: boolean;
  historyRequestsError: string | null;
  /** The drawer's tab; reset to overview whenever another request opens. */
  drawerTab: DrawerTab;
  /** Stored request content by id, fetched once per open of its Input or Output tab. */
  content: Record<string, ContentState>;
  /** Rebuilt conversations by id, fetched once per open of the Context tab and paged backwards. */
  context: Record<string, ContextState>;
  /** Captured prompts by request id, fetched once per open of the Context tab beside the conversation. */
  capture: Record<string, CaptureState>;
  /** The open agent transcript, fetched while its slide-over shows and refreshed on its new requests. */
  agentTranscript: AgentTranscriptState | null;
  /** The history store's size and retention (settings tab); null until fetched. */
  historyStats: {
    bytes: number;
    nodes: number;
    requests: number;
    /** Ended sessions history holds — the History tab's badge before the tab is ever opened. */
    roots: number;
    retentionDays: number;
  } | null;
  /** True when the history store answered 503 (history off), so the settings card can say why. */
  historyOff: boolean;
  /** "Clear history" waits for a second click while this is on. */
  clearConfirm: boolean;
};

const MAX_REQUESTS = 2000;
const MAX_TOOLS = 2000;
const MAX_EVENTS = 1000;
/** how many session trees the agents tab shows when no session is selected */
const AGENT_TAB_SESSIONS = 6;

export function initialClientState(): ClientState {
  return {
    connected: false,
    catchingUp: false,
    summary: null,
    health: null,
    sessions: [],
    models: null,
    modelsScoped: null,
    modelsError: null,
    requests: [],
    tools: [],
    events: [],
    tab: "overview",
    selected: [],
    session: null,
    agent: null,
    agentNode: null,
    request: null,
    range: { ...DEFAULT_RANGE },
    refresh: 5000,
    flow: null,
    flowLoading: false,
    flowError: null,
    model: null,
    toolFilter: "all",
    theme: "system",
    timeMode: "relative",
    requestSort: { key: "time", dir: "desc" },
    toolSort: { key: "time", dir: "desc" },
    collapsed: new Set<string>(),
    emptyAgents: new Set<string>(),
    details: {},
    updatedAt: null,
    error: null,
    alerts: [],
    budgetStatus: null,
    spendToday: null,
    attributionRange: "day",
    attributionTree: null,
    attributionSort: { key: "cost", dir: "desc" },
    costsCollapsed: new Set<string>(),
    router: null,
    advisor: null,
    budgets: null,
    providers: [],
    settings: null,
    draft: null,
    formMessage: null,
    sessionsPanel: "live",
    liveInput: "",
    liveRepo: null,
    historyInput: "",
    historyQuery: "",
    historyRepo: null,
    historyRoots: null,
    historyNext: null,
    historyFetched: null,
    historyRootsLoading: false,
    historyRootsError: null,
    historyRepos: null,
    expanded: new Set<string>(),
    historyTrees: {},
    historyTreeLoading: new Set<string>(),
    historyScope: null,
    historyRequests: null,
    historyRequestsNext: null,
    historyRequestsLoading: false,
    historyRequestsError: null,
    drawerTab: "overview",
    content: {},
    context: {},
    capture: {},
    agentTranscript: null,
    historyStats: null,
    historyOff: false,
    clearConfirm: false,
  };
}

function cap<T>(items: T[], limit: number, incoming: T): T[] {
  const next = [...items, incoming];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/* ------------------------- the picked sessions ------------------------- */

/** The session ids in scope, in pick order: the picked set, or — for a hand-built state that only set
 *  the derived field — that one session. Empty = every session. */
export function selectedIds(state: ClientState): string[] {
  if (state.selected.length > 0) return state.selected;
  return state.session === null ? [] : [state.session];
}

/** Fold a pick of session ids into the state: `selected` carries them in order, `session` stays the
 *  one picked session the session-only views read (null when none or several are picked). */
export function withSelection(state: ClientState, ids: string[]): ClientState {
  const selected = [...new Set(ids)].filter((id) => id !== "");
  return { ...state, selected, session: selected.length === 1 ? (selected[0] ?? null) : null };
}

/** Clicking a session card: toggle the id in or out of the picked set. The picked agent and the model
 *  filter reset with the change, as a single pick always did. */
export function toggleSelected(state: ClientState, id: string): ClientState {
  if (id === "") return clearSelected(state);
  const ids = selectedIds(state);
  const next = ids.includes(id) ? ids.filter((picked) => picked !== id) : [...ids, id];
  return { ...withSelection(state, next), agent: null, model: null };
}

/** The "All sessions" card: every session back in scope, the picked agent and the model filter with it. */
export function clearSelected(state: ClientState): ClientState {
  return { ...withSelection(state, []), agent: null, model: null };
}

/** True when `sessionId` is in scope: everything is, or the picked set names it. An unattributed row
 *  (null) only ever shows while every session is in scope, as a single-pick filter did. */
function inScope(state: ClientState, sessionId: string | null): boolean {
  const ids = selectedIds(state);
  if (ids.length === 0) return true;
  return sessionId !== null && ids.includes(sessionId);
}

/** The picked sessions as list items, in pick order; empty when the reader sees every session. */
export function pickedSessions(state: ClientState): SessionListItem[] {
  return selectedIds(state)
    .map((id) => state.sessions.find((session) => session.id === id))
    .filter((entry) => entry !== undefined);
}

/** Fold one wire message into a new state (input untouched). */
export function applyMessage(state: ClientState, message: StreamMessage): ClientState {
  switch (message.type) {
    case "snapshot":
      return {
        ...state,
        summary: message.summary,
        sessions: message.sessions,
        models: message.models,
        catchingUp: message.catchingUp,
        updatedAt: Date.now(),
        error: null,
      };
    case "ingest":
      return { ...state, catchingUp: message.catchingUp };
    case "sessions":
      return {
        ...state,
        summary: message.summary,
        sessions: message.sessions,
        models: message.models,
        updatedAt: Date.now(),
      };
    case "request":
      return {
        ...state,
        // a request the server merged or refreshed arrives again under its id: the newer copy replaces the older
        requests: cap(
          state.requests.filter((r) => r.id !== message.request.id),
          MAX_REQUESTS,
          message.request,
        ),
        updatedAt: Date.now(),
      };
    case "tool":
      return {
        ...state,
        // a pre/post pair can arrive twice (backfill, then the stream): the newer record replaces the older
        tools: cap(
          state.tools.filter((t) => t.id !== message.tool.id),
          MAX_TOOLS,
          message.tool,
        ),
        updatedAt: Date.now(),
      };
    case "event":
      return { ...state, events: cap(state.events, MAX_EVENTS, message.event), updatedAt: Date.now() };
  }
}

/** Store (or replace) one fetched session detail; the agents tree reads these. */
export function applyDetail(state: ClientState, detail: SessionView): ClientState {
  return { ...state, details: { ...state.details, [detail.id]: detail } };
}

/** Session details worth showing in the agents tab: the picked sessions, else the most recent few. */
export function detailTargets(state: ClientState): SessionListItem[] {
  const ids = selectedIds(state);
  if (ids.length === 0)
    return [...state.sessions].sort((a, b) => b.lastAt - a.lastAt).slice(0, AGENT_TAB_SESSIONS);
  return ids.map((id) => state.sessions.find((s) => s.id === id)).filter((entry) => entry !== undefined);
}

/** Bulk-load the initial request/tool/event pages fetched before the stream attaches. */
export function applyBackfill(
  state: ClientState,
  backfill: { requests?: RequestRecord[]; tools?: ToolCallRecord[]; events?: EventRecord[] },
): ClientState {
  const requests =
    backfill.requests === undefined
      ? state.requests
      : dedupeNewest([...backfill.requests.slice(-MAX_REQUESTS)]);
  const tools =
    backfill.tools === undefined ? state.tools : dedupeTools([...backfill.tools.slice(-MAX_TOOLS)]);
  const events = backfill.events === undefined ? state.events : [...backfill.events.slice(-MAX_EVENTS)];
  return { ...state, requests, tools, events };
}

/** SSE may replay a request the backfill already fetched; ids are unique, last write wins. */
function dedupeNewest(requests: RequestRecord[]): RequestRecord[] {
  const byId = new Map<string, RequestRecord>();
  for (const request of requests) byId.set(request.id, request);
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

/** Tool calls by id, last write wins (a stream message can repeat a backfilled call), oldest first. */
function dedupeTools(tools: ToolCallRecord[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  for (const tool of tools) byId.set(tool.id, tool);
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Requests in the current view: newest first, filtered to the selected session — and, on a session page,
 *  to the picked agent when one is picked. */
export function visibleRequests(state: ClientState): RequestRecord[] {
  const filtered = scopedRequests(state);
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

/** The view's requests narrowed by the picked sessions and the agent the header names. */
function scopedRequests(state: ClientState): RequestRecord[] {
  let filtered = state.requests.filter((r) => inScope(state, r.sessionId));
  if (state.agent !== null) filtered = filtered.filter((r) => r.agentId === state.agent);
  return filtered;
}

/** Text columns start A→Z; numbers and times start biggest/newest first. */
const TEXT_KEYS = new Set<string>([
  "agent",
  "what",
  "model",
  "upstream",
  "stop",
  "tool",
  "session",
  "result",
  "label",
]);

/** Clicking a column: the same column flips direction, a new one starts at its natural direction. */
export function nextSort<K extends string>(current: Sort<K>, key: K): Sort<K> {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: TEXT_KEYS.has(key) ? "asc" : "desc" };
}

type SortValue = string | number | null;

/** Order two present values: numbers numerically, everything else as text. */
function compareValues(a: string | number, b: string | number): number {
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
}

/** Stable sort by one extracted value; missing values (null) always sink to the bottom. */
function sortBy<T>(items: T[], dir: SortDir, pick: (item: T) => SortValue): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const keyed = items.map((item, index) => ({ item, index, value: pick(item) }));
  keyed.sort((a, b) => {
    if (a.value === null && b.value === null) return a.index - b.index;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return sign * compareValues(a.value, b.value) || a.index - b.index;
  });
  return keyed.map((entry) => entry.item);
}

const REQUEST_VALUE: Record<RequestSortKey, (r: RequestRecord) => SortValue> = {
  time: (r) => r.ts,
  agent: (r) => r.agentId,
  what: (r) => r.what ?? null,
  model: (r) => r.model,
  upstream: (r) => r.upstream,
  status: (r) => httpStatusOf(r),
  latency: (r) => r.latencyMs,
  input: (r) => r.tokens.input,
  output: (r) => r.tokens.output,
  cacheRead: (r) => r.tokens.cacheRead,
  cacheWrite: (r) => r.tokens.cacheWrite,
  stop: (r) => r.stopReason,
  cost: (r) => requestCost(r)?.usd ?? null,
};

/** The requests table: the view's requests narrowed to the picked model, in the chosen order. */
export function tableRequests(state: ClientState): RequestRecord[] {
  const requests = visibleRequests(state);
  const narrowed = state.model === null ? requests : requests.filter((r) => r.model === state.model);
  return sortBy(narrowed, state.requestSort.dir, REQUEST_VALUE[state.requestSort.key]);
}

/** Models seen in the current view, most requests first (the requests table's filter choices). */
function modelsInView(state: ClientState): { model: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const request of visibleRequests(state))
    counts.set(request.model, (counts.get(request.model) ?? 0) + 1);
  return [...counts]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

/** How many chips of each kind the requests filter offers. */
const CHIPS_PER_KIND = 4;

/**
 * The model filter chips: the busiest Claude models and the busiest provider models, so a provider model is
 * never crowded out by Claude traffic. Claude Code's own `<synthetic>` messages are not a model.
 */
export function modelChoices(state: ClientState): { model: string; count: number }[] {
  const models = modelsInView(state).filter((m) => m.model !== "" && m.model !== "<synthetic>");
  const claude = models.filter((m) => providerOf(m.model) === "Anthropic").slice(0, CHIPS_PER_KIND);
  const others = models.filter((m) => providerOf(m.model) !== "Anthropic").slice(0, CHIPS_PER_KIND);
  return [...claude, ...others].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

/** The tools table: the view's calls, optionally only the failures, in the chosen order. */
export function tableTools(state: ClientState): ToolCallRecord[] {
  const tools = visibleTools(state);
  const narrowed = state.toolFilter === "failed" ? tools.filter((t) => !t.ok) : tools;
  const projects = new Map(state.sessions.map((s) => [s.id, s.project ?? s.id]));
  const value: Record<ToolSortKey, (t: ToolCallRecord) => SortValue> = {
    time: (t) => t.startedAt,
    tool: (t) => t.name,
    session: (t) => projects.get(t.sessionId) ?? t.sessionId,
    agent: (t) => t.agentId ?? "main",
    duration: (t) => t.durationMs,
    result: (t) => (t.ok ? "succeeded" : "failed"),
  };
  return sortBy(narrowed, state.toolSort.dir, value[state.toolSort.key]);
}

export function visibleEvents(state: ClientState): EventRecord[] {
  let filtered = state.events.filter((e) => inScope(state, e.sessionId));
  // an unattributed event is the session's own, so it stays under any picked agent
  if (state.agent !== null)
    filtered = filtered.filter((e) => e.agentId === null || e.agentId === state.agent);
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

export function visibleTools(state: ClientState): ToolCallRecord[] {
  let filtered = state.tools.filter((t) => inScope(state, t.sessionId));
  // a tool call with no agent id belongs to the main agent
  if (state.agent !== null) filtered = filtered.filter((t) => (t.agentId ?? "main") === state.agent);
  return [...filtered].sort((a, b) => b.startedAt - a.startedAt);
}

export function selectedSession(state: ClientState): SessionListItem | null {
  if (state.session === null) return null;
  return state.sessions.find((s) => s.id === state.session) ?? null;
}

/** The open request's record: the live list, else the scope the row came from — a history page's rows
 *  are not held in memory. Null when the id is in neither, or with nothing open. */
export function drawerRequest(state: ClientState): RequestRecord | null {
  if (state.request === null) return null;
  return (
    state.requests.find((r) => r.id === state.request) ??
    stepScope(state).find((r) => r.id === state.request) ??
    null
  );
}

/**
 * The name a request's agent shows under, from the session's own agents: "Main" for the main agent, a
 * subagent its type and task (its live view, or its history node when the request came from a history
 * scope). Falls back to the raw id when no session detail is held; the id goes in the title attribute.
 */
export function agentDisplayName(state: ClientState, sessionId: string, agentId: string): string {
  if (agentId === "" || agentId === "main") return "Main";
  const live = state.details[sessionId]?.agents.find((agent) => agent.id === agentId);
  if (live !== undefined) return live.name ?? agentId;
  const scope = state.historyScope;
  const node =
    scope === null
      ? undefined
      : state.historyTrees[scope.rootId]?.find(
          (entry) => entry.sessionId === sessionId && entry.agentId === agentId,
        );
  return nodeLabel(node) ?? agentId;
}

/** The longest span the in-memory requests answer before the history route has to take over. */
export const MAX_MEMORY_SPAN = 24 * 3_600_000;

/** The auto-refresh cadences the picker offers, as their wire values. */
export const REFRESH_CHOICES = [0, 5000, 15000, 60000] as const;

/** Two ranges read as the same one: same preset, or the same custom ends. */
export function rangeEqual(a: TimeRange, b: TimeRange): boolean {
  return a.preset === b.preset && a.from === b.from && a.to === b.to;
}

/** The oldest request in memory (null when there is none); the flow reads memory only while it reaches back
 *  far enough. Kept oldest-first by the backfill and the stream, but scanned anyway — one pass over the cap. */
export function oldestRequest(requests: RequestRecord[]): number | null {
  let oldest: number | null = null;
  for (const request of requests) {
    if (oldest === null || request.ts < oldest) oldest = request.ts;
  }
  return oldest;
}

/** The window the token-flow chart draws right now, and where its numbers come from: the requests in memory
 *  while the span is short, open-ended and memory reaches back far enough, else the history route. */
export function flowSource(state: ClientState, now: number): { from: number; to: number; history: boolean } {
  const oldest = oldestRequest(state.requests);
  const resolved = resolveRange(state.range, now, oldest ?? undefined);
  const history =
    state.range.to !== null ||
    resolved.to - resolved.from > MAX_MEMORY_SPAN ||
    (oldest !== null && resolved.from < oldest);
  return { ...resolved, history };
}

/** One request's estimated cost at list price, with the conditions that shaped the sum; null for a request
 *  nothing prices. The same function the server's ledger math runs, on the record the UI already holds. */
export function requestCost(request: RequestRecord): { usd: number; detail: string[] } | null {
  return prices.requestCost(request);
}

/** The models tab's scope as its fetch and its held answer both read it: the range's hash plus the
 *  picked sessions. A preset's key stays put while its window follows the clock, like the flow's. */
export function modelsScopeKey(state: ClientState): string {
  return `${rangeToHash(state.range)}|${selectedIds(state).join(",")}`;
}

/** The query for the models tab's fetch: the resolved window always, the picked sessions joined when
 *  there are any. */
export function modelsQuery(state: ClientState, now: number): string {
  const { from, to } = resolveRange(state.range, now);
  const params = new URLSearchParams({ from: String(from), to: String(to) });
  const ids = selectedIds(state);
  if (ids.length > 0) params.set("session", ids.join(","));
  return params.toString();
}

const ATTRIBUTION_VALUE: Record<AttributionSortKey, (row: AttributionRow) => SortValue> = {
  label: (row) => row.label,
  requests: (row) => row.requests,
  input: (row) => row.tokens.input,
  output: (row) => row.tokens.output,
  cacheRead: (row) => row.tokens.cacheRead,
  cacheWrite: (row) => row.tokens.cacheWrite,
  cost: (row) => row.costUsd,
};

/** The costs tree with every level's siblings in the chosen order (unpriced rows sink when sorting by cost). */
export function sortTree(nodes: AttributionNode[], sort: Sort<AttributionSortKey>): AttributionNode[] {
  return sortBy(nodes, sort.dir, ATTRIBUTION_VALUE[sort.key]).map((node) => ({
    ...node,
    children: sortTree(node.children, sort),
  }));
}

/** A fresh draft: the first provider seen, or total; this month; $10; warn only. */
export function newDraft(providers: string[]): BudgetDraft {
  const first = providers[0];
  return {
    id: null,
    scope: first === undefined ? "total" : `provider:${first}`,
    period: "month",
    limit: "10",
    action: "warn",
  };
}

export function draftOf(budget: Budget): BudgetDraft {
  return {
    id: budget.id,
    scope: budget.scope,
    period: budget.period,
    limit: String(budget.limitUsd),
    action: budget.action,
  };
}

/** The draft as a budget, or a sentence saying what to fix. */
export function budgetFromDraft(draft: BudgetDraft, newId: string): Budget | string {
  const limit = Number(draft.limit.trim().replace(/^\$/, ""));
  if (!Number.isFinite(limit) || limit <= 0) return "Enter a limit above $0, like 25 or 7.50.";
  if (limit > 1_000_000) return "That limit is too large; the most a budget takes is $1,000,000.";
  return {
    id: draft.id ?? newId,
    scope: draft.scope,
    period: draft.period,
    limitUsd: Math.round(limit * 100) / 100,
    action: draft.action,
  };
}

/** The budgets list with the draft saved into it (added, or replacing the one it edits). */
export function withBudget(budgets: Budget[], budget: Budget): Budget[] {
  const index = budgets.findIndex((b) => b.id === budget.id);
  if (index < 0) return [...budgets, budget];
  return budgets.map((b) => (b.id === budget.id ? budget : b));
}

/** Store (or replace) one request's fetched content; the drawer's Input and Output tabs read these. */
export function applyContent(state: ClientState, id: string, content: ContentState): ClientState {
  return { ...state, content: { ...state.content, [id]: content } };
}

/** Store (or replace) one request's rebuilt conversation; the inspector's Context tab reads these. */
export function applyContext(state: ClientState, id: string, context: ContextState): ClientState {
  return { ...state, context: { ...state.context, [id]: context } };
}

/** Store (or replace) one request's captured prompt; the Context tab's top section reads these. */
export function applyCapture(state: ClientState, id: string, capture: CaptureState): ClientState {
  return { ...state, capture: { ...state.capture, [id]: capture } };
}

/** Store (or replace) the open agent's transcript; the slide-over reads this one slot. */
export function applyAgentTranscript(state: ClientState, transcript: AgentTranscriptState): ClientState {
  return { ...state, agentTranscript: transcript };
}

/**
 * The history node an Agents-view row reads its transcript through — the same ids the history writer
 * maps records by (writer.ts's nodeIdOf): a job's own agent on `job:<session>`, every other agent on
 * `<session>/<agentId>`, the main agent's "main" id spelling `<session>/main`.
 */
export function agentNodeId(sessionId: string, agent: Pick<AgentView, "id" | "kind">): string {
  if (agent.kind === "external") return `job:${sessionId}`;
  return `${sessionId}/${agent.id === "" || agent.id === "main" ? "main" : agent.id}`;
}

/**
 * The session and agent a node id carries: `<session>/main`, `<session>/<agentId>` and `job:<session>`
 * — the shapes the writer writes. A job's own agent has no separate agent id ("" = the job itself);
 * anything else reads as unknown.
 */
export function nodeAgentOf(nodeId: string): { sessionId: string; agentId: string } | null {
  if (nodeId.startsWith("job:")) return { sessionId: nodeId.slice(4), agentId: "" };
  const cut = nodeId.lastIndexOf("/");
  if (cut <= 0) return null;
  return { sessionId: nodeId.slice(0, cut), agentId: nodeId.slice(cut + 1) };
}

/**
 * The node a live request lands on, by the same rule the writer maps records by; a session no held
 * detail covers reads as a plain one whose lead is main, which is the writer's own fallback.
 */
export function requestNodeId(state: ClientState, request: RequestRecord): string {
  const detail = state.details[request.sessionId];
  const agentId = request.agentId === "" ? "main" : request.agentId;
  if (detail?.external) {
    const lead = detail.agents.find((agent) => agent.kind === "external")?.id ?? request.sessionId;
    if (agentId === "main" || agentId === lead) return `job:${request.sessionId}`;
  }
  return `${request.sessionId}/${agentId}`;
}

/** The Agents-view row a transcript node answers, from the session's held detail; null until it lands. */
export function transcriptAgentOf(
  state: ClientState,
  nodeId: string,
): { sessionId: string; agent: AgentView } | null {
  const parsed = nodeAgentOf(nodeId);
  if (parsed === null) return null;
  const detail = state.details[parsed.sessionId];
  if (detail === undefined) return null;
  const agent =
    parsed.agentId === ""
      ? detail.agents.find((entry) => entry.kind === "external")
      : detail.agents.find((entry) => entry.id === parsed.agentId);
  return agent === undefined ? null : { sessionId: parsed.sessionId, agent };
}

/** The requests the inspector steps through: the history page in a history scope, else the live table's
 *  order (the reader's own sort), both newest first. */
export function stepScope(state: ClientState): RequestRecord[] {
  return state.historyScope !== null ? (state.historyRequests ?? []) : tableRequests(state);
}

/** The request one step from the open one within the current scope (1 = the row below, older); null at
 *  either end, or with nothing open. */
export function stepRequest(state: ClientState, delta: 1 | -1): string | null {
  if (state.request === null) return null;
  const list = stepScope(state);
  const at = list.findIndex((request) => request.id === state.request);
  if (at < 0) return null;
  return list[at + delta]?.id ?? null;
}

/** The name a history session card shows: its own name, else its label, project or id prefix. */
export function rootName(root: RootSummary | undefined): string | null {
  if (root === undefined) return null;
  return root.name ?? root.label ?? root.project ?? root.id.slice(0, 8);
}

/** The words one tree node shows: Main for the root, else its name, label, description or id. */
export function nodeLabel(node: TreeNodeRow | undefined): string | null {
  if (node === undefined) return null;
  return node.kind === "main" ? "Main" : (node.name ?? node.label ?? node.description ?? node.id);
}

/** Two scopes pick the same tree when both ids match (nodeId null means the whole tree). */
export function scopeEqual(a: HistoryScope | null, b: HistoryScope | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rootId === b.rootId && a.nodeId === b.nodeId;
}

/** What the breadcrumb shows for the picked scope, resolved from the data in hand; ids when it has not arrived. */
export function scopeCrumb(state: ClientState): { root: string; node: string | null } | null {
  const scope = state.historyScope;
  if (scope === null) return null;
  const nodes = state.historyTrees[scope.rootId];
  const main = nodes?.find((node) => node.id === scope.rootId);
  const root =
    rootName(state.historyRoots?.find((entry) => entry.id === scope.rootId)) ??
    nodeLabel(main) ??
    scope.rootId;
  if (scope.nodeId === null) return { root, node: null };
  const node = nodes?.find((entry) => entry.id === scope.nodeId);
  return { root, node: nodeLabel(node) ?? scope.nodeId };
}

/** One stored side as renderable blocks: a JSON array as it stands, plain text as one text block, else none. */
export function blocksOf(side: unknown): ContentBlock[] | null {
  if (Array.isArray(side)) return side.length === 0 ? null : (side as ContentBlock[]);
  if (typeof side === "string" && side !== "") return [{ type: "text", text: side }];
  return null;
}

/** The text of one block, for the copy button and the fold size; wire data, so read it defensively. */
export function blockText(block: ContentBlock): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.thinking === "string") return block.thinking;
  return JSON.stringify(block, null, 2);
}

/** The byte size of one block's text (UTF-8), the way the server counts a side's truncation. */
export function blockBytes(block: ContentBlock): number {
  return new TextEncoder().encode(blockText(block)).length;
}

/** The blocks a tool_result carries: its nested content, its content string, or the text the importer kept. */
export function resultBlocks(block: ContentBlock): ContentBlock[] | null {
  if (Array.isArray(block.content)) return blocksOf(block.content);
  if (typeof block.content === "string" && block.content !== "")
    return [{ type: "text", text: block.content }];
  // the transcript importer flattens a result's text blocks into `text`
  if (typeof block.text === "string" && block.text !== "") return [{ type: "text", text: block.text }];
  return null;
}
