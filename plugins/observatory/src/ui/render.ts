/**
 * The dashboard shell as a pure function of ClientState → UINode: top bar, summary cards, the token-flow
 * chart, the sessions rail, the active view, the request drawer and the footer. No DOM and no listeners;
 * interactions are data-action / data-value attributes that main.ts delegates. The views themselves live in
 * views.ts; the shared building blocks in kit.ts.
 */

import { type RequestRecord, totalTokens } from "../shared/model.ts";
import { VERSION } from "../shared/version.ts";
import type { SessionListItem } from "../store/store.ts";
import { bucketizeTokenKinds, type ChartLabel, stackedAreaChart, stackedBar } from "./chart.ts";
import { fmtAgo, fmtClock, fmtDuration, fmtNum, fmtPercent, fmtTokens, fmtUptime, fmtUsd } from "./fmt.ts";
import { type IconName, icon } from "./icons.ts";
import { costText, renderAlertStrip, renderBudgetCard } from "./insights.ts";
import { badge, cardHead, code, emptyState, field, iconTile, segmented, status } from "./kit.ts";
import {
  latencyClass,
  providerColor,
  RANGE_MS,
  type Range,
  type StatusTone,
  TOKEN_KINDS,
} from "./palette.ts";
import {
  type ClientState,
  drawerRequest,
  requestCost,
  selectedSession,
  type Tab,
  type ThemePref,
  type TimeMode,
  visibleRequests,
  visibleTools,
} from "./state.ts";
import { el, leaf, type UINode } from "./types.ts";
import { hostOf, renderView, sessionName, timeText } from "./views.ts";

export { hostOf };

export const TABS: { id: Tab; label: string; icon: IconName }[] = [
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

const TIME_MODES: { id: TimeMode; label: string; icon: IconName }[] = [
  { id: "relative", label: "Show relative times (3m ago)", icon: "history" },
  { id: "absolute", label: "Show clock times (12:04:31)", icon: "clock" },
];

const THEMES: { id: ThemePref; label: string; icon: IconName }[] = [
  { id: "system", label: "Match system theme", icon: "monitor" },
  { id: "light", label: "Light theme", icon: "sun" },
  { id: "dark", label: "Dark theme", icon: "moon" },
];

/** The whole dashboard. */
export function renderApp(state: ClientState, now: number, url: string): UINode {
  const children: UINode[] = [renderTopbar(state, now, url)];
  const page: UINode[] = [];
  if (state.error !== null) page.push(renderBanner(state.error));
  if (state.summary === null) {
    page.push(
      el("div", "boot-state", [
        el("span", "spinner", [], { "aria-hidden": "true" }),
        leaf("p", "empty-title", "Connecting to the observatory server"),
        leaf(
          "p",
          "empty-hint",
          "The first snapshot arrives in a moment; the live stream attaches right after.",
        ),
      ]),
    );
  } else {
    const strip = renderAlertStrip(state, now);
    if (strip !== null) page.push(strip);
    page.push(renderStatCards(state));
    const budgets = renderBudgetCard(state);
    if (budgets !== null) page.push(budgets);
    page.push(renderFlow(state, now));
    page.push(
      el("div", "body-grid", [
        el("aside", "sessions card", [renderSessions(state, now)], { "aria-label": "Sessions" }),
        el("section", "view", [renderView(state, now)], { "aria-label": tabLabel(state.tab) }),
      ]),
    );
  }
  children.push(el("main", "page", page), renderFooter(state, now, url));
  children.push(...renderDrawer(state, now));
  return el("div", "app", children);
}

function tabLabel(tab: Tab): string {
  return TABS.find((entry) => entry.id === tab)?.label ?? "View";
}

function renderBanner(message: string): UINode {
  return el(
    "div",
    "banner",
    [
      icon("alert", "icon banner-icon"),
      el("div", "banner-text", [
        leaf("p", "banner-title", "Lost contact with the observatory server"),
        leaf("p", "banner-detail", `${message}. It reconnects on its own; press R to retry now.`),
      ]),
    ],
    { role: "alert" },
  );
}

/* ---------------------------------- top bar --------------------------------- */

function renderTopbar(state: ClientState, now: number, url: string): UINode {
  const summary = state.summary;
  const uptime = summary === null || summary.startedAt === null ? "–" : fmtUptime(summary.startedAt, now);
  const updated = state.updatedAt === null ? "never" : fmtAgo(state.updatedAt, now);
  const tabs = TABS.map((tab): UINode => {
    const active = state.tab === tab.id;
    const count =
      tab.id === "alerts" && state.alerts.length > 0
        ? [leaf("span", "tab-count", fmtNum(state.alerts.length))]
        : [];
    return el(
      "button",
      active ? "tab tab-active" : "tab",
      [icon(tab.icon, "icon"), leaf("span", "", tab.label), ...count],
      {
        type: "button",
        "data-action": "tab",
        "data-value": tab.id,
        ...(active ? { "aria-current": "page" } : {}),
      },
    );
  });
  const iconToggle = (action: string, id: string, label: string, name: IconName, on: boolean): UINode =>
    el("button", on ? "theme-btn theme-on" : "theme-btn", [icon(name, "icon")], {
      type: "button",
      "data-action": action,
      "data-value": id,
      "aria-pressed": on ? "true" : "false",
      "aria-label": label,
      title: label,
    });
  const themeButtons = THEMES.map((theme) =>
    iconToggle("theme", theme.id, theme.label, theme.icon, state.theme === theme.id),
  );
  const timeButtons = TIME_MODES.map((mode) =>
    iconToggle("time-mode", mode.id, mode.label, mode.icon, state.timeMode === mode.id),
  );
  return el("header", "topbar", [
    el("div", "topbar-inner", [
      el("div", "brand", [
        el("span", "brand-mark", [icon("logo", "icon")]),
        leaf("span", "wordmark", "Observatory"),
        leaf("span", "version", `v${VERSION}`),
      ]),
      el("nav", "tabs", tabs, { "aria-label": "Views" }),
      el("div", "topbar-right", [
        el("span", "conn", [state.connected ? status("ok", "Live", true) : status("err", "Offline")]),
        leaf("span", "topbar-fact", `Updated ${updated}`, { title: "Last change from the server" }),
        leaf("span", "topbar-fact", `Up ${uptime}`, { title: "Server uptime" }),
        leaf("span", "topbar-fact code url", url),
        el("div", "theme-switch", timeButtons, { role: "group", "aria-label": "Time format" }),
        el("div", "theme-switch", themeButtons, { role: "group", "aria-label": "Theme" }),
      ]),
    ]),
  ]);
}

/* -------------------------------- stat cards -------------------------------- */

function statCard(iconName: IconName, color: string, title: string, value: string, context: UINode): UINode {
  return el("div", "stat-card card", [
    el("div", "stat-head", [leaf("span", "stat-title", title), iconTile(iconName, color)]),
    leaf("div", "stat-value", value),
    el("div", "stat-context", [context]),
  ]);
}

function plain(text: string): UINode {
  return leaf("span", "context-text", text);
}

/** Estimated spend today (the ledger), with what the selected session or the dashboard window cost. */
function costCard(state: ClientState): UINode {
  const session = selectedSession(state);
  const inView = session === null ? (state.summary?.costUsd ?? null) : (session.costUsd ?? null);
  const where = session === null ? "in this window" : "in this session";
  return statCard(
    "dollar",
    "var(--series-3)",
    "Est. cost today",
    fmtUsd(state.spendToday),
    plain(
      state.spendToday === null && inView === null
        ? "Estimate; Claude models show tokens only"
        : `${inView === null ? "Nothing priced" : fmtUsd(inView)} ${where} (estimate)`,
    ),
  );
}

function renderStatCards(state: ClientState): UINode {
  const summary = state.summary;
  if (summary === null) return el("section", "stat-grid", []);
  const inView = visibleRequests(state).length;
  const toolFailures = visibleTools(state).filter((t) => !t.ok).length;
  const ended = summary.sessions - summary.liveSessions;
  return el("section", "stat-grid", [
    statCard(
      "layers",
      "var(--series-1)",
      "Sessions",
      fmtNum(summary.sessions),
      summary.liveSessions > 0
        ? status("ok", `${fmtNum(summary.liveSessions)} live, ${fmtNum(ended)} ended`, true)
        : status("idle", "None live"),
    ),
    statCard("bot", "var(--series-2)", "Agents", fmtNum(summary.agents), plain("Main agents and subagents")),
    statCard(
      "arrows",
      "var(--series-8)",
      "Requests",
      fmtNum(summary.requests),
      plain(`${fmtNum(inView)} in this view`),
    ),
    statCard(
      "wrench",
      "var(--series-5)",
      "Tool calls",
      fmtNum(summary.toolCalls),
      toolFailures > 0 ? status("err", `${fmtNum(toolFailures)} failed`) : status("ok", "None failed"),
    ),
    statCard(
      "alert",
      "var(--danger)",
      "Errors",
      fmtNum(summary.errors),
      summary.errors > 0 ? status("err", "Needs a look") : status("ok", "All clear"),
    ),
    statCard(
      "timer",
      "var(--series-7)",
      "Latency p95",
      fmtDuration(summary.latencyP95),
      plain(`Median ${fmtDuration(summary.latencyP50)}`),
    ),
    costCard(state),
  ]);
}

/* -------------------------------- token flow -------------------------------- */

/** Total tokens in the current view: the selected session's aggregate, else the summary's. */
function tokensInView(state: ClientState): number {
  const session = selectedSession(state);
  if (session !== null) return session.tokens;
  return state.summary === null ? 0 : totalTokens(state.summary.tokens);
}

const RANGE_NAMES: Record<Range, string> = {
  "5m": "last 5 minutes",
  "1h": "last hour",
  "24h": "last 24 hours",
};

export function rangeLabels(range: Range): ChartLabel[] {
  if (range === "5m")
    return [
      { text: "5 min ago", at: 0 },
      { text: "now", at: 1 },
    ];
  if (range === "1h")
    return [
      { text: "1 h ago", at: 0 },
      { text: "30 min", at: 0.5 },
      { text: "now", at: 1 },
    ];
  return [
    { text: "24 h ago", at: 0 },
    { text: "12 h", at: 0.5 },
    { text: "now", at: 1 },
  ];
}

export function rangeControl(active: Range): UINode {
  return segmented(
    "range",
    "Time range",
    (["5m", "1h", "24h"] as Range[]).map((range) => ({ label: range, value: range, on: active === range })),
  );
}

/** Share of prompt tokens served from cache: cache reads over everything the model read. */
export function cacheHitRate(tokens: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null {
  const read = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return read === 0 ? null : tokens.cacheRead / read;
}

function renderFlow(state: ClientState, now: number): UINode {
  const requests = visibleRequests(state);
  const series = bucketizeTokenKinds(requests, state.range, now);
  const windowTotals = series.map((values) => values.reduce((acc, value) => acc + value, 0));
  const peak = Math.max(
    ...Array.from({ length: series[0]?.length ?? 0 }, (_, index) =>
      series.reduce((acc, values) => acc + (values[index] ?? 0), 0),
    ),
    0,
  );
  const session = selectedSession(state);
  const scope = session === null ? "All sessions" : sessionName(session);
  const hit = cacheHitRate({
    input: windowTotals[0] ?? 0,
    cacheRead: windowTotals[2] ?? 0,
    cacheWrite: windowTotals[3] ?? 0,
  });
  const legend = TOKEN_KINDS.map(
    (kind, index): UINode =>
      el("li", "legend-item", [
        leaf("span", "swatch", "", { style: `background:${kind.color}`, "aria-hidden": "true" }),
        leaf("span", "legend-label", kind.label),
        leaf("span", "legend-value", fmtTokens(windowTotals[index] ?? 0)),
      ]),
  );
  return el("section", "flow card", [
    cardHead("coins", "Token flow", `${scope}, ${RANGE_NAMES[state.range]}`, [rangeControl(state.range)]),
    el("div", "flow-body", [
      el("div", "flow-summary", [
        el("div", "flow-total", [
          leaf("span", "flow-value", fmtTokens(tokensInView(state)), { "data-role": "hero-value" }),
          leaf(
            "span",
            "flow-unit",
            session === null ? "tokens across every session" : "tokens in this session",
          ),
        ]),
        el("ul", "legend", legend, { "aria-label": `Tokens in the ${RANGE_NAMES[state.range]}` }),
        leaf(
          "p",
          "flow-note",
          hit === null
            ? "No cache reads in this window"
            : `${fmtPercent(hit)} of prompt tokens came from cache`,
        ),
      ]),
      el(
        "div",
        "hero-chart",
        [
          stackedAreaChart({
            series: TOKEN_KINDS.map((kind, index) => ({ values: series[index] ?? [], color: kind.color })),
            width: 720,
            height: 168,
            xLabels: rangeLabels(state.range),
            yLabel: peak > 0 ? `${fmtTokens(peak)} per ${bucketWord(state.range)}` : null,
          }),
        ],
        { role: "img", "aria-label": `Stacked token chart for the ${RANGE_NAMES[state.range]}` },
      ),
    ]),
  ]);
}

function bucketWord(range: Range): string {
  return range === "5m" ? "5 s" : range === "1h" ? "minute" : "24 min";
}

/* ---------------------------------- sessions -------------------------------- */

function sessionRow(state: ClientState, item: SessionListItem, now: number): UINode {
  const active = state.session === item.id;
  const at = (ts: number): string => {
    const shown = timeText(state, ts, now).text;
    return state.timeMode === "absolute" ? `at ${shown}` : shown;
  };
  const when =
    item.live || item.endedAt === null
      ? item.startedAt === null
        ? "Start not recorded"
        : `Started ${at(item.startedAt)}`
      : `Ended ${at(item.endedAt)}`;
  return el(
    "button",
    active ? "session-row session-active" : "session-row",
    [
      item.live ? status("ok", "Live", true) : status("idle", "Ended"),
      el("span", "session-main", [
        leaf("span", "session-name", sessionName(item)),
        el("span", "session-sub", [
          leaf("span", "", when),
          ...(item.model === null ? [] : [code(item.model, "session-model")]),
        ]),
      ]),
      el("span", "session-figures", [
        leaf("span", "session-tokens", fmtTokens(item.tokens)),
        ...(item.costUsd === undefined || item.costUsd === null
          ? []
          : [leaf("span", "session-cost", fmtUsd(item.costUsd), { title: "Estimated cost at list price" })]),
      ]),
    ],
    {
      type: "button",
      "data-action": "session",
      "data-value": item.id,
      "aria-pressed": active ? "true" : "false",
    },
  );
}

function renderSessions(state: ClientState, now: number): UINode {
  const allActive = state.session === null;
  const live = state.sessions.filter((s) => s.live).length;
  const head = cardHead(
    "layers",
    "Sessions",
    `${fmtNum(state.sessions.length)} tracked, ${fmtNum(live)} live`,
  );
  if (state.sessions.length === 0) {
    return el("div", "", [
      head,
      emptyState(
        "No sessions yet",
        "Start a Claude Code session and it shows up here within a second.",
        "layers",
      ),
    ]);
  }
  const total = state.sessions.reduce((acc, s) => acc + s.tokens, 0);
  const rows: UINode[] = [
    el(
      "button",
      allActive ? "session-row session-all session-active" : "session-row session-all",
      [
        el("span", "session-all-icon", [icon("layers", "icon")]),
        el("span", "session-main", [leaf("span", "session-name", "All sessions")]),
        leaf("span", "session-tokens", fmtTokens(total)),
      ],
      {
        type: "button",
        "data-action": "session",
        "data-value": "",
        "aria-pressed": allActive ? "true" : "false",
      },
    ),
  ];
  const ordered = [...state.sessions].sort((a, b) => Number(b.live) - Number(a.live) || b.lastAt - a.lastAt);
  for (const item of ordered) rows.push(sessionRow(state, item, now));
  return el("div", "", [head, el("div", "session-list", rows, { "data-key": "sessions" })]);
}

/* ----------------------------------- drawer --------------------------------- */

function tokenTile(label: string, value: number, color: string): UINode {
  return el("div", "token-tile", [
    el("span", "token-label", [
      leaf("span", "swatch", "", { style: `background:${color}`, "aria-hidden": "true" }),
      leaf("span", "", label),
    ]),
    leaf("span", "token-num", fmtNum(value)),
  ]);
}

function latencyTone(ratio: number): StatusTone {
  return ratio < 0.6 ? "ok" : ratio < 0.8 ? "warn" : "err";
}

function latencyBlock(request: RequestRecord, p95: number | null): UINode[] {
  const ratio = request.latencyMs === null || p95 === null || p95 <= 0 ? null : request.latencyMs / p95;
  if (ratio === null) return [field("Latency", fmtDuration(request.latencyMs))];
  const tone = latencyTone(ratio);
  const word =
    tone === "ok" ? "Fast for this view" : tone === "warn" ? "Slower than most" : "Among the slowest";
  return [
    el("div", "field", [
      leaf("span", "field-label", "Latency"),
      el("span", "field-value latency-value", [
        leaf("span", "", fmtDuration(request.latencyMs)),
        badge(word, tone),
      ]),
    ]),
    stackedBar([{ value: Math.min(1, Math.max(0.02, ratio)), color: latencyClass(ratio) }], 1),
    leaf("p", "field-hint", `Measured against the view's p95 of ${fmtDuration(p95)}.`),
  ];
}

function renderDrawer(state: ClientState, now: number): UINode[] {
  const request = drawerRequest(state);
  if (request === null) return [leaf("div", "drawer-hidden", "")];
  const session = state.sessions.find((s) => s.id === request.sessionId);
  const p95 = state.summary?.latencyP95 ?? null;
  const t = request.tokens;
  return [
    leaf("div", "scrim", "", { "data-action": "close-drawer", "aria-hidden": "true" }),
    el(
      "aside",
      "drawer",
      [
        el("div", "drawer-head", [
          el("div", "drawer-heading", [
            leaf("span", "card-sub", "Request"),
            leaf("h2", "drawer-title code", request.model, { id: "drawer-title" }),
          ]),
          el("button", "icon-btn", [icon("close", "icon")], {
            type: "button",
            "data-action": "close-drawer",
            "aria-label": "Close request details",
            "data-key": "drawer-close",
          }),
        ]),
        el("div", "drawer-body", [
          el("div", "drawer-badges", [
            el("span", "provider", [
              leaf("span", "swatch", "", {
                style: `background:${providerColor(request.provider)}`,
                "aria-hidden": "true",
              }),
              leaf("span", "", request.provider),
            ]),
            request.stopReason === null ? badge("No stop reason", "idle") : badge(request.stopReason, "info"),
          ]),
          field("When", `${fmtClock(request.ts)}, ${fmtAgo(request.ts, now)}`),
          ...latencyBlock(request, p95),
          el("div", "token-head", [
            leaf("span", "field-label", "Tokens"),
            leaf("span", "token-total", fmtNum(totalTokens(t))),
          ]),
          el("div", "token-grid", [
            tokenTile("Input", t.input, TOKEN_KINDS[0].color),
            tokenTile("Output", t.output, TOKEN_KINDS[1].color),
            tokenTile("Cache read", t.cacheRead, TOKEN_KINDS[2].color),
            tokenTile("Cache write", t.cacheWrite, TOKEN_KINDS[3].color),
          ]),
          field("Est. cost", costText(requestCost(request))),
          field("Upstream", hostOf(request.upstream), true),
          ...(session === undefined ? [] : [field("Project", sessionName(session))]),
          field("Session", request.sessionId, true),
          field("Agent", request.agentId, true),
          field("Request id", request.id, true),
        ]),
      ],
      { role: "dialog", "aria-labelledby": "drawer-title" },
    ),
  ];
}

/* ----------------------------------- footer --------------------------------- */

function renderFooter(state: ClientState, now: number, url: string): UINode {
  return el("footer", "footer", [
    el("span", "footer-keys", [
      leaf("kbd", "", "R"),
      leaf("span", "", "refresh"),
      leaf("kbd", "", "Esc"),
      leaf("span", "", "close details"),
    ]),
    leaf("span", "footer-note", "The live stream reconnects on its own."),
    leaf("span", "footer-facts", footerFacts(state, now, url)),
    leaf("span", "footer-right", `Observatory v${VERSION}${state.connected ? "" : ", offline"}`),
  ]);
}

/** The top bar's server facts, repeated for narrow screens where the top bar has no room for them. */
function footerFacts(state: ClientState, now: number, url: string): string {
  const startedAt = state.summary?.startedAt ?? null;
  const uptime = startedAt === null ? "–" : fmtUptime(startedAt, now);
  const updated = state.updatedAt === null ? "never" : fmtAgo(state.updatedAt, now);
  return `Server ${url}, up ${uptime}, updated ${updated}`;
}

/** Bucket width in ms for a range — used by the hover tooltip to translate a bucket to a wall clock. */
export function bucketSpanMs(range: Range): number {
  return RANGE_MS[range] / 60;
}
