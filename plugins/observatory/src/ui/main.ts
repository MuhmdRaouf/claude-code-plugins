/**
 * The browser entry: backfill once, attach the SSE stream, then re-render from pure state once a second.
 * Interaction is delegated data-action clicks (Enter/Space on focusable rows too) plus two keys: R refreshes,
 * Esc closes the drawer. The tab lives in the URL hash so views can be bookmarked; the theme choice lives in
 * localStorage. The token total counts up and the chart shows a crosshair + per-kind tooltip computed from
 * the same bucket math as render.
 */

import type { Alert } from "../alerts/engine.ts";
import type { Budget, BudgetStatus } from "../budget/budgets.ts";
import type { AdvisorReport } from "../cost/advisor.ts";
import type { AttributionBy, AttributionRange, AttributionRow } from "../cost/attribution.ts";
import type { RouterHealth } from "../router/health.ts";
import type { Settings } from "../server/settings.ts";
import {
  type EventRecord,
  type RequestRecord,
  type SessionView,
  type ToolCallRecord,
  totalTokens,
} from "../shared/model.ts";
import { bucketizeTokenKinds, nearestIndex } from "./chart.ts";
import { mountInto } from "./dom.ts";
import { attributionCsv, exportName, requestsCsv, toolsCsv } from "./export.ts";
import { fmtClock, fmtNum, fmtTokens } from "./fmt.ts";
import { type Range, TOKEN_KINDS } from "./palette.ts";
import { bucketSpanMs, renderApp, TABS } from "./render.ts";
import {
  type AttributionSortKey,
  applyBackfill,
  applyDetail,
  applyMessage,
  type BudgetDraft,
  budgetFromDraft,
  type ClientState,
  detailTargets,
  draftOf,
  initialClientState,
  newDraft,
  nextSort,
  type RequestSortKey,
  type StreamMessage,
  selectedSession,
  type Tab,
  type ThemePref,
  type TimeMode,
  type ToolSortKey,
  tableAttribution,
  tableRequests,
  tableTools,
  visibleRequests,
  withBudget,
} from "./state.ts";

const RANGES: Range[] = ["5m", "1h", "24h"];
const THEME_KEY = "observatory-theme";
const TIME_KEY = "observatory-time";

const queried = document.querySelector<HTMLElement>("#root");
if (queried === null) throw new Error("observatory: #root missing");
// annotated non-null so the closures below capture a stable HTMLElement, not the nullable query result
const root: HTMLElement = queried;
root.classList.remove("boot"); // the static "starting" splash centres itself; the dashboard does not
const displayUrl = location.host === "" ? "127.0.0.1" : location.host;

let state: ClientState = {
  ...initialClientState(),
  tab: tabFromHash(),
  theme: savedTheme(),
  timeMode: savedTimeMode(),
};
/** numeric hero value currently on screen; the count-up animates from here */
let heroShown = 0;
/** the hero chart's current buckets, refreshed on every paint so hover math matches what is drawn */
let chart: { series: number[][]; range: Range; now: number } | null = null;
let tip: HTMLDivElement | null = null;
let cross: HTMLDivElement | null = null;

/* ---------------------------------- render --------------------------------- */

/** True while the reader is typing in a field: a repaint would swap the input out from under the caret. */
function typing(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && root.contains(active);
}

function paint(): void {
  if (typing()) return;
  chart = {
    series: bucketizeTokenKinds(visibleRequests(state), state.range, Date.now()),
    range: state.range,
    now: Date.now(),
  };
  mountInto(root, renderApp(state, Date.now(), displayUrl));
  if (pointer === null) hideChartTip();
  else showTipAt(pointer.x, pointer.y);
  animateHero();
}

function setState(next: ClientState): void {
  state = next;
  paint();
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function heroTarget(current: ClientState): number {
  const session = selectedSession(current);
  if (session !== null) return session.tokens;
  return current.summary === null ? 0 : totalTokens(current.summary.tokens);
}

/** Ease the hero number from what is on screen to the new total over 300ms (skipped for reduced motion). */
function animateHero(): void {
  const element = root.querySelector<HTMLElement>('[data-role="hero-value"]');
  if (element === null) return;
  const target = heroTarget(state);
  const from = heroShown;
  if (reducedMotion() || from === target) {
    heroShown = target;
    element.textContent = fmtTokens(target);
    return;
  }
  const startedAt = performance.now();
  const step = (now: number): void => {
    if (heroTarget(state) !== target) return; // a newer paint took over the animation
    const t = Math.min(1, (now - startedAt) / 300);
    const eased = 1 - (1 - t) ** 3;
    heroShown = from + (target - from) * eased;
    element.textContent = fmtTokens(heroShown);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* -------------------------------- chart hover ------------------------------- */

function tipElements(): { tip: HTMLDivElement; cross: HTMLDivElement } {
  if (tip === null || cross === null) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    cross = document.createElement("div");
    cross.className = "chart-cross";
    document.body.append(tip, cross);
  }
  return { tip, cross };
}

function hideChartTip(): void {
  if (tip === null || cross === null) return;
  tip.style.display = "none";
  cross.style.display = "none";
}

/** Where the pointer last hovered the chart, so the once-a-second repaint can put the tooltip back. */
let pointer: { x: number; y: number } | null = null;

function onPointerMove(event: PointerEvent): void {
  pointer = { x: event.clientX, y: event.clientY };
  showTipAt(event.clientX, event.clientY);
}

function showTipAt(clientX: number, clientY: number): void {
  const target = document.elementFromPoint(clientX, clientY);
  if (chart === null || target === null) return;
  const holder = target.closest(".hero-chart");
  const svg = holder?.querySelector("svg") ?? null;
  if (holder === null || svg === null) {
    hideChartTip();
    return;
  }
  const rect = svg.getBoundingClientRect();
  const first = chart.series[0] ?? [];
  const index = nearestIndex(first, clientX - rect.left, rect.width);
  if (index === null) {
    hideChartTip();
    return;
  }
  const bucketTs = chart.now - (first.length - 1 - index) * bucketSpanMs(chart.range);
  const parts = tipElements();
  const lines: HTMLElement[] = [];
  const head = document.createElement("div");
  head.className = "tip-head";
  const total = chart.series.reduce((acc, values) => acc + (values[index] ?? 0), 0);
  head.textContent = `${fmtClock(bucketTs)}  ${fmtTokens(total)} tokens`;
  lines.push(head);
  TOKEN_KINDS.forEach((kind, k) => {
    const line = document.createElement("div");
    line.className = "tip-line";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = kind.color;
    const label = document.createElement("span");
    label.textContent = kind.label;
    const value = document.createElement("span");
    value.className = "tip-value";
    value.textContent = fmtNum(chart?.series[k]?.[index] ?? 0);
    line.append(swatch, label, value);
    lines.push(line);
  });
  parts.tip.replaceChildren(...lines);
  parts.tip.style.display = "block";
  const tipWidth = parts.tip.offsetWidth;
  const left = clientX + 14 + tipWidth > window.innerWidth ? clientX - 14 - tipWidth : clientX + 14;
  parts.tip.style.left = `${Math.max(8, left)}px`;
  parts.tip.style.top = `${rect.top + 8}px`;
  parts.cross.style.display = "block";
  parts.cross.style.left = `${clientX}px`;
  parts.cross.style.top = `${rect.top}px`;
  parts.cross.style.height = `${rect.height}px`;
}

/* -------------------------------- interaction ------------------------------- */

function toggleCollapsed(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The tab named by the URL hash (#requests), else the default. */
function tabFromHash(): Tab {
  const wanted = location.hash.replace(/^#\/?/, "");
  return TABS.find((entry) => entry.id === wanted)?.id ?? "agents";
}

/** On a narrow screen the view sits below the summary; bring its top into sight after a tab change. */
function revealView(): void {
  const view = root.querySelector<HTMLElement>(".view");
  if (view === null || view.getBoundingClientRect().top < window.innerHeight * 0.6) return;
  const topbar = root.querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 0;
  window.scrollTo({
    top: window.scrollY + view.getBoundingClientRect().top - topbar - 12,
    behavior: reducedMotion() ? "auto" : "smooth",
  });
}

/** The drawer's opener, so focus can go back to its row when the drawer closes. */
let drawerOpener: string | null = null;

function openDrawer(id: string): void {
  drawerOpener = id;
  setState({ ...state, request: id });
  root.querySelector<HTMLElement>('[data-key="drawer-close"]')?.focus();
}

function closeDrawer(): void {
  if (state.request === null) return;
  setState({ ...state, request: null });
  const opener = drawerOpener;
  drawerOpener = null;
  if (opener === null) return;
  for (const row of root.querySelectorAll<HTMLElement>('[data-action="drawer"]')) {
    if (row.getAttribute("data-value") === opener) {
      row.focus();
      return;
    }
  }
}

function selectTab(value: string): void {
  const tab = TABS.find((entry) => entry.id === value);
  if (tab === undefined) return;
  if (location.hash !== `#${tab.id}`) history.replaceState(null, "", `#${tab.id}`);
  setState({ ...state, tab: tab.id });
  revealView();
  void loadTab(tab.id);
}

/** One handler per data-action; unknown actions and values are ignored. */
const ACTIONS: Record<string, (value: string) => void> = {
  tab: selectTab,
  session: (value) => {
    setState({ ...state, session: value === "" ? null : value, model: null });
    void ensureDetails();
  },
  range: (value) => {
    if (RANGES.includes(value as Range)) setState({ ...state, range: value as Range });
  },
  model: (value) => setState({ ...state, model: value === "" ? null : value }),
  "tool-filter": (value) => setState({ ...state, toolFilter: value === "failed" ? "failed" : "all" }),
  collapse: (value) => setState({ ...state, collapsed: toggleCollapsed(state.collapsed, value) }),
  drawer: openDrawer,
  "close-drawer": () => closeDrawer(),
  theme: (value) => {
    if (value === "system" || value === "light" || value === "dark") setTheme(value);
  },
  "time-mode": (value) => {
    const timeMode: TimeMode = value === "absolute" ? "absolute" : "relative";
    remember(TIME_KEY, timeMode === "absolute" ? timeMode : null);
    setState({ ...state, timeMode });
  },
  "sort-requests": (value) => {
    if (REQUEST_SORT_KEYS.has(value)) {
      setState({ ...state, requestSort: nextSort(state.requestSort, value as RequestSortKey) });
    }
  },
  "sort-tools": (value) => {
    if (TOOL_SORT_KEYS.has(value))
      setState({ ...state, toolSort: nextSort(state.toolSort, value as ToolSortKey) });
  },
  export: (value) => {
    if (value === "requests") download(exportName("requests", Date.now()), requestsCsv(tableRequests(state)));
    if (value === "tools") download(exportName("tools", Date.now()), toolsCsv(tableTools(state)));
    if (value === "attribution") {
      download(
        exportName(`costs-by-${state.attributionBy}`, Date.now()),
        attributionCsv(state.attributionBy, state.attributionRange, tableAttribution(state)),
      );
    }
  },
  "dismiss-alert": (value) => {
    setState({ ...state, alerts: state.alerts.filter((alert) => alert.id !== value) });
    void sendJson("POST", "/api/alerts/dismiss", { id: value }).catch(() => undefined);
  },
  "attribution-by": (value) => {
    if (!BY_VALUES.has(value)) return;
    setState({ ...state, attributionBy: value as AttributionBy, attribution: null });
    void loadAttribution();
  },
  "attribution-range": (value) => {
    if (!RANGE_VALUES.has(value)) return;
    setState({ ...state, attributionRange: value as AttributionRange, attribution: null });
    void loadAttribution();
  },
  "sort-attribution": (value) => {
    if (ATTRIBUTION_SORT_KEYS.has(value)) {
      setState({
        ...state,
        attributionSort: nextSort(state.attributionSort, value as AttributionSortKey),
      });
    }
  },
  "new-budget": () => setState({ ...state, draft: newDraft(state.providers), formMessage: null }),
  "edit-budget": (value) => {
    const budget = state.budgets?.find((b) => b.id === value);
    if (budget !== undefined) setState({ ...state, draft: draftOf(budget), formMessage: null });
  },
  "cancel-budget": () => setState({ ...state, draft: null, formMessage: null }),
  "save-budget": () => void saveDraft(),
  "remove-budget": (value) =>
    void saveBudgets(
      (state.budgets ?? []).filter((b) => b.id !== value),
      "Budget removed.",
    ),
  "toggle-notifications": () => void toggleNotifications(),
};

const BY_VALUES = new Set<string>(["project", "session", "agent", "model"]);
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

/** Hand the reader a CSV file: an object URL on a throwaway link, revoked once the click has been taken. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Persist a preference; null forgets it. Storage may be off (private mode): the choice then lasts the page. */
function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // no storage: nothing to keep
  }
}

function savedTimeMode(): TimeMode {
  try {
    return localStorage.getItem(TIME_KEY) === "absolute" ? "absolute" : "relative";
  } catch {
    return "relative";
  }
}

function runAction(action: string, value: string): void {
  ACTIONS[action]?.(value);
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function savedTheme(): ThemePref {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

/** Resolve the choice to a palette on <html>; "system" follows prefers-color-scheme. */
function applyTheme(pref: ThemePref): void {
  const resolved = pref === "system" ? (darkQuery.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
}

function setTheme(pref: ThemePref): void {
  applyTheme(pref);
  remember(THEME_KEY, pref === "system" ? null : pref);
  setState({ ...state, theme: pref });
}

darkQuery.addEventListener("change", () => {
  if (state.theme === "system") applyTheme("system");
});

/* ----------------------------------- data ---------------------------------- */

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return (await response.json()) as T;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One of the dashboard's own writes: JSON, same origin; the answer's error text becomes the thrown message. */
async function sendJson<T>(method: "PUT" | "POST", path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `${method} ${path} → ${response.status}`);
  return parsed as T;
}

/** Alerts, budget spend and today's cost: small, polled every 10 s whatever the tab. */
async function pollInsights(): Promise<void> {
  try {
    const [alerts, status, spend] = await Promise.all([
      fetchJson<{ alerts: Alert[] }>("/api/alerts"),
      fetchJson<BudgetStatus>("/api/budget-status"),
      fetchJson<{ todayUsd: number | null }>("/api/spend"),
    ]);
    setState({ ...state, alerts: alerts.alerts, budgetStatus: status, spendToday: spend.todayUsd });
  } catch {
    // the stream's own error banner already says when the server is gone
  }
}

async function loadAttribution(): Promise<void> {
  const by = state.attributionBy;
  const range = state.attributionRange;
  try {
    const answer = await fetchJson<{ rows: AttributionRow[] }>(`/api/attribution?by=${by}&range=${range}`);
    if (state.attributionBy === by && state.attributionRange === range)
      setState({ ...state, attribution: answer.rows });
  } catch {
    // keep what is shown; the next poll retries
  }
}

async function loadRouter(): Promise<void> {
  try {
    const [router, advisor] = await Promise.all([
      fetchJson<RouterHealth>("/api/router"),
      fetchJson<AdvisorReport>("/api/advisor"),
    ]);
    setState({ ...state, router, advisor });
  } catch {
    // keep what is shown
  }
}

async function loadSettings(): Promise<void> {
  try {
    const [budgets, settings] = await Promise.all([
      fetchJson<{ budgets: Budget[]; providers: string[] }>("/api/budgets"),
      fetchJson<{ settings: Settings }>("/api/settings"),
    ]);
    setState({
      ...state,
      budgets: budgets.budgets,
      providers: budgets.providers,
      settings: settings.settings,
    });
  } catch {
    // keep what is shown
  }
}

/** What the tab on screen needs beyond the stream. */
async function loadTab(tab: Tab): Promise<void> {
  if (tab === "costs") await loadAttribution();
  if (tab === "router") await loadRouter();
  if (tab === "settings") await loadSettings();
}

async function saveBudgets(budgets: Budget[], done: string): Promise<boolean> {
  try {
    const saved = await sendJson<{ budgets: Budget[] }>("PUT", "/api/budgets", { budgets });
    setState({ ...state, budgets: saved.budgets, draft: null, formMessage: { tone: "ok", text: done } });
    void pollInsights();
    return true;
  } catch (error) {
    setState({ ...state, formMessage: { tone: "err", text: `Not saved: ${describe(error)}` } });
    return false;
  }
}

async function saveDraft(): Promise<void> {
  const draft = readDraft(state.draft);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // let the result paint
  if (draft === null) return;
  const budget = budgetFromDraft(draft, `b${Date.now().toString(36)}`);
  if (typeof budget === "string") {
    setState({ ...state, draft, formMessage: { tone: "err", text: budget } });
    return;
  }
  await saveBudgets(
    withBudget(state.budgets ?? [], budget),
    draft.id === null ? "Budget added." : "Budget saved.",
  );
}

async function toggleNotifications(): Promise<void> {
  const next = !(state.settings?.notifications ?? true);
  try {
    const saved = await sendJson<{ settings: Settings }>("PUT", "/api/settings", { notifications: next });
    setState({ ...state, settings: saved.settings, formMessage: null });
  } catch (error) {
    setState({ ...state, formMessage: { tone: "err", text: `Not saved: ${describe(error)}` } });
  }
}

/** The draft with the limit as typed right now (typing updates no state, so the field is the truth). */
function readDraft(draft: BudgetDraft | null): BudgetDraft | null {
  if (draft === null) return null;
  const limit = root.querySelector<HTMLInputElement>('[data-field="limit"]');
  return limit === null ? draft : { ...draft, limit: limit.value };
}

/** A select in the budget form changed: keep the choice in the draft. */
function onFieldChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement || target instanceof HTMLInputElement)) return;
  const field = target.getAttribute("data-field");
  const draft = readDraft(state.draft);
  if (field === null || draft === null) return;
  const value = target.value;
  if (field === "scope") setState({ ...state, draft: { ...draft, scope: value } });
  if (field === "period" && RANGE_VALUES.has(value)) {
    setState({ ...state, draft: { ...draft, period: value as BudgetDraft["period"] } });
  }
  if (field === "action" && (value === "warn" || value === "stop")) {
    setState({ ...state, draft: { ...draft, action: value } });
  }
}

/** Load the first pages of requests/events before the stream attaches (the stream only sends new ones). */
async function refetch(): Promise<void> {
  const [requests, events, tools] = await Promise.all([
    fetchJson<{ requests: RequestRecord[] }>("/api/requests?limit=1000"),
    fetchJson<{ events: EventRecord[] }>("/api/events?limit=500"),
    fetchJson<{ tools: ToolCallRecord[] }>("/api/tools?limit=1000"),
  ]);
  setState(
    applyBackfill(
      { ...state, error: null },
      { requests: requests.requests, events: events.events, tools: tools.tools },
    ),
  );
}

/** Session trees need per-session detail; fetched on demand, one in-flight fetch per session. */
const fetching = new Set<string>();

async function ensureDetails(): Promise<void> {
  for (const target of detailTargets(state)) {
    if (state.details[target.id] !== undefined || fetching.has(target.id)) continue;
    fetching.add(target.id);
    try {
      const { session } = await fetchJson<{ session: SessionView }>(
        `/api/sessions/${encodeURIComponent(target.id)}`,
      );
      setState(applyDetail(state, session));
    } catch {
      // leave the "loading tree…" line; the next sessions message retries this id
    } finally {
      fetching.delete(target.id);
    }
  }
}

function parseMessage(raw: string): StreamMessage | null {
  try {
    return JSON.parse(raw) as StreamMessage;
  } catch {
    return null;
  }
}

function attachStream(): void {
  const source = new EventSource("/api/stream");
  source.onopen = () => setState({ ...state, connected: true, error: null });
  source.onerror = () => setState({ ...state, connected: false });
  source.onmessage = (message: MessageEvent<string>) => {
    const parsed = parseMessage(message.data);
    if (parsed === null) return;
    setState(applyMessage(state, parsed));
    if (parsed.type === "snapshot" || parsed.type === "sessions") void ensureDetails();
  };
}

/* ------------------------------------ boot ---------------------------------- */

function actionTarget(event: MouseEvent): Element | null {
  const node = event.target;
  return node instanceof Element ? node.closest("[data-action]") : null;
}

root.addEventListener("click", (event) => {
  const target = actionTarget(event);
  if (target === null) return;
  runAction(target.getAttribute("data-action") ?? "", target.getAttribute("data-value") ?? "");
});

root.addEventListener("change", onFieldChange);
root.addEventListener("focusout", () => {
  // leaving a field lets the repaints that waited on the caret through
  setTimeout(() => paint(), 0);
});

root.addEventListener("pointermove", onPointerMove, { passive: true });
root.addEventListener(
  "pointerleave",
  () => {
    pointer = null;
    hideChartTip();
  },
  { passive: true },
);
window.addEventListener(
  "scroll",
  () => {
    pointer = null;
    hideChartTip();
  },
  { passive: true },
);

/** Enter or Space on a focusable non-button row (table rows) acts like a click. */
root.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement && state.draft !== null) {
    event.preventDefault();
    void saveDraft();
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.tagName === "BUTTON") return;
  const action = target.getAttribute("data-action");
  if (action === null) return;
  event.preventDefault();
  runAction(action, target.getAttribute("data-value") ?? "");
});

window.addEventListener("hashchange", () => {
  const tab = tabFromHash();
  if (tab !== state.tab) {
    setState({ ...state, tab });
    void loadTab(tab);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDrawer();
    return;
  }
  const typing = event.target instanceof HTMLElement && event.target.matches("input, textarea, select");
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "r" || event.key === "R") {
    refetch().catch((error: unknown) => setState({ ...state, error: describe(error) }));
  }
});

setInterval(() => paint(), 1000);
setInterval(() => {
  void pollInsights();
  if (state.tab === "costs" || state.tab === "router") void loadTab(state.tab);
}, 10_000);

applyTheme(state.theme);
paint();
void pollInsights();
void loadTab(state.tab);
refetch()
  .then(() => attachStream())
  .catch((error: unknown) => {
    setState({ ...state, error: describe(error) });
    attachStream(); // the stream may still come up (server restarting, say)
  });
