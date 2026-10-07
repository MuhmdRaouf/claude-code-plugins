/**
 * The views behind costs, budgets, alerts, router health and settings — the same card, badge, segmented and
 * table vocabulary as the rest of the dashboard, colours only through semantic tokens. Pure: ClientState in,
 * UINode out; every interaction is a data-action main.ts delegates.
 */

import type { Alert, AlertKind } from "../alerts/engine.ts";
import type { Budget, BudgetSpend } from "../budget/budgets.ts";
import type { AttributionBy, AttributionRange, AttributionRow } from "../cost/attribution.ts";
import type { ProviderHealth } from "../router/health.ts";
import { ROUTER_EVENT_KINDS, type RouterEventKind, totalTokens } from "../shared/model.ts";
import { pluginLabel, scopeLabel } from "../shared/provider.ts";
import { areaChart, stackedBar } from "./chart.ts";
import { fmtAgo, fmtCount, fmtNum, fmtTokens, fmtUsd } from "./fmt.ts";
import { type IconName, icon } from "./icons.ts";
import { badge, cardHead, code, emptyState, iconTile, segmented, status } from "./kit.ts";
import { STATUS_COLOR, type StatusTone, TOKEN_KINDS } from "./palette.ts";
import {
  type AttributionSortKey,
  type BudgetDraft,
  type ClientState,
  type Sort,
  tableAttribution,
} from "./state.ts";
import { el, leaf, type UINode } from "./types.ts";

/* ----------------------------------- shared ---------------------------------- */

export const ESTIMATE_NOTE =
  "Estimates at list price from the shared price table; cache reads and writes priced at their own rates. Models it does not know (every claude-* model) show tokens only.";

/** "est. $1.23", or "unpriced" when nothing in it has a price. */
export function costText(cost: number | null | undefined): string {
  return cost === null || cost === undefined ? "unpriced" : `est. ${fmtUsd(cost)}`;
}

function sortButton<K extends string>(
  key: K,
  label: string,
  sort: Sort<K>,
  action: string,
  numeric: boolean,
): UINode {
  const on = sort.key === key;
  const ascending = on && sort.dir === "asc";
  const arrow: IconName = !on ? "chevronsUpDown" : ascending ? "chevronUp" : "chevronDown";
  return el(
    "th",
    numeric ? "num" : "",
    [
      el(
        "button",
        on ? "sort-btn sort-on" : "sort-btn",
        [leaf("span", "", label), icon(arrow, "icon icon-xs")],
        {
          type: "button",
          "data-action": action,
          "data-value": key,
          title: `Sort by ${label.toLowerCase()}`,
        },
      ),
    ],
    { scope: "col", "aria-sort": !on ? "none" : ascending ? "ascending" : "descending" },
  );
}

/* --------------------------------- alert strip -------------------------------- */

const ALERT_META: Record<AlertKind, { icon: IconName; label: string }> = {
  stuck: { icon: "timer", label: "Stuck" },
  loop: { icon: "repeat", label: "Loop" },
  retry_storm: { icon: "wifiOff", label: "Retry storm" },
  context: { icon: "gauge", label: "Context nearly full" },
  budget: { icon: "dollar", label: "Budget" },
};

export function alertLabel(kind: AlertKind): string {
  return ALERT_META[kind].label;
}

function alertWhere(alert: Alert): string {
  if (alert.sessionId === "") return alert.kind === "budget" ? "All sessions" : "Router";
  const project = alert.project === "" ? alert.sessionId.slice(0, 8) : alert.project;
  return alert.agentId === null ? project : `${project}, ${alert.agentId.slice(0, 12)}`;
}

function alertRow(alert: Alert, now: number): UINode {
  const tone: StatusTone = alert.severity === "err" ? "err" : "warn";
  const facts: UINode[] = [
    leaf("span", "", alertWhere(alert)),
    leaf("span", "", `since ${fmtAgo(alert.since, now)}`),
  ];
  if (alert.costUsd !== null) facts.push(leaf("span", "", costText(alert.costUsd)));
  return el("li", `alert-row alert-${tone}`, [
    iconTile(ALERT_META[alert.kind].icon, STATUS_COLOR[tone], "icon-tile icon-tile-sm"),
    el("div", "alert-body", [
      el("div", "alert-line", [
        badge(ALERT_META[alert.kind].label, tone),
        leaf("span", "alert-detail", alert.detail),
      ]),
      el("div", "alert-facts", facts),
    ]),
    el("button", "btn btn-quiet", [icon("close", "icon"), leaf("span", "", "Dismiss")], {
      type: "button",
      "data-action": "dismiss-alert",
      "data-value": alert.id,
      "aria-label": `Dismiss: ${alert.detail}`,
    }),
  ]);
}

/** The strip above the summary: the three loudest alerts, a count, and a way to the full list. */
export function renderAlertStrip(state: ClientState, now: number): UINode | null {
  if (state.alerts.length === 0) return null;
  const shown = state.alerts.slice(0, 3);
  const more = state.alerts.length - shown.length;
  const controls: UINode[] = [
    el(
      "button",
      "btn",
      [leaf("span", "", more > 0 ? `All ${fmtNum(state.alerts.length)} alerts` : "Alerts")],
      {
        type: "button",
        "data-action": "tab",
        "data-value": "alerts",
      },
    ),
  ];
  return el(
    "section",
    "alert-strip card",
    [
      cardHead("bell", "Needs a look", fmtCount(state.alerts.length, "active alert"), controls),
      el(
        "ul",
        "alert-list",
        shown.map((alert) => alertRow(alert, now)),
      ),
    ],
    { "aria-label": "Alerts", role: "region" },
  );
}

/* ----------------------------------- budgets ---------------------------------- */

const PERIOD_NOUN: Record<Budget["period"], string> = {
  day: "today",
  week: "this week",
  month: "this month",
};

export function budgetTone(pct: number): StatusTone {
  if (pct >= 100) return "err";
  if (pct >= 80) return "warn";
  return "ok";
}

function budgetBar(spend: BudgetSpend): UINode {
  const tone = budgetTone(spend.pct);
  const word =
    tone === "err" ? (spend.action === "stop" ? "Stopped" : "Over") : tone === "warn" ? "Near" : "On track";
  return el("div", "rank-row budget-row", [
    el("div", "rank-head", [
      leaf("span", "rank-name", `${scopeLabel(spend.scope)}, ${PERIOD_NOUN[spend.period]}`),
      badge(word, tone),
      leaf("span", "rank-meta", spend.action === "stop" ? "Stops requests at 100%" : "Warns only"),
      leaf(
        "span",
        "rank-total",
        `${fmtUsd(spend.spentUsd)} of ${fmtUsd(spend.limitUsd)} (${Math.round(spend.pct)}%)`,
      ),
    ]),
    stackedBar([{ value: Math.min(spend.pct, 100), color: STATUS_COLOR[tone] }], 100),
  ]);
}

/** The overview's budget progress bars; nothing when no budget is set. */
export function renderBudgetCard(state: ClientState): UINode | null {
  const spend = state.budgetStatus?.spend ?? [];
  if (spend.length === 0) return null;
  return el("section", "card budgets-card", [
    cardHead("dollar", "Budgets", "Estimated spend against each limit", [
      el("button", "btn", [icon("settings", "icon"), leaf("span", "", "Edit")], {
        type: "button",
        "data-action": "tab",
        "data-value": "settings",
      }),
    ]),
    el("div", "rank-list", spend.map(budgetBar)),
  ]);
}

/* ------------------------------------ costs ----------------------------------- */

const BY_LABEL: Record<AttributionBy, string> = {
  project: "Project",
  session: "Session",
  agent: "Agent",
  model: "Model",
};
const RANGE_LABEL: Record<AttributionRange, string> = { day: "Today", week: "7 days", month: "30 days" };

const ATTRIBUTION_COLUMNS: { key: AttributionSortKey; label: string; numeric: boolean }[] = [
  { key: "requests", label: "Requests", numeric: true },
  { key: "input", label: "Input", numeric: true },
  { key: "output", label: "Output", numeric: true },
  { key: "cacheRead", label: "Cache read", numeric: true },
  { key: "cacheWrite", label: "Cache write", numeric: true },
  { key: "cost", label: "Est. cost", numeric: true },
];

function attributionRow(row: AttributionRow, maxCost: number, maxTokens: number): UINode {
  const share =
    row.costUsd !== null && maxCost > 0
      ? stackedBar([{ value: row.costUsd, color: "var(--series-3)" }], maxCost)
      : stackedBar(
          TOKEN_KINDS.map((kind) => ({ value: row.tokens[kind.key], color: kind.color })),
          maxTokens,
        );
  return el("tr", "row", [
    el("td", "attr-label", [leaf("span", "attr-name", row.label, { title: row.key }), share]),
    leaf("td", "num", fmtNum(row.requests)),
    leaf("td", "num", fmtNum(row.tokens.input)),
    leaf("td", "num", fmtNum(row.tokens.output)),
    leaf("td", "num", fmtNum(row.tokens.cacheRead)),
    leaf("td", "num", fmtNum(row.tokens.cacheWrite)),
    el("td", "num", [
      row.costUsd === null
        ? leaf("span", "muted", "tokens only", { title: "No price for these models" })
        : leaf("span", "strong", fmtUsd(row.costUsd), {
            title:
              row.unpriced > 0 ? `${fmtCount(row.unpriced, "request")} unpriced, not included` : "Estimate",
          }),
    ]),
  ]);
}

function attributionTable(state: ClientState): UINode {
  const rows = tableAttribution(state);
  const maxCost = Math.max(...rows.map((r) => r.costUsd ?? 0), 0);
  const maxTokens = Math.max(...rows.map((r) => totalTokens(r.tokens)), 1);
  return el(
    "div",
    "table-wrap",
    [
      el("table", "table attr-table", [
        el("thead", "", [
          el("tr", "", [
            sortButton(
              "label",
              BY_LABEL[state.attributionBy],
              state.attributionSort,
              "sort-attribution",
              false,
            ),
            ...ATTRIBUTION_COLUMNS.map((c) =>
              sortButton(c.key, c.label, state.attributionSort, "sort-attribution", c.numeric),
            ),
          ]),
        ]),
        el(
          "tbody",
          "",
          rows.map((row) => attributionRow(row, maxCost, maxTokens)),
        ),
      ]),
    ],
    { "data-key": "attribution-table" },
  );
}

function costTotals(rows: AttributionRow[]): { cost: number | null; requests: number; tokens: number } {
  let cost: number | null = null;
  for (const row of rows) if (row.costUsd !== null) cost = (cost ?? 0) + row.costUsd;
  return {
    cost,
    requests: rows.reduce((a, r) => a + r.requests, 0),
    tokens: rows.reduce((a, r) => a + totalTokens(r.tokens), 0),
  };
}

export function renderCosts(state: ClientState): UINode {
  const controls = [
    segmented(
      "attribution-by",
      "Group by",
      (["project", "session", "agent", "model"] as AttributionBy[]).map((by) => ({
        label: BY_LABEL[by],
        value: by,
        on: state.attributionBy === by,
      })),
    ),
    segmented(
      "attribution-range",
      "Period",
      (["day", "week", "month"] as AttributionRange[]).map((range) => ({
        label: RANGE_LABEL[range],
        value: range,
        on: state.attributionRange === range,
      })),
    ),
    el("button", "btn", [icon("download", "icon"), leaf("span", "", "Export CSV")], {
      type: "button",
      "data-action": "export",
      "data-value": "attribution",
      title: "Download this table as CSV",
    }),
  ];
  const rows = state.attribution;
  const totals = costTotals(rows ?? []);
  const subtitle =
    rows === null
      ? "Loading"
      : `${RANGE_LABEL[state.attributionRange]}: ${costText(totals.cost)}, ${fmtCount(totals.requests, "request")}, ${fmtTokens(totals.tokens)} tokens`;
  const body =
    rows === null
      ? leaf("p", "tree-note", "Adding up the usage ledger…")
      : rows.length === 0
        ? emptyState(
            "Nothing spent in this period",
            "Every model request lands here, grouped the way you pick, with its tokens and estimated cost.",
            "coins",
          )
        : attributionTable(state);
  return el("div", "stack", [
    el("div", "card", [
      cardHead("coins", "Cost attribution", subtitle, controls),
      body,
      leaf("p", "card-note", ESTIMATE_NOTE),
    ]),
  ]);
}

/* ------------------------------------ alerts ---------------------------------- */

const HOW_ALERTS_WORK: [AlertKind, string][] = [
  [
    "stuck",
    "A live session in the middle of a turn with no model request, tool result or agent event for 10 minutes (30 while a tool is still running). Never raised while Claude Code waits for you: a finished turn, an interruption or a permission prompt all count as waiting.",
  ],
  [
    "loop",
    "The same tool called with the same input 5 times in a row by one agent, the last in the past 30 minutes.",
  ],
  [
    "retry_storm",
    "5 or more rate limits or server errors (429, 5xx) within 2 minutes for one session or router.",
  ],
  [
    "context",
    "An agent's last request used 85% of its context window (200k, or 1M once a session shows it has one), with no compaction since.",
  ],
  ["budget", "A budget reaching 80% of its limit for this period, and again at 100%."],
];

export function renderAlertsView(state: ClientState, now: number): UINode {
  const list =
    state.alerts.length === 0
      ? emptyState(
          "All clear",
          "Nothing looks stuck, looping, throttled, full or over budget right now.",
          "check",
        )
      : el(
          "ul",
          "alert-list",
          state.alerts.map((alert) => alertRow(alert, now)),
        );
  const how = el("div", "card", [
    cardHead("alert", "How alerts work", "Defaults chosen so an idle session never raises one"),
    el(
      "dl",
      "how-list",
      HOW_ALERTS_WORK.flatMap(([kind, text]) => [
        el("dt", "how-term", [icon(ALERT_META[kind].icon, "icon"), leaf("span", "", ALERT_META[kind].label)]),
        leaf("dd", "how-text", text),
      ]),
    ),
    leaf(
      "p",
      "card-note",
      "Dismissing hides that one occurrence; the same thing happening again raises a new alert. Desktop notifications go out for budgets, stuck sessions and loops (turn them off in Settings).",
    ),
  ]);
  return el("div", "stack", [
    el("div", "card", [cardHead("bell", "Alerts", fmtCount(state.alerts.length, "active alert")), list]),
    how,
  ]);
}

/* ------------------------------------ router ---------------------------------- */

const ROUTER_META: Record<RouterEventKind, { label: string; one: string; tone: StatusTone }> = {
  fallback: { label: "Fallbacks", one: "fell back to Anthropic", tone: "warn" },
  refusal: { label: "Refusals", one: "refused a request", tone: "err" },
  rate_limited: { label: "Rate limits", one: "rate limited", tone: "warn" },
  budget_stop: { label: "Budget stops", one: "stopped at a budget", tone: "err" },
  restart: { label: "Restarts", one: "restarted", tone: "info" },
};

function providerCard(provider: ProviderHealth, now: number): UINode {
  const total = provider.series.reduce((a, b) => a + b, 0);
  const counts = ROUTER_EVENT_KINDS.map((kind) => {
    const count = provider.counts[kind];
    return badge(`${ROUTER_META[kind].label} ${fmtNum(count)}`, count > 0 ? ROUTER_META[kind].tone : "idle");
  });
  const last =
    provider.lastAt === null
      ? "No events"
      : `Last ${fmtAgo(provider.lastAt, now)}${provider.lastReason === null ? "" : `: ${provider.lastReason}`}`;
  return el("div", "card router-card", [
    cardHead("route", pluginLabel(provider.plugin), `${fmtCount(total, "event")} in 24 h`),
    el("div", "router-body", [
      el("div", "router-badges", counts),
      el("div", "rate-chart", [
        areaChart({
          values: provider.series,
          width: 520,
          height: 90,
          color: "var(--series-4)",
          gradientId: `router-${provider.plugin.replace(/[^a-z0-9]/gi, "")}`,
          xLabels: [
            { text: "24 h ago", at: 0 },
            { text: "now", at: 1 },
          ],
          yLabel: `${fmtNum(Math.max(...provider.series, 0))} per hour max`,
        }),
      ]),
      leaf("p", "card-note", last),
    ]),
  ]);
}

function advisorCard(state: ClientState): UINode {
  const report = state.advisor;
  const head = cardHead("sparkle", "Model advisor", "Main-model subagent runs that look flash-sized");
  if (report === null) return el("div", "card", [head, leaf("p", "tree-note", "Looking at recent runs…")]);
  if (report.candidates === 0) {
    return el("div", "card", [
      head,
      emptyState(
        report.runsChecked === 0
          ? "No subagent runs on a main model yet"
          : "Every run looked like it needed its model",
        `${fmtCount(report.runsChecked, "run")} checked. A run counts only when it made at most 12 requests, wrote under 8k tokens and used nothing but read-only tools.`,
        "sparkle",
      ),
    ]);
  }
  const rows = report.byModel.map((row) =>
    el("div", "rank-row", [
      el("div", "rank-head", [
        code(row.model, "rank-name"),
        leaf(
          "span",
          "rank-meta",
          `${fmtCount(row.runs, "run")}${row.flash === null ? "" : `, could run on ${row.flash}`}`,
        ),
        leaf(
          "span",
          "rank-total",
          row.costUsd !== null && row.flashCostUsd !== null
            ? `${fmtUsd(row.costUsd)} → ${fmtUsd(row.flashCostUsd)}`
            : "unpriced",
        ),
      ]),
    ]),
  );
  return el("div", "card", [
    head,
    el("div", "advisor-summary", [
      leaf("span", "flow-value", fmtNum(report.candidates)),
      leaf(
        "span",
        "flow-unit",
        `of ${fmtCount(report.runsChecked, "run")} look flash-sized${report.savingUsd === null ? "" : `, est. saving ${fmtUsd(report.savingUsd)}`}`,
      ),
    ]),
    el("div", "rank-list", rows),
    leaf(
      "p",
      "card-note",
      "A hint, not a verdict: few requests, little output and only read-only tools suggest the smaller model would have done. Claude models are counted without a figure.",
    ),
  ]);
}

export function renderRouterView(state: ClientState, now: number): UINode {
  const health = state.router;
  const providers = health?.providers ?? [];
  const top =
    health === null
      ? el("div", "card", [
          cardHead("route", "Router health", null),
          leaf("p", "tree-note", "Loading router events…"),
        ])
      : providers.length === 0
        ? el("div", "card", [
            cardHead("route", "Router health", "Last 24 hours"),
            emptyState(
              "No router events yet",
              "When a provider plugin's router falls back to Anthropic, refuses a request, hits a rate limit, stops at a budget or restarts, it shows up here per provider.",
              "route",
            ),
          ])
        : el(
            "div",
            "split",
            providers.map((provider) => providerCard(provider, now)),
          );
  const recent = (health?.recent ?? []).slice(0, 20).map((event) =>
    el("li", "feed-row", [
      el("span", "feed-icon", [icon("route", "icon")], {
        style: `--tone:${STATUS_COLOR[ROUTER_META[event.event].tone]}`,
      }),
      el("div", "feed-body", [
        el("div", "feed-line", [
          leaf("span", "feed-kind", `${pluginLabel(event.plugin)} ${ROUTER_META[event.event].one}`),
          ...(event.reason === "" ? [] : [leaf("span", "feed-label", event.reason)]),
        ]),
        el("div", "feed-sub", event.model === null ? [] : [code(event.model, "muted")]),
      ]),
      leaf("time", "feed-ts", fmtAgo(event.ts, now)),
    ]),
  );
  const parts: UINode[] = [top];
  if (recent.length > 0) {
    parts.push(
      el("div", "card", [
        cardHead("clock", "Recent router events", "Newest first"),
        el("ol", "feed", recent),
      ]),
    );
  }
  parts.push(advisorCard(state));
  return el("div", "stack", parts);
}

/* ----------------------------------- settings --------------------------------- */

function option(value: string, label: string, selected: boolean): UINode {
  return leaf("option", "", label, { value, ...(selected ? { selected: "selected" } : {}) });
}

function selectField(label: string, field: string, value: string, options: [string, string][]): UINode {
  return el("label", "form-field", [
    leaf("span", "field-label", label),
    el(
      "select",
      "select",
      options.map(([v, l]) => option(v, l, v === value)),
      { "data-field": field, "data-key": `field-${field}` },
    ),
  ]);
}

function budgetForm(state: ClientState, draft: BudgetDraft): UINode {
  const scopes: [string, string][] = [
    ["total", "Total (every provider)"],
    ...state.providers.map((p): [string, string] => [`provider:${p}`, pluginLabel(p)]),
  ];
  if (!scopes.some(([v]) => v === draft.scope)) scopes.push([draft.scope, scopeLabel(draft.scope)]);
  return el("div", "budget-form", [
    el("div", "form-grid", [
      selectField("Scope", "scope", draft.scope, scopes),
      selectField("Period", "period", draft.period, [
        ["day", "Per day"],
        ["week", "Per week (from Monday)"],
        ["month", "Per month"],
      ]),
      el("label", "form-field", [
        leaf("span", "field-label", "Limit (USD)"),
        leaf("input", "input", "", {
          type: "text",
          inputmode: "decimal",
          value: draft.limit,
          "data-field": "limit",
          "data-key": "field-limit",
          "aria-label": "Limit in US dollars",
        }),
      ]),
      selectField("At 100%", "action", draft.action, [
        ["warn", "Warn only"],
        ["stop", "Stop that provider's requests"],
      ]),
    ]),
    el("div", "form-actions", [
      el(
        "button",
        "btn btn-primary",
        [icon("check", "icon"), leaf("span", "", draft.id === null ? "Add budget" : "Save")],
        {
          type: "button",
          "data-action": "save-budget",
        },
      ),
      el("button", "btn", [leaf("span", "", "Cancel")], { type: "button", "data-action": "cancel-budget" }),
    ]),
  ]);
}

function savedBudget(state: ClientState, budget: Budget): UINode {
  const spend = state.budgetStatus?.spend.find((s) => s.id === budget.id);
  const pct = spend?.pct ?? 0;
  const tone = budgetTone(pct);
  return el("div", "rank-row budget-row", [
    el("div", "rank-head", [
      leaf(
        "span",
        "rank-name",
        `${scopeLabel(budget.scope)}, ${fmtUsd(budget.limitUsd)} per ${budget.period}`,
      ),
      badge(budget.action === "stop" ? "Stops at 100%" : "Warns", budget.action === "stop" ? "err" : "info"),
      leaf(
        "span",
        "rank-total",
        spend === undefined ? "–" : `${fmtUsd(spend.spentUsd)} so far (${Math.round(pct)}%)`,
      ),
      el("span", "row-actions", [
        el("button", "icon-btn", [icon("pencil", "icon")], {
          type: "button",
          "data-action": "edit-budget",
          "data-value": budget.id,
          "aria-label": `Edit the ${scopeLabel(budget.scope)} budget`,
        }),
        el("button", "icon-btn", [icon("trash", "icon")], {
          type: "button",
          "data-action": "remove-budget",
          "data-value": budget.id,
          "aria-label": `Remove the ${scopeLabel(budget.scope)} budget`,
        }),
      ]),
    ]),
    stackedBar([{ value: Math.min(pct, 100), color: STATUS_COLOR[tone] }], 100),
  ]);
}

function budgetsPanel(state: ClientState): UINode {
  const budgets = state.budgets;
  const add = el("button", "btn", [icon("plus", "icon"), leaf("span", "", "Add budget")], {
    type: "button",
    "data-action": "new-budget",
  });
  const head = cardHead(
    "dollar",
    "Budgets",
    "Estimated spend per day, week or month",
    state.draft === null ? [add] : [],
  );
  const parts: UINode[] = [head];
  if (state.formMessage !== null) {
    parts.push(
      el(
        "div",
        `form-message form-${state.formMessage.tone}`,
        [status(state.formMessage.tone, state.formMessage.text)],
        {
          role: state.formMessage.tone === "err" ? "alert" : "status",
        },
      ),
    );
  }
  if (state.draft !== null) parts.push(budgetForm(state, state.draft));
  if (budgets === null) parts.push(leaf("p", "tree-note", "Loading budgets…"));
  else if (budgets.length === 0 && state.draft === null) {
    parts.push(
      emptyState(
        "No budgets",
        "Set a limit for everything or for one provider. A warn budget raises an alert at 80% and 100%; a stop budget also makes that provider's router refuse requests until the period ends. Claude requests are never stopped.",
        "dollar",
      ),
    );
  } else
    parts.push(
      el(
        "div",
        "rank-list",
        budgets.map((b) => savedBudget(state, b)),
      ),
    );
  parts.push(leaf("p", "card-note", ESTIMATE_NOTE));
  return el("div", "card", parts);
}

function notificationsPanel(state: ClientState): UINode {
  const on = state.settings?.notifications ?? true;
  return el("div", "card", [
    cardHead("bell", "Desktop notifications", "Budgets at 80% and 100%, new stuck sessions and loops"),
    el("div", "setting-row", [
      el("div", "setting-text", [
        leaf("p", "setting-title", on ? "On" : "Off"),
        leaf(
          "p",
          "field-hint",
          "macOS Notification Center, or notify-send on Linux when it is installed. Each alert notifies once; nothing in them but the project name and what happened.",
        ),
      ]),
      el("button", on ? "switch switch-on" : "switch", [leaf("span", "switch-knob", "")], {
        type: "button",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        "aria-label": "Desktop notifications",
        "data-action": "toggle-notifications",
        "data-key": "notifications-switch",
      }),
    ]),
  ]);
}

export function renderSettings(state: ClientState): UINode {
  return el("div", "stack", [budgetsPanel(state), notificationsPanel(state)]);
}
