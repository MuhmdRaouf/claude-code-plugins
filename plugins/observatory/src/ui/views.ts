/**
 * The five views behind the top-bar tabs, each a pure function of ClientState → UINode: the agents tree,
 * the requests table, tools (ranking + recent calls), the event timeline and the models breakdown.
 */

import { type AgentView, type RequestRecord, type ToolCallRecord, totalTokens } from "../shared/model.ts";
import type { SessionListItem } from "../store/store.ts";
import { areaChart, bucketizeRequests, stackedBar } from "./chart.ts";
import { fmtAgo, fmtClock, fmtCount, fmtDuration, fmtNum, fmtTime, fmtTokens, fmtUsd } from "./fmt.ts";
import { type IconName, icon } from "./icons.ts";
import { costText, renderAlertsView, renderCosts, renderRouterView, renderSettings } from "./insights.ts";
import { badge, cardHead, code, emptyState, iconTile, segmented, status } from "./kit.ts";
import { eventMeta, providerColor, STATUS_COLOR, TOKEN_KINDS } from "./palette.ts";
import {
  type ClientState,
  detailTargets,
  modelsInView,
  type RequestSortKey,
  requestCost,
  type Sort,
  type ToolSortKey,
  tableRequests,
  tableTools,
  visibleEvents,
  visibleRequests,
} from "./state.ts";
import { el, leaf, type UINode } from "./types.ts";

/** The name a person recognises a session by: its project folder, else the first 8 characters of its id. */
export function sessionName(item: { id: string; project: string | null }): string {
  return item.project ?? item.id.slice(0, 8);
}

function nameOfSession(state: ClientState, id: string | null): string {
  if (id === null) return "No session";
  const item = state.sessions.find((s) => s.id === id);
  return item === undefined ? id.slice(0, 8) : sessionName(item);
}

export function renderView(state: ClientState, now: number): UINode {
  if (state.tab === "requests") return renderRequests(state, now);
  if (state.tab === "tools") return renderTools(state, now);
  if (state.tab === "timeline") return renderTimeline(state, now);
  if (state.tab === "models") return renderModels(state, now);
  if (state.tab === "costs") return renderCosts(state);
  if (state.tab === "alerts") return renderAlertsView(state, now);
  if (state.tab === "router") return renderRouterView(state, now);
  if (state.tab === "settings") return renderSettings(state);
  return renderAgents(state);
}

/* ---------------------------------- agents --------------------------------- */

const AGENT_ICON: Record<AgentView["kind"], IconName> = { main: "bot", subagent: "branch", external: "plug" };
const AGENT_TONE: Record<AgentView["kind"], string> = {
  main: "var(--series-1)",
  subagent: "var(--series-2)",
  external: "var(--series-5)",
};

function agentToggle(sessionId: string, agent: AgentView, hasChildren: boolean, collapsed: boolean): UINode {
  if (!hasChildren) return leaf("span", "tree-toggle tree-leaf", "", { "aria-hidden": "true" });
  return el("button", "tree-toggle", [icon(collapsed ? "chevronRight" : "chevronDown", "icon")], {
    type: "button",
    "data-action": "collapse",
    "data-value": `${sessionId}/${agent.id}`,
    "aria-expanded": collapsed ? "false" : "true",
    "aria-label": `${collapsed ? "Expand" : "Collapse"} ${agent.name ?? agent.id}`,
  });
}

function agentRow(
  sessionId: string,
  agent: AgentView,
  depth: number,
  children: UINode[],
  collapsed: boolean,
): UINode {
  const name = agent.name ?? agent.id.slice(0, 10);
  const right: UINode[] = [];
  if (agent.live) right.push(status("ok", "Live", true));
  if (agent.errors > 0) right.push(badge(`${fmtNum(agent.errors)} failed`, "err", "alert"));
  right.push(leaf("span", "tree-reqs", `${fmtNum(agent.requests)} req`));
  right.push(leaf("span", "tree-tokens", fmtTokens(totalTokens(agent.tokens))));
  if (agent.costUsd !== undefined && agent.costUsd !== null) {
    right.push(leaf("span", "tree-cost", costText(agent.costUsd), { title: "Estimate at list price" }));
  }
  return el("div", "agent-node", [
    el(
      "div",
      `tree-row tree-${agent.kind}`,
      [
        agentToggle(sessionId, agent, children.length > 0, collapsed),
        iconTile(AGENT_ICON[agent.kind], AGENT_TONE[agent.kind], "icon-tile icon-tile-sm"),
        el("div", "tree-id", [
          leaf("span", "tree-name", name, { title: name }),
          ...(agent.model === null ? [] : [code(agent.model, "tree-model")]),
        ]),
        el("div", "tree-right", right),
      ],
      { style: `--depth:${depth}` },
    ),
    ...(collapsed ? [] : children),
  ]);
}

function compareAgents(a: AgentView, b: AgentView): number {
  const kindOrder = (k: AgentView["kind"]): number => (k === "main" ? 0 : k === "subagent" ? 1 : 2);
  return kindOrder(a.kind) - kindOrder(b.kind) || (b.lastAt ?? 0) - (a.lastAt ?? 0);
}

/** Agents of one session as a parent/child tree; external agents list separately at the bottom. */
function agentTree(sessionId: string, agents: AgentView[], collapsed: Set<string>): UINode[] {
  const locals = agents.filter((a) => a.kind !== "external");
  const byParent = new Map<string, AgentView[]>();
  for (const agent of locals) {
    const key = agent.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(agent);
    byParent.set(key, list);
  }
  const renderNode = (agent: AgentView, depth: number): UINode => {
    const kids = [...(byParent.get(agent.id) ?? [])]
      .sort(compareAgents)
      .map((kid) => renderNode(kid, depth + 1));
    return agentRow(sessionId, agent, depth, kids, collapsed.has(`${sessionId}/${agent.id}`));
  };
  const rows = [...(byParent.get("") ?? [])].sort(compareAgents).map((root) => renderNode(root, 0));
  const external = agents.filter((a) => a.kind === "external");
  if (external.length > 0) {
    rows.push(leaf("p", "tree-section", `External agents (${fmtNum(external.length)})`));
    for (const agent of external) rows.push(agentRow(sessionId, agent, 0, [], false));
  }
  return rows;
}

function sessionHead(target: SessionListItem, collapsed: boolean): UINode {
  return el(
    "button",
    "tree-head",
    [
      icon(collapsed ? "chevronRight" : "chevronDown", "icon tree-chevron"),
      leaf("span", "tree-head-name", sessionName(target)),
      target.live ? badge("Live", "ok") : badge("Ended", "idle"),
      el("span", "tree-head-facts", [
        leaf("span", "", fmtCount(target.agentCount, "agent")),
        leaf("span", "", fmtCount(target.requestCount, "request")),
        leaf("span", "tree-head-tokens", fmtTokens(target.tokens)),
        ...(target.costUsd === undefined || target.costUsd === null
          ? []
          : [leaf("span", "tree-head-cost", costText(target.costUsd))]),
      ]),
    ],
    {
      type: "button",
      "data-action": "collapse",
      "data-value": `${target.id}/`,
      "aria-expanded": collapsed ? "false" : "true",
    },
  );
}

function renderAgents(state: ClientState): UINode {
  const targets = detailTargets(state);
  if (targets.length === 0) {
    return el("div", "card", [
      cardHead("bot", "Agents", null),
      emptyState(
        "No agents to show",
        "Each session's main agent and its subagents appear here as they run.",
        "bot",
      ),
    ]);
  }
  const blocks = targets.map((target): UINode => {
    const collapsed = state.collapsed.has(`${target.id}/`);
    const detail = state.details[target.id];
    let body: UINode[] = [];
    if (!collapsed) {
      if (detail === undefined) body = [leaf("p", "tree-note", "Loading this session's agents…")];
      else if (detail.agents.length === 0)
        body = [leaf("p", "tree-note", "No agents recorded for this session yet.")];
      else body = [el("div", "tree", agentTree(detail.id, detail.agents, state.collapsed))];
    }
    return el("section", "tree-block card", [sessionHead(target, collapsed), ...body]);
  });
  return el("div", "agents", blocks);
}

/* --------------------------------- requests -------------------------------- */

type Column<K extends string> = { key: K; label: string; numeric?: boolean };

const REQUEST_COLUMNS: Column<RequestSortKey>[] = [
  { key: "time", label: "Time" },
  { key: "agent", label: "Agent" },
  { key: "model", label: "Model" },
  { key: "upstream", label: "Upstream" },
  { key: "latency", label: "Latency", numeric: true },
  { key: "input", label: "Input", numeric: true },
  { key: "output", label: "Output", numeric: true },
  { key: "cacheRead", label: "Cache read", numeric: true },
  { key: "cacheWrite", label: "Cache write", numeric: true },
  { key: "stop", label: "Stop" },
  { key: "cost", label: "Est. cost", numeric: true },
];

function sortHeader<K extends string>(column: Column<K>, sort: Sort<K>, action: string): UINode {
  const on = sort.key === column.key;
  const ascending = on && sort.dir === "asc";
  const arrow: IconName = !on ? "chevronsUpDown" : ascending ? "chevronUp" : "chevronDown";
  const ariaSort = !on ? "none" : ascending ? "ascending" : "descending";
  return el(
    "th",
    column.numeric === true ? "num" : "",
    [
      el(
        "button",
        on ? "sort-btn sort-on" : "sort-btn",
        [leaf("span", "", column.label), icon(arrow, "icon icon-xs")],
        {
          type: "button",
          "data-action": action,
          "data-value": column.key,
          title: `Sort by ${column.label.toLowerCase()}`,
        },
      ),
    ],
    { scope: "col", "aria-sort": ariaSort },
  );
}

/** Sortable column headers: each label is a button; the sorted column carries aria-sort and an arrow. */
function tableHead<K extends string>(columns: Column<K>[], sort: Sort<K>, action: string): UINode {
  return el("thead", "", [
    el(
      "tr",
      "",
      columns.map((column) => sortHeader(column, sort, action)),
    ),
  ]);
}

/** A time cell in the reader's chosen mode, with the other mode as its tooltip. */
export function timeText(state: ClientState, ts: number, now: number): { text: string; title: string } {
  const clock = fmtTime(ts);
  const ago = fmtAgo(ts, now);
  return state.timeMode === "absolute" ? { text: clock, title: ago } : { text: ago, title: clock };
}

function exportButton(kind: string, count: number): UINode {
  return el("button", "btn", [icon("download", "icon"), leaf("span", "", "Export CSV")], {
    type: "button",
    "data-action": "export",
    "data-value": kind,
    title: `Download the ${fmtCount(count, "row")} shown as CSV`,
  });
}

/** Hostname of an upstream URL, or the raw string when it does not parse. */
export function hostOf(upstream: string): string {
  if (upstream === "") return "–";
  try {
    return new URL(upstream).host;
  } catch {
    return upstream;
  }
}

function requestRow(state: ClientState, request: RequestRecord, now: number): UINode {
  const fresh = now - request.ts <= 1500;
  const open = state.request === request.id;
  const cls = `row${fresh ? " row-new" : ""}${open ? " row-active" : ""}`;
  const cells: UINode[] = [
    leaf("td", "time", timeText(state, request.ts, now).text, {
      title: timeText(state, request.ts, now).title,
    }),
    el("td", "", [code(request.agentId.slice(0, 12))]),
    el("td", "", [
      el("span", "model-cell", [
        leaf("span", "swatch", "", {
          style: `background:${providerColor(request.provider)}`,
          "aria-hidden": "true",
        }),
        code(request.model),
      ]),
    ]),
    el("td", "", [code(hostOf(request.upstream), "muted")]),
    leaf("td", "num", fmtDuration(request.latencyMs)),
    leaf("td", "num", fmtNum(request.tokens.input)),
    leaf("td", "num", fmtNum(request.tokens.output)),
    leaf("td", "num", fmtNum(request.tokens.cacheRead)),
    leaf("td", "num", fmtNum(request.tokens.cacheWrite)),
    el("td", "", [
      request.stopReason === null ? leaf("span", "muted", "–") : code(request.stopReason, "muted"),
    ]),
    leaf("td", "num", fmtUsd(requestCost(request))),
  ];
  return el("tr", cls, cells, {
    "data-action": "drawer",
    "data-value": request.id,
    tabindex: "0",
    "aria-label": `${request.model} at ${fmtClock(request.ts)}, open details`,
  });
}

function renderRequests(state: ClientState, now: number): UINode {
  const requests = tableRequests(state);
  const choices = modelsInView(state);
  const filter =
    choices.length > 1
      ? [
          segmented("model", "Filter by model", [
            { label: "All models", value: "", on: state.model === null },
            ...choices.slice(0, 4).map((choice) => ({
              label: choice.model,
              value: choice.model,
              on: state.model === choice.model,
              count: fmtNum(choice.count),
            })),
          ]),
        ]
      : [];
  const shown = requests.slice(0, 300);
  const subtitle =
    requests.length > shown.length
      ? `Newest ${fmtNum(shown.length)} of ${fmtNum(requests.length)}`
      : `${fmtNum(requests.length)} in this view`;
  const head = cardHead("arrows", "Requests", subtitle, [
    ...filter,
    exportButton("requests", requests.length),
  ]);
  if (requests.length === 0) {
    return el("div", "card", [
      head,
      emptyState(
        state.model === null ? "No requests in this view yet" : `No ${state.model} requests in this view`,
        "Model requests stream in live as Claude Code talks to its model. Pick a row to see its tokens and latency.",
        "arrows",
      ),
    ]);
  }
  return el("div", "card", [
    head,
    el(
      "div",
      "table-wrap",
      [
        el("table", "table", [
          tableHead(REQUEST_COLUMNS, state.requestSort, "sort-requests"),
          el(
            "tbody",
            "",
            shown.map((request): UINode => requestRow(state, request, now)),
          ),
        ]),
      ],
      { "data-key": "requests-table" },
    ),
  ]);
}

/* ----------------------------------- tools --------------------------------- */

function toolRow(state: ClientState, tool: ToolCallRecord, now: number): UINode {
  return el("tr", tool.ok ? "row" : "row row-failed", [
    leaf("td", "time", timeText(state, tool.startedAt, now).text, {
      title: timeText(state, tool.startedAt, now).title,
    }),
    el("td", "", [code(tool.name, "strong")]),
    leaf("td", "", nameOfSession(state, tool.sessionId)),
    el("td", "", [code((tool.agentId ?? "main").slice(0, 12), "muted")]),
    leaf("td", "num", fmtDuration(tool.durationMs)),
    el("td", "", [tool.ok ? badge("Succeeded", "ok", "check") : badge("Failed", "err", "close")]),
  ]);
}

const TOOL_COLUMNS: Column<ToolSortKey>[] = [
  { key: "time", label: "Time" },
  { key: "tool", label: "Tool" },
  { key: "session", label: "Session" },
  { key: "agent", label: "Agent" },
  { key: "duration", label: "Duration", numeric: true },
  { key: "result", label: "Result" },
];

function renderTools(state: ClientState, now: number): UINode {
  const ranking = [...(state.models?.tools ?? [])].sort((a, b) => b.count - a.count);
  const maxTool = Math.max(...ranking.map((t) => t.count), 1);
  const rankRows = ranking.map(
    (row): UINode =>
      el("div", "rank-row", [
        el("div", "rank-head", [
          code(row.name, "rank-name"),
          leaf("span", "rank-meta", fmtCount(row.count, "call")),
          row.failures > 0 ? badge(`${fmtNum(row.failures)} failed`, "err") : badge("No failures", "ok"),
        ]),
        stackedBar(
          [
            { value: row.count - row.failures, color: "var(--series-5)" },
            { value: row.failures, color: "var(--danger)" },
          ],
          maxTool,
        ),
      ]),
  );
  const ranked = el("div", "card", [
    cardHead("wrench", "Most used tools", "Every session, success and failure"),
    rankRows.length === 0
      ? emptyState(
          "No tool calls yet",
          "Tool calls appear once an agent reads, edits or runs something.",
          "wrench",
        )
      : el("div", "rank-list", rankRows),
  ]);
  const calls = tableTools(state);
  const all = tableTools({ ...state, toolFilter: "all" });
  const failures = all.filter((t) => !t.ok).length;
  const filter = segmented("tool-filter", "Filter tool calls", [
    { label: "All", value: "all", on: state.toolFilter === "all", count: fmtNum(all.length) },
    { label: "Failed", value: "failed", on: state.toolFilter === "failed", count: fmtNum(failures) },
  ]);
  const shown = calls.slice(0, 300);
  const recent = el("div", "card", [
    cardHead(
      "clock",
      "Recent calls",
      state.toolFilter === "failed" ? "Only the calls that failed" : "Every call in this view",
      [filter, exportButton("tools", calls.length)],
    ),
    shown.length === 0
      ? emptyState(
          state.toolFilter === "failed" ? "No failed tool calls" : "No tool calls in this view",
          state.toolFilter === "failed"
            ? "Every tool call in this view succeeded."
            : "Calls land here as agents use their tools.",
          "check",
        )
      : el(
          "div",
          "table-wrap",
          [
            el("table", "table", [
              tableHead(TOOL_COLUMNS, state.toolSort, "sort-tools"),
              el(
                "tbody",
                "",
                shown.map((tool) => toolRow(state, tool, now)),
              ),
            ]),
          ],
          { "data-key": "tools-table" },
        ),
  ]);
  return el("div", "stack", [ranked, recent]);
}

/* --------------------------------- timeline -------------------------------- */

function timelineRow(
  state: ClientState,
  event: {
    seq: number;
    ts: number;
    kind: string;
    sessionId: string | null;
    agentId: string | null;
    label: string | null;
  },
  now: number,
): UINode {
  const meta = eventMeta(event.kind);
  const where = [nameOfSession(state, event.sessionId), event.agentId ?? "main"];
  const when = timeText(state, event.ts, now);
  const shortId = event.sessionId === null ? [] : [code(event.sessionId.slice(0, 8), "muted")];
  return el("li", `feed-row feed-${meta.tone}`, [
    el("span", "feed-icon", [icon(meta.icon, "icon")], { style: `--tone:${STATUS_COLOR[meta.tone]}` }),
    el("div", "feed-body", [
      el("div", "feed-line", [
        leaf("span", "feed-kind", meta.label, { title: event.kind }),
        ...(event.label === null || event.label === "" ? [] : [leaf("span", "feed-label", event.label)]),
      ]),
      el("div", "feed-sub", [leaf("span", "", where[0] ?? ""), ...shortId, code(where[1] ?? "", "muted")]),
    ]),
    leaf("time", "feed-ts", when.text, {
      title: when.title,
      datetime: new Date(event.ts).toISOString(),
    }),
  ]);
}

function renderTimeline(state: ClientState, now: number): UINode {
  const events = visibleEvents(state);
  const head = cardHead("clock", "Timeline", `${fmtCount(events.length, "event")}, newest first`);
  if (events.length === 0) {
    return el("div", "card", [
      head,
      emptyState(
        "No events in this view",
        "Prompts, subagent starts, stops, compactions and notifications appear here the moment they happen.",
        "clock",
      ),
    ]);
  }
  return el("div", "card", [
    head,
    el(
      "ol",
      "feed",
      events.slice(0, 200).map((event): UINode => timelineRow(state, event, now)),
    ),
  ]);
}

/* ---------------------------------- models --------------------------------- */

function tokenBar(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  max: number,
): UINode {
  return stackedBar(
    TOKEN_KINDS.map((kind) => ({ value: tokens[kind.key], color: kind.color })),
    max,
  );
}

function tokenLegend(): UINode {
  return el(
    "ul",
    "legend legend-inline",
    TOKEN_KINDS.map(
      (kind): UINode =>
        el("li", "legend-item", [
          leaf("span", "swatch", "", { style: `background:${kind.color}`, "aria-hidden": "true" }),
          leaf("span", "legend-label", kind.label),
        ]),
    ),
  );
}

function renderModels(state: ClientState, now: number): UINode {
  const models = state.models;
  if (models === null) {
    return el("div", "card", [
      cardHead("cpu", "Models", null),
      emptyState("Waiting for model totals", "They arrive with the first snapshot from the server.", "cpu"),
    ]);
  }
  const maxTokens = Math.max(...models.models.map((m) => totalTokens(m.tokens)), 1);
  const maxRequests = Math.max(...models.models.map((m) => m.requests), 1);
  const ranked = [...models.models].sort((a, b) => b.requests - a.requests);
  const modelRows = ranked.map(
    (row): UINode =>
      el("div", "rank-row", [
        el("div", "rank-head", [
          code(row.model, "rank-name"),
          el("span", "provider", [
            leaf("span", "swatch", "", {
              style: `background:${providerColor(row.provider)}`,
              "aria-hidden": "true",
            }),
            leaf("span", "rank-provider", row.provider),
          ]),
          leaf(
            "span",
            "rank-meta",
            `${fmtCount(row.requests, "request")}, median ${fmtDuration(row.latencyP50)}, ${costText(row.costUsd)}`,
          ),
          leaf("span", "rank-total", fmtTokens(totalTokens(row.tokens))),
          ...(row.errors > 0 ? [badge(`${fmtNum(row.errors)} failed`, "err")] : []),
        ]),
        el("div", "bar-pair", [
          leaf("span", "bar-label", "Requests"),
          stackedBar([{ value: row.requests, color: providerColor(row.provider) }], maxRequests),
          leaf("span", "bar-label", "Tokens"),
          tokenBar(row.tokens, maxTokens),
        ]),
      ]),
  );
  const modelCard = el("div", "card", [
    cardHead("cpu", "Models", `${fmtCount(ranked.length, "model")}, tokens by kind`, [tokenLegend()]),
    ranked.length === 0
      ? emptyState("No model requests yet", "Each model shows up here after its first request.", "cpu")
      : el("div", "rank-list", modelRows),
  ]);

  const maxUpstream = Math.max(...models.upstreams.map((u) => u.requests), 1);
  const upstreamRows = [...models.upstreams]
    .sort((a, b) => b.requests - a.requests)
    .map(
      (row): UINode =>
        el("div", "rank-row", [
          el("div", "rank-head", [
            code(row.host, "rank-name"),
            leaf("span", "rank-meta", fmtCount(row.requests, "request")),
            leaf("span", "rank-total", fmtTokens(totalTokens(row.tokens))),
          ]),
          stackedBar([{ value: row.requests, color: "var(--series-8)" }], maxUpstream),
        ]),
    );
  const upstreamCard = el("div", "card", [
    cardHead("arrows", "Upstreams", fmtCount(models.upstreams.length, "endpoint")),
    upstreamRows.length === 0
      ? emptyState(
          "No upstreams recorded",
          "Hosts appear once a session reports where it sends requests.",
          "arrows",
        )
      : el("div", "rank-list", upstreamRows),
  ]);

  const counts = bucketizeRequests(visibleRequests(state), state.range, now);
  const rateCard = el("div", "card", [
    cardHead("activity", "Request rate", `Requests per bucket, ${state.range} window`),
    el("div", "rate-chart", [
      areaChart({
        values: counts,
        width: 720,
        height: 120,
        color: "var(--series-2)",
        gradientId: "rate-gradient",
        xLabels: [
          { text: `${state.range} ago`, at: 0 },
          { text: "now", at: 1 },
        ],
        yLabel: `${fmtNum(Math.max(...counts, 0))} max`,
      }),
    ]),
  ]);
  return el("div", "stack models", [modelCard, el("div", "split", [upstreamCard, rateCard])]);
}
