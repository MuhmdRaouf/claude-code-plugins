/**
 * The dashboard's brain, split out of the browser entry: one ClientState, the reader actions that change it and
 * the server reads that feed it. The entry paints: it subscribes, renders and owns every listener. The
 * controller never touches the DOM — everything outside its state goes through the injected Io.
 */

import type { Alert } from "../../alerts/engine.ts";
import type { Budget, BudgetStatus } from "../../budget/budgets.ts";
import type { AdvisorReport } from "../../cost/advisor.ts";
import type { AttributionNode, AttributionRange } from "../../cost/attribution.ts";
import type {
  CaptureAnswer,
  ContextAnswer,
  ContextMessage,
  FlowSeries,
  TreeNodeRow,
} from "../../history/history.ts";
import type { RouterHealth } from "../../router/health.ts";
import type { Settings } from "../../server/settings.ts";
import type { EventRecord, RequestRecord, SessionView, ToolCallRecord } from "../../shared/model.ts";
import { isInFlight } from "../../shared/model.ts";
import {
  DEFAULT_RANGE,
  PRESETS,
  parseRangeHash,
  rangeToHash,
  type TimeRange,
} from "../../shared/time-range.ts";
import { attributionCsv, exportName, requestsCsv, toolsCsv } from "../export.ts";
import {
  type AgentTranscriptState,
  type AttributionSortKey,
  applyAgentTranscript,
  applyBackfill,
  applyCapture,
  applyContent,
  applyContext,
  applyDetail,
  applyMessage,
  type BudgetDraft,
  budgetFromDraft,
  type ClientState,
  type ContentState,
  type ContextState,
  clearSelected,
  type DrawerTab,
  detailTargets,
  draftOf,
  drawerRequest,
  flowSource,
  type HistoryRoot,
  type HistoryScope,
  initialClientState,
  type ModelsData,
  modelsQuery,
  modelsScopeKey,
  newDraft,
  nextSort,
  nodeAgentOf,
  REFRESH_CHOICES,
  type RequestSortKey,
  rangeEqual,
  requestNodeId,
  type SessionsPanel,
  type StreamMessage,
  scopeEqual,
  selectedIds,
  stepRequest,
  TABS,
  type Tab,
  type ThemePref,
  type TimeMode,
  type ToolSortKey,
  tableRequests,
  tableTools,
  toggleSelected,
  withBudget,
  withSelection,
} from "../state.ts";

const THEME_KEY = "radar-theme";
const TIME_KEY = "radar-time";
const REFRESH_KEY = "radar-refresh";
/** Live updates arrive in bursts (a request, its tool calls, a sessions message); notify at most this often. */
const NOTIFY_EVERY_MS = 250;
/** Alerts, budget spend and the tab's own data: polled at this cadence whatever the tab. */
const POLL_EVERY_MS = 10_000;
/** How long the agents tab serves a held session detail of a live session before it refetches: the
 *  server rescans its registry every 5 s and re-reads the subagent rule on every ingest, so a held
 *  copy is always at least one pass behind the live/ended words its table shows. */
const DETAIL_REFRESH_MS = 5_000;
/** How long the history search box waits for the reader to stop typing before it fetches. */
const SEARCH_DEBOUNCE_MS = 250;
/** One page of the history rail; one row past it tells whether a next page exists. */
const ROOTS_PAGE = 100;
/** One page of a scope's history requests. */
const REQUESTS_PAGE = 200;
/** One page of a rebuilt conversation; the page before it loads on demand. */
const CONTEXT_PAGE = 40;
/** One page of an agent transcript; a live view starts deeper than the inspector's context page. */
const TRANSCRIPT_PAGE = 60;
/** The retention choices the settings card offers, as their wire values ("0" = forever). */
const RETENTION_VALUES = new Set<string>(["7", "30", "90", "0"]);

const RANGE_VALUES = new Set<string>(["day", "week", "month"]);
const ATTRIBUTION_SORT_KEYS = new Set<string>([
  "label",
  "requests",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
]);

const REQUEST_SORT_KEYS = new Set<string>([
  "time",
  "agent",
  "what",
  "model",
  "upstream",
  "latency",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "stop",
  "cost",
]);
const TOOL_SORT_KEYS = new Set<string>(["time", "tool", "session", "agent", "duration", "result"]);

/** The tab values the inspector's tab list may switch to. */
const DRAWER_TAB_IDS = new Set<string>(["overview", "input", "output", "context", "raw"]);

/** Toggling one key of a set adds it, toggling again removes it: collapse, empty-agent reveals, … */
function toggleSetKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The sessions whose detail the views need: the picked ones, the ones the rail expanded, and — on the
 *  agents tab — the few most recent whose trees it draws. */
function detailIds(state: ClientState): Set<string> {
  const ids = new Set<string>();
  for (const id of selectedIds(state)) ids.add(id);
  for (const id of state.expanded) ids.add(id);
  if (state.tab === "agents") {
    for (const target of detailTargets(state)) ids.add(target.id);
  }
  return ids;
}

/** A server answer to one of the controller's GETs and writes (the slice of Response it reads). */
export type HttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

/** The slice of EventSource the controller uses; a test fake pushes `{ data }` objects into it. */
export type EventStream = {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((message: { data: string }) => void) | null;
  close: () => void;
};

/** Everything the controller touches outside its state; the entry wires the browser's own objects in. */
export type Io = {
  fetch: (
    path: string,
    init?: { body: string; headers: Record<string, string>; method: "PUT" | "POST" },
  ) => Promise<HttpResponse>;
  EventSource: new (url: string) => EventStream;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  location: { hash: string };
  replaceHash: (hash: string) => void;
  /** Add a history entry (a back/forward step), for the rail's panel, search, repo and scope. */
  pushHash: (hash: string) => void;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
  download: (name: string, text: string) => void;
  /** The page's own URL, hash included — "Copy link" hands it to the reader. */
  href: () => string;
  /** Best-effort clipboard write; failure (no permission) just leaves the hash in the address bar. */
  clipboard: (text: string) => void;
  applyTheme: (pref: ThemePref) => void;
  revealView: () => void;
  /** Put focus back on the row that opened the drawer (`id`), once it closes. */
  focusOpener: (id: string) => void;
};

/** The rail's state — and the dashboard-wide time range — that the URL hash carries beyond the tab, so reload
 *  and Back keep them. `session` is the picked set: one id, several comma-joined, or none. `agent` is the
 *  open agent transcript's history node, the way the drawer's scope remembers itself. */
type HashState = {
  panel: SessionsPanel;
  q: string;
  repo: string | null;
  scope: HistoryScope | null;
  session: string[];
  range: TimeRange;
  agent?: string | null;
};

/** Split a raw hash into its view and its rail state: `#requests`, `#agents?panel=history&q=fix&range=24h`. */
export function hashParse(raw: string): { tab: string; state: HashState } {
  const body = raw.replace(/^#\/?/, "");
  const at = body.indexOf("?");
  const params = new URLSearchParams(at < 0 ? "" : body.slice(at + 1));
  const root = params.get("root");
  const node = params.get("node");
  const repo = params.get("repo");
  const scope: HistoryScope | null =
    root === null || root === ""
      ? null
      : { rootId: root, nodeId: node === null || node === "" ? null : node };
  return {
    tab: at < 0 ? body : body.slice(0, at),
    state: {
      panel: params.get("panel") === "history" ? "history" : "live",
      q: params.get("q") ?? "",
      repo: repo === null || repo === "" ? null : repo,
      scope,
      session: (params.get("session") ?? "").split(",").filter((id) => id !== ""),
      range: parseRangeHash(params),
      agent: params.get("agent"),
    },
  };
}

/** The hash for one view and rail state; every default piece stays out, so `#requests` stays `#requests`. */
export function hashOf(tab: Tab, rail: HashState): string {
  const params = new URLSearchParams();
  if (rail.panel === "history") params.set("panel", "history");
  if (rail.q !== "") params.set("q", rail.q);
  if (rail.repo !== null) params.set("repo", rail.repo);
  if (rail.scope !== null) {
    params.set("root", rail.scope.rootId);
    if (rail.scope.nodeId !== null) params.set("node", rail.scope.nodeId);
  }
  if (rail.session.length > 0) params.set("session", rail.session.join(","));
  if (rail.agent) params.set("agent", rail.agent);
  if (!rangeEqual(rail.range, DEFAULT_RANGE)) {
    for (const [key, value] of new URLSearchParams(rangeToHash(rail.range))) params.set(key, value);
  }
  const query = params.toString().replaceAll("%2C", ","); // a comma is legal in a query, and reads better
  return `#${tab}${query === "" ? "" : `?${query}`}`;
}

/** The held messages older than a fresh page's first, the earlier pages a reader loaded: a message is
 *  older when its request came first, or is the same request's input before that page starts at its answer. */
function olderThan(held: ContextMessage[], first: ContextMessage | undefined): ContextMessage[] {
  if (first === undefined) return [];
  const rank = (m: ContextMessage): number => (m.role === "user" ? 0 : 1);
  return held.filter(
    (m) =>
      m.ts < first.ts ||
      (m.ts === first.ts && m.requestId < first.requestId) ||
      (m.ts === first.ts && m.requestId === first.requestId && rank(m) < rank(first)),
  );
}

/** A fresh newest page over what is held: the earlier pages the reader loaded stay, with their cursor. */
function mergedTranscript(
  held: AgentTranscriptState | null,
  answer: ContextAnswer & { note?: string },
): AgentTranscriptState {
  const ready = held?.status === "ready" ? held : null;
  const kept = ready === null ? [] : olderThan(ready.messages, answer.messages[0]);
  return {
    status: "ready",
    requestId: answer.requestId,
    messages: [...kept, ...answer.messages],
    totals: answer.totals,
    note: answer.note ?? null,
    next: ready !== null && kept.length > 0 ? ready.next : answer.next,
    loadingOlder: ready?.loadingOlder ?? false,
  };
}

export class RadarController {
  private readonly io: Io;
  private state: ClientState;
  private readonly listeners = new Set<(state: ClientState) => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNotify = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** The auto-refresh interval, rebuilt whenever the cadence changes; null while off. */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** The flow fetch in flight, so a burst of range changes fetches the route once at a time. */
  private flowInFlight = false;
  /** The models tab's fetch in flight, so a burst of scope changes fetches the route once at a time. */
  private modelsInFlight = false;
  /** The lists' backfill in flight, so a refresh landing on one cannot fetch the same lists twice. */
  private backfillInFlight = false;
  private stream: EventStream | null = null;
  /** Whether the stream has opened before: a later open is a reconnect (the server restarted, or the
   *  connection dropped), and the snapshot a reconnect carries has no record lists — those need the
   *  backfill again, or rows read while the old process lived outlive the ones ingest now holds. */
  private streamOpened = false;
  /** Session details in flight, so a burst of messages fetches a session once. */
  private readonly fetching = new Set<string>();
  /** When each held session detail landed, so the agents tab can tell a stale live one. */
  private readonly detailAt: Record<string, number> = {};
  /** The drawer's opener, so focus can go back to its row when the drawer closes. */
  private drawerOpener: string | null = null;
  /** The node the held transcript page belongs to: a hash restore writes the new node into the state
   *  before the transcript opens, so the state's own node cannot tell whose messages are shown. */
  private transcriptNode: string | null = null;
  /** A transcript read in flight, and whether a live refresh asked again meanwhile: overlapping pushes
   *  coalesce into one more read once it lands, never several at once. */
  private transcriptReading = false;
  private transcriptAgain = false;
  /** The history search box's pending fetch, so typing a whole word queries once. */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** One handler per data-action; unknown actions and values are ignored. */
  private readonly actions: Record<string, (value: string) => void> = {
    tab: (value) => this.selectTab(value),
    // clicking a session card: toggle it in or out of the picked set; "" (the "All sessions" card) clears
    session: (value) => {
      this.setState(value === "" ? clearSelected(this.state) : toggleSelected(this.state, value));
      this.replaceHash();
      void this.ensureDetails();
      void this.ensureModels();
    },
    clearSelection: () => {
      this.setState(clearSelected(this.state));
      this.replaceHash();
      void this.ensureDetails();
      void this.ensureModels();
    },
    // the session page's picked agent: the row tables and the header's crumb narrow to it, "" widens back
    agent: (value) => this.setState({ ...this.state, agent: value === "" ? null : value }),
    "live-input": (value) => this.setState({ ...this.state, liveInput: value }),
    "live-repo": (value) => this.setState({ ...this.state, liveRepo: value === "" ? null : value }),
    range: (value) => {
      if (PRESETS.some((entry) => entry.key === value)) {
        this.setRange({ preset: value as TimeRange["preset"], from: 0, to: null });
      }
    },
    "range-custom": (value) => this.applyCustomRange(value),
    "range-reset": () => this.setRange({ ...DEFAULT_RANGE }),
    "range-copy": () => this.copyRangeLink(),
    "auto-refresh": (value) => {
      const ms = Number(value);
      if (!REFRESH_CHOICES.includes(ms as (typeof REFRESH_CHOICES)[number])) return;
      this.remember(REFRESH_KEY, ms === 0 ? null : String(ms));
      this.setState({ ...this.state, refresh: ms as ClientState["refresh"] });
      this.syncRefreshTimer();
    },
    model: (value) => this.setState({ ...this.state, model: value === "" ? null : value }),
    "tool-filter": (value) =>
      this.setState({ ...this.state, toolFilter: value === "failed" ? "failed" : "all" }),
    collapse: (value) =>
      this.setState({ ...this.state, collapsed: toggleSetKey(this.state.collapsed, value) }),
    "empty-agents": (value) =>
      this.setState({ ...this.state, emptyAgents: toggleSetKey(this.state.emptyAgents, value) }),
    drawer: (value) => this.openDrawer(value),
    "close-drawer": () => this.closeDrawer(),
    "agent-transcript": (value) => void this.openTranscript(value),
    "close-agent-transcript": () => this.clearTranscript(),
    "agent-transcript-more": () => void this.loadTranscriptPage(),
    "agent-requests": (value) => this.showAgentRequests(value),
    "prev-request": () => this.stepDrawer(-1),
    "next-request": () => this.stepDrawer(1),
    "drawer-tab": (value) => {
      if (!DRAWER_TAB_IDS.has(value)) return;
      const drawerTab = value as DrawerTab;
      this.setState({ ...this.state, drawerTab });
      const id = this.state.request;
      if (id === null) return;
      if (drawerTab === "input" || drawerTab === "output" || drawerTab === "raw") {
        void this.ensureContent(id);
      }
      if (drawerTab === "context") {
        void this.ensureContext(id);
        void this.ensureCapture(id);
      }
    },
    "context-more": () => void this.loadContextPage(),
    "scope-agent": (value) => this.scopeAgent(value),
    panel: (value) => {
      if (value !== "live" && value !== "history") return;
      this.setState({ ...this.state, sessionsPanel: value as SessionsPanel });
      this.syncHash();
      this.loadPanel();
    },
    "history-input": (value) => {
      this.setState({ ...this.state, historyInput: value });
      if (this.searchTimer !== null) this.io.clearTimeout(this.searchTimer);
      this.searchTimer = this.io.setTimeout(() => {
        this.searchTimer = null;
        this.applyHistorySearch();
      }, SEARCH_DEBOUNCE_MS);
    },
    "history-repo": (value) => {
      const repo = value === "" ? null : value;
      if (repo === this.state.historyRepo) return;
      this.resetHistoryPage({ historyRepo: repo });
      this.syncHash();
      void this.loadHistoryRoots();
    },
    "more-roots": () => {
      const before = this.state.historyNext;
      if (before === null || this.state.historyRootsLoading) return;
      void this.loadMoreRoots(before);
    },
    tree: (value) => {
      const next = toggleSetKey(this.state.expanded, value);
      this.setState({ ...this.state, expanded: next });
      if (!next.has(value)) return;
      if (this.state.sessionsPanel === "history") void this.ensureTree(value);
      else void this.ensureDetail(value);
    },
    scope: (value) => {
      let parsed: { rootId?: unknown; nodeId?: unknown } = {};
      try {
        parsed = JSON.parse(value) as { rootId?: unknown; nodeId?: unknown };
      } catch {
        return;
      }
      if (typeof parsed.rootId !== "string" || parsed.rootId === "") return;
      if (parsed.nodeId !== undefined && parsed.nodeId !== null && typeof parsed.nodeId !== "string") return;
      const nodeId = typeof parsed.nodeId === "string" && parsed.nodeId !== "" ? parsed.nodeId : null;
      this.setState({ ...this.state, historyScope: { rootId: parsed.rootId, nodeId } });
      this.syncHash();
      void this.loadScopeRequests();
    },
    "scope-clear": () => {
      if (this.state.historyScope === null) return;
      this.setState({
        ...this.state,
        historyScope: null,
        historyRequests: null,
        historyRequestsNext: null,
        historyRequestsError: null,
      });
      this.syncHash();
    },
    "more-requests": () => {
      const scope = this.state.historyScope;
      const before = this.state.historyRequestsNext;
      if (scope === null || before === null || this.state.historyRequestsLoading) return;
      void this.loadMoreRequests(scope, before);
    },
    retention: (value) => void this.saveRetention(value),
    "clear-history": (value) => {
      if (value === "cancel") {
        this.setState({ ...this.state, clearConfirm: false });
        return;
      }
      if (!this.state.clearConfirm) {
        this.setState({ ...this.state, clearConfirm: true });
        return;
      }
      this.setState({ ...this.state, clearConfirm: false });
      void this.clearHistory();
    },
    hash: (value) => this.applyHash(value),
    theme: (value) => {
      if (value === "system" || value === "light" || value === "dark") this.setTheme(value);
    },
    "time-mode": (value) => {
      const timeMode: TimeMode = value === "absolute" ? "absolute" : "relative";
      this.remember(TIME_KEY, timeMode === "absolute" ? timeMode : null);
      this.setState({ ...this.state, timeMode });
    },
    "sort-requests": (value) => {
      if (REQUEST_SORT_KEYS.has(value))
        this.setState({
          ...this.state,
          requestSort: nextSort(this.state.requestSort, value as RequestSortKey),
        });
    },
    "sort-tools": (value) => {
      if (TOOL_SORT_KEYS.has(value))
        this.setState({ ...this.state, toolSort: nextSort(this.state.toolSort, value as ToolSortKey) });
    },
    export: (value) => this.exportCsv(value),
    "dismiss-alert": (value) => {
      this.setState({ ...this.state, alerts: this.state.alerts.filter((alert) => alert.id !== value) });
      void this.sendJson("POST", "/api/alerts/dismiss", { id: value }).catch(() => undefined);
    },
    "costs-collapse": (value) =>
      this.setState({ ...this.state, costsCollapsed: toggleSetKey(this.state.costsCollapsed, value) }),
    "attribution-range": (value) => {
      if (!RANGE_VALUES.has(value)) return;
      this.setState({ ...this.state, attributionRange: value as AttributionRange, attributionTree: null });
      void this.loadAttribution();
    },
    "sort-attribution": (value) => {
      if (ATTRIBUTION_SORT_KEYS.has(value))
        this.setState({
          ...this.state,
          attributionSort: nextSort(this.state.attributionSort, value as AttributionSortKey),
        });
    },
    "new-budget": () =>
      this.setState({ ...this.state, draft: newDraft(this.state.providers), formMessage: null }),
    "edit-budget": (value) => this.editBudget(value),
    "cancel-budget": () => this.setState({ ...this.state, draft: null, formMessage: null }),
    "save-budget": () => void this.saveDraft(),
    "remove-budget": (value) =>
      void this.saveBudgets(
        (this.state.budgets ?? []).filter((budget) => budget.id !== value),
        "Budget removed.",
      ),
    "toggle-notifications": () => void this.toggleNotifications(),
    "draft-field": (value) => this.draftField(value),
    refresh: () => this.refreshAll(),
  };

  constructor(io: Io) {
    this.io = io;
    const parsed = hashParse(io.location.hash);
    this.state = withSelection(
      {
        ...initialClientState(),
        tab: TABS.find((entry) => entry.id === parsed.tab)?.id ?? "overview",
        theme: this.savedTheme(),
        timeMode: this.savedTimeMode(),
        refresh: this.savedRefresh(),
        range: parsed.state.range,
        sessionsPanel: parsed.state.panel,
        historyInput: parsed.state.q,
        historyQuery: parsed.state.q,
        historyRepo: parsed.state.repo,
        historyScope: parsed.state.scope,
        agentNode: parsed.state.agent ?? null,
      },
      parsed.state.session,
    );
  }

  /* ------------------------------- state ------------------------------- */

  getState(): ClientState {
    return this.state;
  }

  /** Hear about every state change; the returned call stops the subscription. */
  subscribe(listener: (state: ClientState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tell the listeners at once, cancelling any notification still queued. */
  flush(): void {
    if (this.notifyTimer !== null) {
      this.io.clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.notify();
  }

  /** Queue the change; the listeners hear about it within NOTIFY_EVERY_MS, a burst becoming one notification. */
  private setState(next: ClientState): void {
    this.state = next;
    if (this.notifyTimer !== null) return;
    this.notifyTimer = this.io.setTimeout(
      () => {
        this.notifyTimer = null;
        this.notify();
      },
      Math.max(0, this.lastNotify + NOTIFY_EVERY_MS - this.io.now()),
    );
  }

  private notify(): void {
    this.lastNotify = this.io.now();
    for (const listener of [...this.listeners]) listener(this.state);
  }

  /** One reader action: applied at once and the listeners hear about it at once, ahead of any queued update. */
  act(action: string, value = ""): void {
    this.actions[action]?.(value);
    if (this.notifyTimer !== null) this.flush();
  }

  /* ----------------------------- preferences ---------------------------- */

  /** Persist a preference; null forgets it. Storage may be off (private mode): the choice then lasts the page. */
  private remember(key: string, value: string | null): void {
    try {
      if (value === null) this.io.storage.removeItem(key);
      else this.io.storage.setItem(key, value);
    } catch {
      // no storage: nothing to keep
    }
  }

  private savedTheme(): ThemePref {
    try {
      const saved = this.io.storage.getItem(THEME_KEY);
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  }

  private savedTimeMode(): TimeMode {
    try {
      return this.io.storage.getItem(TIME_KEY) === "absolute" ? "absolute" : "relative";
    } catch {
      return "relative";
    }
  }

  /** The saved auto-refresh cadence; anything else (or no storage) reads as the 5 s default. */
  private savedRefresh(): ClientState["refresh"] {
    try {
      const raw = this.io.storage.getItem(REFRESH_KEY);
      if (raw === null) return 5000; // Number(null) is 0 — the missing key must not read as "off"
      const saved = Number(raw);
      return REFRESH_CHOICES.includes(saved as (typeof REFRESH_CHOICES)[number])
        ? (saved as ClientState["refresh"])
        : 5000;
    } catch {
      return 5000;
    }
  }

  private setTheme(pref: ThemePref): void {
    this.io.applyTheme(pref);
    this.remember(THEME_KEY, pref === "system" ? null : pref);
    this.setState({ ...this.state, theme: pref });
  }

  /* -------------------------------- the hash ---------------------------- */

  /** The hash the current state reads as; a plain `#tab` while the rail and the range sit at their defaults. */
  private currentHash(): string {
    return hashOf(this.state.tab, {
      panel: this.state.sessionsPanel,
      q: this.state.historyQuery,
      repo: this.state.historyRepo,
      scope: this.state.historyScope,
      session: selectedIds(this.state),
      range: this.state.range,
      agent: this.state.agentNode,
    });
  }

  /** Write the state into the URL as a new history entry, so Back returns to it. */
  private syncHash(): void {
    const next = this.currentHash();
    if (this.io.location.hash !== next) this.io.pushHash(next);
  }

  /** Rewrite the URL in place for a view-level change (the tab, the range): no history step of its own. */
  private replaceHash(): void {
    const next = this.currentHash();
    if (this.io.location.hash !== next) this.io.replaceHash(next);
  }

  /** A Back/Forward (or a pasted link): fold the hash's view and rail state in, fetching what is new. */
  private applyHash(raw: string): void {
    const parsed = hashParse(raw);
    const updates = this.hashUpdates(parsed);
    if (updates.tab === undefined && Object.keys(updates).length === 0) return;
    this.setState({ ...this.state, ...updates });
    this.fetchForHash(updates);
  }

  /** What a hash's view and rail state would change, compared with the state in hand. */
  private hashUpdates(parsed: { tab: string; state: HashState }): Partial<ClientState> {
    const updates: Partial<ClientState> = {};
    const tab = TABS.find((entry) => entry.id === parsed.tab);
    if (tab !== undefined && tab.id !== this.state.tab) updates.tab = tab.id;
    const rail = parsed.state;
    if (rail.panel !== this.state.sessionsPanel) updates.sessionsPanel = rail.panel;
    if (rail.q !== this.state.historyQuery) {
      updates.historyInput = rail.q;
      updates.historyQuery = rail.q;
    }
    if (rail.repo !== this.state.historyRepo) updates.historyRepo = rail.repo;
    if (!scopeEqual(rail.scope, this.state.historyScope)) updates.historyScope = rail.scope;
    if (rail.session.join(",") !== selectedIds(this.state).join(",")) {
      const next = withSelection(this.state, rail.session);
      updates.selected = next.selected;
      updates.session = next.session;
    }
    if (!rangeEqual(rail.range, this.state.range)) updates.range = rail.range;
    if ((rail.agent ?? null) !== this.state.agentNode) updates.agentNode = rail.agent ?? null;
    return updates;
  }

  /** The reads a hash restore calls for: the rail's page, the scope's requests, the range's flow. */
  private fetchForHash(updates: Partial<ClientState>): void {
    if (updates.tab !== undefined) {
      this.io.revealView();
      void this.loadTab(updates.tab);
    }
    if (
      updates.sessionsPanel === "history" ||
      updates.historyQuery !== undefined ||
      updates.historyRepo !== undefined
    ) {
      this.resetHistoryPage({});
      void this.loadPanel();
    }
    if (updates.range !== undefined) {
      void this.ensureFlow();
      void this.ensureModels();
    }
    if (updates.selected !== undefined) {
      void this.ensureDetails();
      void this.ensureModels();
    }
    if (updates.agentNode !== undefined) {
      if (updates.agentNode === null) this.clearTranscript();
      else void this.openTranscript(updates.agentNode);
    }
    if (updates.historyScope === undefined) return;
    if (updates.historyScope === null) {
      this.setState({
        ...this.state,
        historyRequests: null,
        historyRequestsNext: null,
        historyRequestsError: null,
      });
      return;
    }
    void this.loadScopeRequests();
  }

  /* ------------------------------ interaction --------------------------- */

  private selectTab(value: string): void {
    const tab = TABS.find((entry) => entry.id === value);
    if (tab === undefined) return;
    const next = hashOf(tab.id, {
      panel: this.state.sessionsPanel,
      q: this.state.historyQuery,
      repo: this.state.historyRepo,
      scope: this.state.historyScope,
      session: selectedIds(this.state),
      range: this.state.range,
    });
    if (this.io.location.hash !== next) this.io.replaceHash(next);
    this.setState({ ...this.state, tab: tab.id });
    this.io.revealView();
    void this.loadTab(tab.id);
  }

  private openDrawer(id: string): void {
    this.drawerOpener = id;
    this.setState({ ...this.state, request: id, drawerTab: "overview" });
    // the overview names the request's agent after its session's own agents; the detail carries them
    const request = drawerRequest(this.state);
    if (request !== null) void this.ensureDetail(request.sessionId);
  }

  /** Step to the neighbouring request within the current scope, keeping the tab that is open. */
  private stepDrawer(delta: 1 | -1): void {
    const id = stepRequest(this.state, delta);
    if (id === null) return;
    this.drawerOpener = id;
    this.setState({ ...this.state, request: id });
    const tab = this.state.drawerTab;
    if (tab === "input" || tab === "output" || tab === "raw") void this.ensureContent(id);
    if (tab === "context") {
      void this.ensureContext(id);
      void this.ensureCapture(id);
    }
    const request = drawerRequest(this.state);
    if (request !== null) void this.ensureDetail(request.sessionId);
  }

  private closeDrawer(): void {
    if (this.state.request === null) return;
    this.setState({ ...this.state, request: null });
    const opener = this.drawerOpener;
    this.drawerOpener = null;
    if (opener !== null) this.io.focusOpener(opener);
  }

  /**
   * The Agents view's live transcript: open on the node, remember it in the hash (so reload and Back
   * restore it), make sure the session detail the header reads is held, and fetch the newest page.
   * A held ready page answers again only after an error, like the inspector's context read.
   */
  private async openTranscript(nodeId: string): Promise<void> {
    if (nodeId === "") return;
    const held = this.state.agentTranscript;
    if (this.transcriptNode === nodeId && held !== null && held.status !== "error") return;
    this.transcriptNode = nodeId;
    this.setState({ ...this.state, agentNode: nodeId, agentTranscript: { status: "loading" } });
    this.syncHash();
    const parsed = nodeAgentOf(nodeId);
    if (parsed !== null) void this.ensureDetail(parsed.sessionId);
    await this.fetchTranscript();
  }

  private clearTranscript(): void {
    // a Back that lands before the slide-over merges the null node first; the page still has to go
    this.transcriptNode = null;
    if (this.state.agentNode === null && this.state.agentTranscript === null) return;
    this.setState({ ...this.state, agentNode: null, agentTranscript: null });
    this.syncHash();
  }

  /**
   * The open agent's newest page. Opening and the retry show the skeleton; a live refresh keeps what is
   * shown and merges the new page in, so the reader's place and the earlier pages they loaded stay.
   */
  private async fetchTranscript(): Promise<void> {
    const nodeId = this.state.agentNode;
    if (nodeId === null) return;
    if (this.state.agentTranscript?.status !== "ready")
      this.setState({ ...this.state, agentTranscript: { status: "loading" } });
    this.transcriptReading = true;
    try {
      const answer = await this.fetchJson<ContextAnswer & { note?: string }>(
        `/api/history/agent/${encodeURIComponent(nodeId)}/transcript?limit=${TRANSCRIPT_PAGE}`,
      );
      if (this.state.agentNode !== nodeId) return; // another agent was opened meanwhile
      const transcript = mergedTranscript(this.state.agentTranscript, answer);
      this.setState(applyAgentTranscript(this.state, transcript));
    } catch (error) {
      if (this.state.agentNode !== nodeId) return;
      // a failed live refresh leaves the page shown; only a page that never arrived turns into the error
      if (this.state.agentTranscript?.status !== "ready")
        this.setState(applyAgentTranscript(this.state, this.historyFailure(error)));
    } finally {
      this.transcriptReading = false;
      if (this.transcriptAgain) {
        this.transcriptAgain = false;
        void this.fetchTranscript();
      }
    }
  }

  /** The page before the one shown, prepended; a failure leaves what is shown and offers the page again. */
  private async loadTranscriptPage(): Promise<void> {
    const nodeId = this.state.agentNode;
    const held = this.state.agentTranscript;
    if (nodeId === null || held?.status !== "ready" || held.next === null || held.loadingOlder) return;
    this.setState(applyAgentTranscript(this.state, { ...held, loadingOlder: true }));
    try {
      const answer = await this.fetchJson<ContextAnswer>(
        `/api/history/agent/${encodeURIComponent(nodeId)}/transcript?limit=${TRANSCRIPT_PAGE}` +
          `&cursor=${encodeURIComponent(held.next)}`,
      );
      const current = this.state.agentTranscript;
      if (this.state.agentNode !== nodeId || current?.status !== "ready") return;
      this.setState(
        applyAgentTranscript(this.state, {
          ...current,
          messages: [...answer.messages, ...current.messages],
          next: answer.next,
          loadingOlder: false,
        }),
      );
    } catch {
      const current = this.state.agentTranscript;
      if (current?.status !== "ready") return;
      this.setState(applyAgentTranscript(this.state, { ...current, loadingOlder: false }));
    }
  }

  /**
   * The slide-over's "Show its requests" — the row click's old job: close the transcript and narrow the
   * session's tables to the agent, picking its session first when another one is in front of the reader.
   */
  private showAgentRequests(value: string): void {
    let parsed: { sessionId?: unknown; agentId?: unknown } = {};
    try {
      parsed = JSON.parse(value) as { sessionId?: unknown; agentId?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.sessionId !== "string" || parsed.sessionId === "") return;
    if (typeof parsed.agentId !== "string" || parsed.agentId === "") return;
    this.clearTranscript();
    if (this.state.session !== parsed.sessionId) {
      this.setState(withSelection(this.state, [parsed.sessionId]));
      this.replaceHash();
      void this.ensureDetails();
      void this.ensureModels();
    }
    this.setState({ ...this.state, agent: parsed.agentId });
  }

  /**
   * A pushed request for the open agent's node refetches its transcript — the live half of the live
   * transcript. Driven by the stream, never a timer: a request the transcript already answers is
   * skipped while it is still in flight, and its completed copy (the server re-pushes merged records)
   * picks up the sides stored under it.
   */
  private refreshTranscriptFor(request: RequestRecord): void {
    const held = this.state.agentTranscript;
    if (this.state.agentNode === null || held?.status !== "ready") return;
    if (requestNodeId(this.state, request) !== this.state.agentNode) return;
    if (request.id === held.requestId && isInFlight(request)) return;
    if (this.transcriptReading) this.transcriptAgain = true;
    else void this.fetchTranscript();
  }

  /** The inspector's agent link: the picked scope's own tree narrows to the agent's node, the live view
   *  filters to the agent's session. Unknown shapes do nothing. */
  private scopeAgent(value: string): void {
    let parsed: { sessionId?: unknown; agentId?: unknown } = {};
    try {
      parsed = JSON.parse(value) as { sessionId?: unknown; agentId?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.sessionId !== "string" || parsed.sessionId === "") return;
    if (typeof parsed.agentId !== "string" || parsed.agentId === "") return;
    const scope = this.state.historyScope;
    if (scope !== null) {
      const node = (this.state.historyTrees[scope.rootId] ?? []).find(
        (entry) => entry.agentId === parsed.agentId,
      );
      this.actions.scope?.(JSON.stringify({ rootId: scope.rootId, nodeId: node?.id ?? null }));
      return;
    }
    this.actions.session?.(parsed.sessionId);
  }

  private editBudget(id: string): void {
    const budget = this.state.budgets?.find((entry) => entry.id === id);
    if (budget !== undefined) this.setState({ ...this.state, draft: draftOf(budget), formMessage: null });
  }

  /** A select or input in the budget form changed: `<field>=<value>` keeps the choice in the draft. */
  private draftField(spec: string): void {
    const at = spec.indexOf("=");
    const field = at < 0 ? "" : spec.slice(0, at);
    const value = at < 0 ? "" : spec.slice(at + 1);
    const draft = this.state.draft;
    if (draft === null) return;
    if (field === "scope") this.setState({ ...this.state, draft: { ...draft, scope: value } });
    else if (field === "period" && RANGE_VALUES.has(value))
      this.setState({ ...this.state, draft: { ...draft, period: value as BudgetDraft["period"] } });
    else if (field === "action" && (value === "warn" || value === "stop"))
      this.setState({ ...this.state, draft: { ...draft, action: value } });
    else if (field === "limit") this.setState({ ...this.state, draft: { ...draft, limit: value } });
  }

  /** Hand the reader a CSV of what a table shows. */
  private exportCsv(value: string): void {
    const now = this.io.now();
    if (value === "requests")
      this.io.download(exportName("requests", now), requestsCsv(tableRequests(this.state)));
    if (value === "tools") this.io.download(exportName("tools", now), toolsCsv(tableTools(this.state)));
    if (value === "attribution" && this.state.attributionTree !== null)
      this.io.download(
        exportName("costs", now),
        attributionCsv(this.state.attributionRange, this.state.attributionTree),
      );
  }

  /* ------------------------------ time range ---------------------------- */

  /** One range change: into the URL (in place, like the tab) and the data refetched for the new window. */
  private setRange(range: TimeRange): void {
    this.setState({ ...this.state, range });
    this.replaceHash();
    void this.ensureFlow();
    void this.ensureModels();
  }

  /** `from=<ms>&to=<ms>` from the picker's custom fieldset (`to` left out = until now); junk is ignored. */
  private applyCustomRange(value: string): void {
    const params = new URLSearchParams(value);
    const numOf = (raw: string | null): number | null => {
      const parsed = Number(raw);
      return raw !== null && raw !== "" && Number.isFinite(parsed) ? parsed : null;
    };
    const from = numOf(params.get("from"));
    if (from === null) return;
    const to = numOf(params.get("to"));
    if (to !== null && from >= to) return;
    this.setRange({ preset: null, from, to });
  }

  /** "Copy link": freeze a relative range to absolute ends, put them in the URL and copy it. */
  private copyRangeLink(): void {
    const { from, to } = flowSource(this.state, this.io.now());
    const frozen: TimeRange = { preset: null, from, to };
    if (!rangeEqual(frozen, this.state.range)) {
      this.setState({ ...this.state, range: frozen });
      this.replaceHash();
    }
    const base = this.io.href().split("#")[0] ?? this.io.href();
    this.io.clipboard(`${base}${this.currentHash()}`);
  }

  /** The range's data from the history route when the requests in memory cannot answer it: longer than a day,
   *  a fixed end, or a start older than memory reaches. Keeps the last chart while a refresh runs. */
  private async ensureFlow(): Promise<void> {
    if (this.flowInFlight) return;
    const range = this.state.range;
    const { from, to, history } = flowSource(this.state, this.io.now());
    if (!history) {
      if (this.state.flow !== null || this.state.flowError !== null)
        this.setState({ ...this.state, flow: null, flowError: null, flowLoading: false });
      return;
    }
    const key = rangeToHash(range);
    const path = `/api/history/flow?from=${from}&to=${to}&buckets=60`;
    this.flowInFlight = true;
    this.setState({ ...this.state, flowLoading: true, flowError: null });
    try {
      const series = await this.fetchJson<FlowSeries>(path);
      if (!rangeEqual(this.state.range, range)) {
        // the reader moved on while this was in flight: drop it, the newer range's own fetch answers
        this.setState({ ...this.state, flowLoading: false });
        return;
      }
      this.setState({ ...this.state, flow: { key, series }, flowLoading: false });
    } catch (error) {
      if (!rangeEqual(this.state.range, range)) {
        this.setState({ ...this.state, flowLoading: false });
        return;
      }
      this.setState({ ...this.state, flowLoading: false, flowError: this.describe(error) });
    } finally {
      this.flowInFlight = false;
    }
  }

  /**
   * The models tab's rankings for the same scope every other view reads — the picked sessions and the
   * range — from /api/models' scoped query. The stream's fleet-wide copy keeps feeding the tools tab.
   * Like the flow: the held answer stays up while a refresh runs, a stale one (the scope moved
   * meanwhile) is dropped, and a failure is named only while nothing else can be shown.
   */
  private async ensureModels(): Promise<void> {
    if (this.state.tab !== "models" || this.modelsInFlight) return;
    const key = modelsScopeKey(this.state);
    const path = `/api/models?${modelsQuery(this.state, this.io.now())}`;
    this.modelsInFlight = true;
    try {
      const data = await this.fetchJson<ModelsData>(path);
      if (modelsScopeKey(this.state) !== key) return; // the reader moved on while this was in flight
      this.setState({ ...this.state, modelsScoped: { key, data }, modelsError: null });
    } catch (error) {
      if (modelsScopeKey(this.state) !== key) return;
      this.setState({ ...this.state, modelsError: this.describe(error) });
    } finally {
      this.modelsInFlight = false;
    }
  }

  /**
   * The auto-refresh timer's tick. Everything the live views show arrives on the stream — the record
   * deltas and the session/summary refreshes — so a tick re-asks only the reads the stream cannot
   * answer: the history flow for a range served by the history route, and the models tab's tables
   * while it shows (its scope is the range, which a preset keeps moving). On a live range with the
   * models tab off it fetches nothing at all; re-pulling the lists here only burned the server
   * without changing a pixel the stream had not already drawn.
   */
  private refreshNow(): void {
    void this.ensureFlow();
    void this.ensureModels();
  }

  /** The reader's own refresh (the button, the R key): the lists' backfill again, then the flow. */
  private refreshAll(): void {
    void this.refetch()
      .then(() => this.ensureFlow())
      .catch((error: unknown) => this.setState({ ...this.state, error: this.describe(error) }));
  }

  /** One interval per cadence, rebuilt when the choice changes; 0 takes it down. */
  private syncRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      this.io.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.state.refresh === 0) return;
    this.refreshTimer = this.io.setInterval(() => this.refreshNow(), this.state.refresh);
  }

  /* --------------------------------- data -------------------------------- */

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await this.io.fetch(path);
    if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
    return (await response.json()) as T;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** One of the dashboard's own writes: JSON, same origin; the answer's error text becomes the thrown message. */
  private async sendJson<T>(method: "PUT" | "POST", path: string, body: unknown): Promise<T> {
    const response = await this.io.fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(parsed.error ?? `${method} ${path} → ${response.status}`);
    return parsed as T;
  }

  /** Alerts, budget spend, today's cost and the server's own uptime: small, polled every 10 s whatever
   *  the tab. */
  private async pollInsights(): Promise<void> {
    try {
      const [alerts, status, spend, health] = await Promise.all([
        this.fetchJson<{ alerts: Alert[] }>("/api/alerts"),
        this.fetchJson<BudgetStatus>("/api/budget-status"),
        this.fetchJson<{ todayUsd: number | null }>("/api/spend"),
        this.fetchJson<{ startedAt: number; uptimeMs: number }>("/api/health"),
      ]);
      this.setState({
        ...this.state,
        alerts: alerts.alerts,
        budgetStatus: status,
        spendToday: spend.todayUsd,
        health: { startedAt: health.startedAt, uptimeMs: health.uptimeMs },
      });
    } catch {
      // the stream's own error banner already says when the server is gone
    }
  }

  private async loadAttribution(): Promise<void> {
    const range = this.state.attributionRange;
    try {
      const answer = await this.fetchJson<{ tree: AttributionNode[] }>(
        `/api/attribution?by=tree&range=${range}`,
      );
      if (this.state.attributionRange === range)
        this.setState({ ...this.state, attributionTree: answer.tree });
    } catch {
      // keep what is shown; the next poll retries
    }
  }

  private async loadRouter(): Promise<void> {
    try {
      const [router, advisor] = await Promise.all([
        this.fetchJson<RouterHealth>("/api/router"),
        this.fetchJson<AdvisorReport>("/api/advisor"),
      ]);
      this.setState({ ...this.state, router, advisor });
    } catch {
      // keep what is shown
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const [budgets, settings] = await Promise.all([
        this.fetchJson<{ budgets: Budget[]; providers: string[] }>("/api/budgets"),
        this.fetchJson<{ settings: Settings }>("/api/settings"),
      ]);
      this.setState({
        ...this.state,
        budgets: budgets.budgets,
        providers: budgets.providers,
        settings: settings.settings,
      });
    } catch {
      // keep what is shown
    }
    void this.loadHistoryStats();
  }

  /* ------------------------------- history ------------------------------ */

  /** What the history rail needs once it shows: its first page and the repo picker's choices. */
  private loadPanel(): void {
    if (this.state.sessionsPanel !== "history") return;
    if (this.state.historyRepos === null) void this.loadHistoryRepos();
    void this.loadHistoryRoots();
  }

  /** Drop the fetched history page so the next load starts from the first one, keeping the rest. */
  private resetHistoryPage(over: Partial<ClientState>): void {
    this.setState({
      ...this.state,
      historyRoots: null,
      historyNext: null,
      historyFetched: null,
      historyRootsError: null,
      ...over,
    });
  }

  /** The query the current rail filters read as, so a stale answer is dropped. */
  private railKey(): string {
    return `${this.state.historyQuery}|${this.state.historyRepo ?? ""}`;
  }

  private rootsPath(before?: number): string {
    const params = new URLSearchParams({ scope: "history", limit: String(ROOTS_PAGE) });
    if (this.state.historyQuery !== "") params.set("q", this.state.historyQuery);
    if (this.state.historyRepo !== null) params.set("repo", this.state.historyRepo);
    if (before !== undefined) params.set("before", String(before));
    return `/api/history/roots?${params}`;
  }

  /** The history rail's first page (or the one its filters now ask for). */
  private async loadHistoryRoots(): Promise<void> {
    const key = this.railKey();
    if (this.state.historyRootsLoading) return;
    if (this.state.historyRoots !== null && this.state.historyFetched === key) return;
    this.setState({ ...this.state, historyRootsLoading: true, historyRootsError: null });
    try {
      const answer = await this.fetchJson<{ roots: HistoryRoot[]; next: number | null }>(this.rootsPath());
      if (this.railKey() !== key) return; // the reader moved on while this was in flight
      this.setState({
        ...this.state,
        historyRoots: answer.roots,
        historyNext: answer.next,
        historyFetched: key,
        historyRootsLoading: false,
      });
    } catch (error) {
      if (this.railKey() !== key) return;
      this.setState({
        ...this.state,
        historyRoots: [],
        historyNext: null,
        historyFetched: key,
        historyRootsLoading: false,
        historyRootsError: this.describe(error),
      });
    }
  }

  /** The history rail's next page, appended to what is shown. */
  private async loadMoreRoots(before: number): Promise<void> {
    const key = this.railKey();
    this.setState({ ...this.state, historyRootsLoading: true });
    try {
      const answer = await this.fetchJson<{ roots: HistoryRoot[]; next: number | null }>(
        this.rootsPath(before),
      );
      if (this.railKey() !== key) return;
      this.setState({
        ...this.state,
        historyRoots: [...(this.state.historyRoots ?? []), ...answer.roots],
        historyNext: answer.next,
        historyRootsLoading: false,
      });
    } catch {
      if (this.railKey() !== key) return;
      this.setState({ ...this.state, historyRootsLoading: false });
    }
  }

  /** The repo picker's choices, most used first; fetched once per visit. */
  private async loadHistoryRepos(): Promise<void> {
    try {
      const answer = await this.fetchJson<{ repos: { repo: string; roots: number }[] }>("/api/history/repos");
      this.setState({ ...this.state, historyRepos: answer.repos });
    } catch {
      // the picker then offers only "all repos"; the next panel switch tries again
    }
  }

  /** The search box stopped moving: fetch from the first page under the new text. */
  private applyHistorySearch(): void {
    const q = this.state.historyInput;
    if (q === this.state.historyQuery) return;
    this.resetHistoryPage({ historyQuery: q });
    this.syncHash();
    void this.loadHistoryRoots();
  }

  /** One history tree, fetched the first time its card expands; a failure leaves it loading to retry. */
  private async ensureTree(rootId: string): Promise<void> {
    if (this.state.historyTrees[rootId] !== undefined || this.state.historyTreeLoading.has(rootId)) return;
    this.setState({
      ...this.state,
      historyTreeLoading: new Set(this.state.historyTreeLoading).add(rootId),
    });
    try {
      const answer = await this.fetchJson<{ nodes: TreeNodeRow[] }>(
        `/api/history/tree/${encodeURIComponent(rootId)}`,
      );
      this.setState({
        ...this.state,
        historyTrees: { ...this.state.historyTrees, [rootId]: answer.nodes },
      });
    } catch {
      // the toggle keeps saying loading; expanding again retries
    } finally {
      const loading = new Set(this.state.historyTreeLoading);
      loading.delete(rootId);
      this.setState({ ...this.state, historyTreeLoading: loading });
    }
  }

  /** One session's detail for the live rail's tree; fetched on demand, one in-flight fetch per session. */
  private async ensureDetail(id: string): Promise<void> {
    if (this.state.details[id] !== undefined || this.fetching.has(id)) return;
    await this.fetchDetail(id);
  }

  /** The fetch under both entries: no held-copy check (the agents tab refetches stale live ones), the
   *  in-flight guard kept, and the landing time recorded for the staleness test. */
  private async fetchDetail(id: string): Promise<void> {
    if (this.fetching.has(id)) return;
    this.fetching.add(id);
    try {
      const { session } = await this.fetchJson<{ session: SessionView }>(
        `/api/sessions/${encodeURIComponent(id)}`,
      );
      this.detailAt[id] = this.io.now();
      this.setState(applyDetail(this.state, session));
    } catch {
      // leave the "loading tree…" line; expanding again retries this id
    } finally {
      this.fetching.delete(id);
    }
  }

  private requestsPath(scope: HistoryScope, before?: string): string {
    const params = new URLSearchParams({ limit: String(REQUESTS_PAGE) });
    if (scope.nodeId === null) params.set("root", scope.rootId);
    else params.set("node", scope.nodeId);
    if (before !== undefined) params.set("before", before);
    return `/api/history/requests?${params}`;
  }

  /** The scoped history requests' first page; the scope's tree comes along for the breadcrumb. */
  private async loadScopeRequests(): Promise<void> {
    const scope = this.state.historyScope;
    if (scope === null) return;
    void this.ensureTree(scope.rootId);
    this.setState({ ...this.state, historyRequestsLoading: true, historyRequestsError: null });
    try {
      const answer = await this.fetchJson<{ requests: RequestRecord[]; next: string | null }>(
        this.requestsPath(scope),
      );
      if (!scopeEqual(this.state.historyScope, scope)) return; // another scope was picked meanwhile
      this.setState({
        ...this.state,
        historyRequests: answer.requests,
        historyRequestsNext: answer.next,
        historyRequestsLoading: false,
      });
    } catch (error) {
      if (!scopeEqual(this.state.historyScope, scope)) return;
      this.setState({
        ...this.state,
        historyRequests: [],
        historyRequestsNext: null,
        historyRequestsLoading: false,
        historyRequestsError: this.describe(error),
      });
    }
  }

  /** The scoped history requests' next page, appended to what is shown. */
  private async loadMoreRequests(scope: HistoryScope, before: string): Promise<void> {
    this.setState({ ...this.state, historyRequestsLoading: true });
    try {
      const answer = await this.fetchJson<{ requests: RequestRecord[]; next: string | null }>(
        this.requestsPath(scope, before),
      );
      if (!scopeEqual(this.state.historyScope, scope)) return;
      this.setState({
        ...this.state,
        historyRequests: [...(this.state.historyRequests ?? []), ...answer.requests],
        historyRequestsNext: answer.next,
        historyRequestsLoading: false,
      });
    } catch {
      if (!scopeEqual(this.state.historyScope, scope)) return;
      this.setState({ ...this.state, historyRequestsLoading: false });
    }
  }

  /** The words for a failed history read: gone, history off, or broken, with the cause for the alert. */
  private historyFailure(error: unknown): Extract<ContentState, { status: "missing" | "off" | "error" }> {
    const text = this.describe(error);
    if (text.endsWith("→ 404")) return { status: "missing" };
    if (text.endsWith("→ 503")) return { status: "off" };
    return { status: "error", cause: text };
  }

  /** One request's stored sides, fetched once; the cache answers every later open of its tabs. */
  private async ensureContent(id: string): Promise<void> {
    if (this.state.content[id] !== undefined) return;
    this.setState(applyContent(this.state, id, { status: "loading" }));
    try {
      const answer = await this.fetchJson<{ input: unknown; output: unknown; bytes: number }>(
        `/api/history/content/${encodeURIComponent(id)}`,
      );
      this.setState(
        applyContent(this.state, id, {
          status: "ready",
          input: answer.input,
          output: answer.output,
          bytes: answer.bytes,
        }),
      );
    } catch (error) {
      this.setState(applyContent(this.state, id, this.historyFailure(error)));
    }
  }

  /** A request's rebuilt conversation, fetched the first time its Context tab opens; the first page is the
   *  newest messages, and "Load earlier messages" walks backwards from there. */
  private async ensureContext(id: string): Promise<void> {
    const held = this.state.context[id];
    if (held !== undefined && held.status !== "error") return;
    this.setState(applyContext(this.state, id, { status: "loading" }));
    try {
      const answer = await this.fetchJson<ContextAnswer & { note?: string }>(
        `/api/history/context/${encodeURIComponent(id)}?limit=${CONTEXT_PAGE}`,
      );
      this.setState(
        applyContext(this.state, id, {
          status: "ready",
          messages: answer.messages,
          totals: answer.totals,
          note: answer.note ?? null,
          next: answer.next,
          loadingOlder: false,
        }),
      );
    } catch (error) {
      this.setState(applyContext(this.state, id, this.historyFailure(error)));
    }
  }

  /** The prompt a request carried, fetched the first time its Context tab opens, beside the conversation;
   *  a 404 is the normal answer for a request that carried no capture, so it is remembered as missing. */
  private async ensureCapture(id: string): Promise<void> {
    const held = this.state.capture[id];
    if (held !== undefined && held.status !== "error") return;
    this.setState(applyCapture(this.state, id, { status: "loading" }));
    try {
      const answer = await this.fetchJson<CaptureAnswer>(
        `/api/history/request/${encodeURIComponent(id)}/capture`,
      );
      this.setState(
        applyCapture(this.state, id, {
          status: "ready",
          hash: answer.hash,
          system: answer.system,
          tools: answer.tools,
          bytes: answer.bytes,
          headers: answer.headers,
        }),
      );
    } catch (error) {
      const text = this.describe(error);
      this.setState(
        applyCapture(
          this.state,
          id,
          text.endsWith("→ 404") ? { status: "missing" } : { status: "error", cause: text },
        ),
      );
    }
  }

  /** The page before the one shown, prepended; a failure leaves what is shown and offers the page again. */
  private async loadContextPage(): Promise<void> {
    const id = this.state.request;
    const held = this.readyContext(id);
    if (id === null || held === null || held.next === null || held.loadingOlder) return;
    this.setState(applyContext(this.state, id, { ...held, loadingOlder: true }));
    try {
      const answer = await this.fetchJson<ContextAnswer>(
        `/api/history/context/${encodeURIComponent(id)}?limit=${CONTEXT_PAGE}` +
          `&cursor=${encodeURIComponent(held.next)}`,
      );
      this.patchContext(id, (current) => ({
        ...current,
        messages: [...answer.messages, ...current.messages],
        next: answer.next,
        loadingOlder: false,
      }));
    } catch {
      this.patchContext(id, (current) => ({ ...current, loadingOlder: false }));
    }
  }

  /** The open request's loaded conversation, or null when there is none to extend. */
  private readyContext(id: string | null): Extract<ContextState, { status: "ready" }> | null {
    const held = id === null ? undefined : this.state.context[id];
    return held?.status === "ready" ? held : null;
  }

  /** Patch the loaded conversation under its id; a request switched away mid-flight leaves it stored. */
  private patchContext(
    id: string,
    patch: (ready: Extract<ContextState, { status: "ready" }>) => ContextState,
  ): void {
    const current = this.state.context[id];
    if (current?.status !== "ready") return;
    this.setState(applyContext(this.state, id, patch(current)));
  }

  /** The history store's size, the retention in force, and the ended-session count the History tab's
   *  badge reads before the tab is ever opened; 503 only when history is off. */
  private async loadHistoryStats(): Promise<void> {
    try {
      const stats = await this.fetchJson<{
        bytes: number;
        nodes: number;
        requests: number;
        roots: number;
        retentionDays: number;
      }>("/api/history/stats");
      this.setState({ ...this.state, historyStats: stats, historyOff: false });
    } catch (error) {
      if (this.describe(error).endsWith("→ 503")) this.setState({ ...this.state, historyOff: true });
    }
  }

  /** One retention choice, saved like any setting and reflected in the stats card at once. */
  private async saveRetention(value: string): Promise<void> {
    if (!RETENTION_VALUES.has(value)) return;
    const days = Number.parseInt(value, 10);
    try {
      const saved = await this.sendJson<{ settings: Settings }>("PUT", "/api/settings", {
        historyRetentionDays: days,
      });
      this.setState({
        ...this.state,
        settings: saved.settings,
        historyStats:
          this.state.historyStats === null ? null : { ...this.state.historyStats, retentionDays: days },
        formMessage: { tone: "ok", text: "Retention saved." },
      });
    } catch (error) {
      this.setState({
        ...this.state,
        formMessage: { tone: "err", text: `Not saved: ${this.describe(error)}` },
      });
    }
  }

  /** Wipe the history store, then start the rail and the stats card over. */
  private async clearHistory(): Promise<void> {
    try {
      await this.sendJson("POST", "/api/history/clear", {});
      this.setState({
        ...this.state,
        historyRoots: [],
        historyNext: null,
        historyFetched: null,
        formMessage: { tone: "ok", text: "History cleared." },
      });
      void this.loadHistoryStats();
    } catch (error) {
      this.setState({
        ...this.state,
        formMessage: { tone: "err", text: `Not cleared: ${this.describe(error)}` },
      });
    }
  }

  /** What the tab on screen needs beyond the stream. */
  async loadTab(tab: Tab): Promise<void> {
    if (tab === "costs") await this.loadAttribution();
    if (tab === "router") await this.loadRouter();
    if (tab === "settings") await this.loadSettings();
    if (tab === "agents") await this.ensureDetails();
    if (tab === "models") await this.ensureModels();
  }

  private async saveBudgets(budgets: Budget[], done: string): Promise<boolean> {
    try {
      const saved = await this.sendJson<{ budgets: Budget[] }>("PUT", "/api/budgets", { budgets });
      this.setState({
        ...this.state,
        budgets: saved.budgets,
        draft: null,
        formMessage: { tone: "ok", text: done },
      });
      void this.pollInsights();
      return true;
    } catch (error) {
      this.setState({
        ...this.state,
        formMessage: { tone: "err", text: `Not saved: ${this.describe(error)}` },
      });
      return false;
    }
  }

  private async saveDraft(): Promise<void> {
    const draft = this.state.draft;
    if (draft === null) return;
    const budget = budgetFromDraft(draft, `b${this.io.now().toString(36)}`);
    if (typeof budget === "string") {
      this.setState({ ...this.state, draft, formMessage: { tone: "err", text: budget } });
      return;
    }
    await this.saveBudgets(
      withBudget(this.state.budgets ?? [], budget),
      draft.id === null ? "Budget added." : "Budget saved.",
    );
  }

  private async toggleNotifications(): Promise<void> {
    const next = !(this.state.settings?.notifications ?? true);
    try {
      const saved = await this.sendJson<{ settings: Settings }>("PUT", "/api/settings", {
        notifications: next,
      });
      this.setState({ ...this.state, settings: saved.settings, formMessage: null });
    } catch (error) {
      this.setState({
        ...this.state,
        formMessage: { tone: "err", text: `Not saved: ${this.describe(error)}` },
      });
    }
  }

  /** Load the first pages of requests/events before the stream attaches (the stream only sends new
   *  ones). One at a time: a refresh landing on an in-flight backfill waits for it instead of
   *  fetching the same three lists twice back to back. */
  async refetch(): Promise<void> {
    if (this.backfillInFlight) return;
    this.backfillInFlight = true;
    try {
      const [requests, events, tools] = await Promise.all([
        this.fetchJson<{ requests: RequestRecord[] }>("/api/requests?limit=1000"),
        this.fetchJson<{ events: EventRecord[] }>("/api/events?limit=500"),
        this.fetchJson<{ tools: ToolCallRecord[] }>("/api/tools?limit=1000"),
      ]);
      this.setState(
        applyBackfill(
          { ...this.state, error: null },
          { requests: requests.requests, events: events.events, tools: tools.tools },
        ),
      );
    } finally {
      this.backfillInFlight = false;
    }
  }

  /**
   * The per-session details the views in front of the reader actually show: the picked session, the
   * ones the live rail expanded, and — on the agents tab — the few most recent whose trees it draws.
   * Never every session the requests mention: a snapshot used to fetch one detail per session here,
   * jobs included, and each of those builds a full session view server-side. The requests tables
   * fall back to an agent's id until its session's detail happens to be held. The agents tab's sessions
   * refetch a stale copy: a held detail is replaced when its live word or live rows no longer match the list
   * item's, or, all matching, once it is a refresh window old.
   */
  private async ensureDetails(): Promise<void> {
    const listed = new Map(this.state.sessions.map((item) => [item.id, item] as const));
    const ids = detailIds(this.state);
    for (const id of ids) {
      const item = listed.get(id);
      if (item !== undefined && this.detailIsStale(item)) await this.fetchDetail(id);
    }
  }

  /** Whether the agents tab's held copy of a session's detail no longer matches its list item, or is a refresh
   *  window old while the session is live. */
  private detailIsStale(target: { id: string; live: boolean; liveAgentCount: number }): boolean {
    const held = this.state.details[target.id];
    if (held === undefined) return true;
    if (held.live !== target.live) return true;
    if (held.agents.filter((agent) => agent.live).length !== target.liveAgentCount) return true;
    return target.live && this.io.now() - (this.detailAt[target.id] ?? 0) >= DETAIL_REFRESH_MS;
  }

  /** One SSE message as data, or null when it is not JSON. */
  private parseMessage(raw: string): StreamMessage | null {
    try {
      return JSON.parse(raw) as StreamMessage;
    } catch {
      return null;
    }
  }

  private attachStream(): void {
    const source = new this.io.EventSource("/api/stream");
    this.stream = source;
    source.onopen = () => {
      const reopened = this.streamOpened;
      this.streamOpened = true;
      this.setState({ ...this.state, connected: true, error: null });
      if (reopened) void this.refetch();
    };
    source.onerror = () => this.setState({ ...this.state, connected: false });
    source.onmessage = (message: { data: string }) => {
      const parsed = this.parseMessage(message.data);
      if (parsed === null) return;
      this.setState(applyMessage(this.state, parsed));
      if (parsed.type === "snapshot" || parsed.type === "sessions") void this.ensureDetails();
      if (parsed.type === "request") this.refreshTranscriptFor(parsed.request);
    };
  }

  /* --------------------------------- boot -------------------------------- */

  /** The boot sequence without the DOM wiring: prime the polled data, backfill, attach the stream, poll. */
  start(): void {
    this.io.applyTheme(this.state.theme);
    void this.pollInsights();
    void this.loadTab(this.state.tab);
    // the History tab's badge reads the store's ended-session count from the first snapshot on,
    // whatever panel the reader starts on; the tab's own page loads only once it is opened
    void this.loadHistoryStats();
    this.loadPanel();
    if (this.state.historyScope !== null) void this.loadScopeRequests();
    if (this.state.agentNode !== null) void this.openTranscript(this.state.agentNode);
    void this.ensureFlow();
    this.refetch()
      .then(() => this.attachStream())
      .catch((error: unknown) => {
        this.setState({ ...this.state, error: this.describe(error) });
        this.attachStream(); // the stream may still come up (server restarting, say)
      });
    this.pollTimer = this.io.setInterval(() => {
      void this.pollInsights();
      if (this.state.tab === "costs" || this.state.tab === "router") void this.loadTab(this.state.tab);
    }, POLL_EVERY_MS);
    this.syncRefreshTimer();
  }

  /** Undo start(): no timers, no stream. */
  stop(): void {
    if (this.notifyTimer !== null) {
      this.io.clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    if (this.searchTimer !== null) {
      this.io.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.pollTimer !== null) {
      this.io.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.refreshTimer !== null) {
      this.io.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.stream?.close();
    this.stream = null;
  }
}
