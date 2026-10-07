/**
 * Client-side state: one plain object, updated immutably by messages off the wire (snapshot first, then the
 * stream). Type imports are erased at build time, so the browser bundle shares the server's record shapes
 * without pulling any of its code. Accumulations are capped so a days-long tab stays flat.
 */

import type { Alert } from "../alerts/engine.ts";
import type { Budget, BudgetStatus } from "../budget/budgets.ts";
import type { AdvisorReport } from "../cost/advisor.ts";
import type { AttributionBy, AttributionRange, AttributionRow } from "../cost/attribution.ts";
import { costOf } from "../cost/prices.ts";
import type { RouterHealth } from "../router/health.ts";
import type { Settings } from "../server/settings.ts";
import type {
  EventRecord,
  ModelRow,
  RequestRecord,
  SessionView,
  Summary,
  ToolCallRecord,
  UpstreamRow,
} from "../shared/model.ts";
import type { SessionListItem } from "../store/store.ts";
import type { Range } from "./palette.ts";

export type Tab =
  | "agents"
  | "requests"
  | "tools"
  | "timeline"
  | "models"
  | "costs"
  | "alerts"
  | "router"
  | "settings";

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

export type SortDir = "asc" | "desc";
export type RequestSortKey =
  | "time"
  | "agent"
  | "model"
  | "upstream"
  | "latency"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "stop"
  | "cost";
export type ToolSortKey = "time" | "tool" | "session" | "agent" | "duration" | "result";
export type Sort<K extends string> = { key: K; dir: SortDir };

export type ModelsData = {
  models: ModelRow[];
  upstreams: UpstreamRow[];
  tools: { name: string; count: number; failures: number }[];
};

export type StreamMessage =
  | { type: "snapshot"; summary: Summary; sessions: SessionListItem[]; models: ModelsData }
  | { type: "sessions"; summary: Summary; sessions: SessionListItem[]; models: ModelsData }
  | { type: "request"; request: RequestRecord }
  | { type: "tool"; tool: ToolCallRecord }
  | { type: "event"; event: EventRecord };

export type ClientState = {
  connected: boolean;
  summary: Summary | null;
  sessions: SessionListItem[];
  models: ModelsData | null;
  requests: RequestRecord[];
  tools: ToolCallRecord[];
  events: EventRecord[];
  tab: Tab;
  /** selected session filter (null = all sessions) */
  session: string | null;
  /** request id shown in the drawer (null = closed) */
  request: string | null;
  range: Range;
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
  /** session details fetched on demand for the agents tab, by session id */
  details: Record<string, SessionView>;
  updatedAt: number | null;
  error: string | null;
  /** Active, undismissed alerts (polled from /api/alerts). */
  alerts: Alert[];
  budgetStatus: BudgetStatus | null;
  /** Estimated spend since local midnight, from the usage ledger; null = nothing priced today. */
  spendToday: number | null;
  attributionBy: AttributionBy;
  attributionRange: AttributionRange;
  attribution: AttributionRow[] | null;
  attributionSort: Sort<AttributionSortKey>;
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
};

const MAX_REQUESTS = 2000;
const MAX_TOOLS = 2000;
const MAX_EVENTS = 1000;
/** how many session trees the agents tab shows when no session is selected */
const AGENT_TAB_SESSIONS = 6;

export function initialClientState(): ClientState {
  return {
    connected: false,
    summary: null,
    sessions: [],
    models: null,
    requests: [],
    tools: [],
    events: [],
    tab: "agents",
    session: null,
    request: null,
    range: "1h",
    model: null,
    toolFilter: "all",
    theme: "system",
    timeMode: "relative",
    requestSort: { key: "time", dir: "desc" },
    toolSort: { key: "time", dir: "desc" },
    collapsed: new Set<string>(),
    details: {},
    updatedAt: null,
    error: null,
    alerts: [],
    budgetStatus: null,
    spendToday: null,
    attributionBy: "project",
    attributionRange: "day",
    attribution: null,
    attributionSort: { key: "cost", dir: "desc" },
    router: null,
    advisor: null,
    budgets: null,
    providers: [],
    settings: null,
    draft: null,
    formMessage: null,
  };
}

function cap<T>(items: T[], limit: number, incoming: T): T[] {
  const next = [...items, incoming];
  return next.length > limit ? next.slice(next.length - limit) : next;
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
        updatedAt: Date.now(),
        error: null,
      };
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
        requests: cap(state.requests, MAX_REQUESTS, message.request),
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

/** Session details worth showing in the agents tab: the selected one, else the most recent few. */
export function detailTargets(state: ClientState): SessionListItem[] {
  if (state.session !== null) {
    const item = state.sessions.find((s) => s.id === state.session);
    return item === undefined ? [] : [item];
  }
  return [...state.sessions].sort((a, b) => b.lastAt - a.lastAt).slice(0, AGENT_TAB_SESSIONS);
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
export function dedupeNewest(requests: RequestRecord[]): RequestRecord[] {
  const byId = new Map<string, RequestRecord>();
  for (const request of requests) byId.set(request.id, request);
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

/** Tool calls by id, last write wins (a stream message can repeat a backfilled call), oldest first. */
export function dedupeTools(tools: ToolCallRecord[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  for (const tool of tools) byId.set(tool.id, tool);
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Requests in the current view: newest first, filtered to the selected session when one is picked. */
export function visibleRequests(state: ClientState): RequestRecord[] {
  const filtered =
    state.session === null ? state.requests : state.requests.filter((r) => r.sessionId === state.session);
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

/** Text columns start A→Z; numbers and times start biggest/newest first. */
const TEXT_KEYS = new Set<string>([
  "agent",
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
  model: (r) => r.model,
  upstream: (r) => r.upstream,
  latency: (r) => r.latencyMs,
  input: (r) => r.tokens.input,
  output: (r) => r.tokens.output,
  cacheRead: (r) => r.tokens.cacheRead,
  cacheWrite: (r) => r.tokens.cacheWrite,
  stop: (r) => r.stopReason,
  cost: (r) => requestCost(r),
};

/** The requests table: the view's requests narrowed to the picked model, in the chosen order. */
export function tableRequests(state: ClientState): RequestRecord[] {
  const requests = visibleRequests(state);
  const narrowed = state.model === null ? requests : requests.filter((r) => r.model === state.model);
  return sortBy(narrowed, state.requestSort.dir, REQUEST_VALUE[state.requestSort.key]);
}

/** Models seen in the current view, most requests first (the requests table's filter choices). */
export function modelsInView(state: ClientState): { model: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const request of visibleRequests(state))
    counts.set(request.model, (counts.get(request.model) ?? 0) + 1);
  return [...counts]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
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
  const filtered =
    state.session === null ? state.events : state.events.filter((e) => e.sessionId === state.session);
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

export function visibleTools(state: ClientState): ToolCallRecord[] {
  const filtered =
    state.session === null ? state.tools : state.tools.filter((t) => t.sessionId === state.session);
  return [...filtered].sort((a, b) => b.startedAt - a.startedAt);
}

export function selectedSession(state: ClientState): SessionListItem | null {
  if (state.session === null) return null;
  return state.sessions.find((s) => s.id === state.session) ?? null;
}

export function drawerRequest(state: ClientState): RequestRecord | null {
  if (state.request === null) return null;
  return state.requests.find((r) => r.id === state.request) ?? null;
}

/** One request's estimated cost at list price; null for an unpriced model or a router's echo of it. */
export function requestCost(request: RequestRecord): number | null {
  return request.provider === "route" ? null : costOf(request.model, request.tokens);
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

/** The attribution table in the chosen order (unpriced rows sink when sorting by cost). */
export function tableAttribution(state: ClientState): AttributionRow[] {
  return sortBy(
    state.attribution ?? [],
    state.attributionSort.dir,
    ATTRIBUTION_VALUE[state.attributionSort.key],
  );
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
