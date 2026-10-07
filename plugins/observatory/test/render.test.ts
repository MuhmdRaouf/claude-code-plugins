import { describe, expect, it } from "vitest";
import { type RequestRecord, type Summary, type ToolCallRecord, ZERO_TOKENS } from "../src/shared/model.ts";
import { VERSION } from "../src/shared/version.ts";
import type { SessionListItem } from "../src/store/store.ts";
import { bucketSpanMs, cacheHitRate, hostOf, rangeLabels, renderApp, TABS } from "../src/ui/render.ts";
import { type ClientState, initialClientState, type ModelsData } from "../src/ui/state.ts";
import type { UINode } from "../src/ui/types.ts";
import { makeAgentView, makeRequest, makeSessionView, makeTool } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const URL = "http://127.0.0.1:41234";

const SUMMARY: Summary = {
  sessions: 3,
  liveSessions: 2,
  agents: 7,
  requests: 12_345,
  tokens: { ...ZERO_TOKENS, input: 1_000, output: 1_500 },
  errors: 2,
  toolCalls: 8,
  latencyP50: 41_000,
  latencyP95: 154_000,
  startedAt: NOW - 125_000,
  now: NOW,
};

const MODELS: ModelsData = {
  models: [
    {
      model: "glm-5.3",
      provider: "Z.ai",
      requests: 3,
      errors: 0,
      tokens: { ...ZERO_TOKENS, output: 900 },
      latencyP50: 120,
    },
    {
      model: "claude-sonnet-5-5",
      provider: "Anthropic",
      requests: 5,
      errors: 1,
      tokens: { ...ZERO_TOKENS, input: 400 },
      latencyP50: 45,
    },
  ],
  upstreams: [
    {
      upstream: "https://api.anthropic.com",
      host: "api.anthropic.com",
      requests: 5,
      tokens: { ...ZERO_TOKENS },
    },
  ],
  tools: [
    { name: "Read", count: 4, failures: 0 },
    { name: "Bash", count: 10, failures: 1 },
  ],
};

function item(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    project: null,
    cwd: null,
    startedAt: null,
    endedAt: null,
    live: false,
    model: null,
    agentCount: 0,
    requestCount: 0,
    tokens: 0,
    lastAt: 0,
    external: false,
    title: null,
    ...over,
  };
}

function stateWith(over: Partial<ClientState> = {}): ClientState {
  return {
    ...initialClientState(),
    summary: SUMMARY,
    models: MODELS,
    connected: true,
    updatedAt: NOW - 5_000,
    ...over,
  };
}

function walk(node: UINode, out: UINode[] = []): UINode[] {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

function byCls(root: UINode, cls: string): UINode[] {
  return walk(root).filter((node) => node.cls === cls);
}

function byTag(root: UINode, tag: string): UINode[] {
  return walk(root).filter((node) => node.tag === tag);
}

/** Class tokens, not whole class strings — most leaves carry "mono x" style compound classes. */
function withToken(root: UINode, token: string): UINode[] {
  return walk(root).filter((node) => (node.cls ?? "").split(" ").includes(token));
}

function withAttr(root: UINode, key: string, value: string): UINode[] {
  return walk(root).filter((node) => node.attrs?.[key] === value);
}

function textOf(node: UINode): string {
  return (node.children ?? []).reduce((acc, child) => acc + textOf(child), node.text ?? "");
}

/** The active view; the sessions rail's empty state precedes it, so empty-state lookups must scope here. */
function panel(root: UINode): UINode {
  return byCls(root, "view")[0] ?? { tag: "section" };
}

function fieldValues(root: UINode): Map<string, string> {
  const map = new Map<string, string>();
  for (const field of byCls(root, "field")) {
    const kids = field.children ?? [];
    map.set(kids[0]?.text ?? "", textOf(kids[1] ?? { tag: "span" }));
  }
  return map;
}

function emptyTitles(root: UINode): string[] {
  return byCls(root, "empty-title").map((node) => node.text ?? "");
}

function icons(root: UINode): string[] {
  return byTag(root, "svg")
    .map((node) => node.attrs?.["data-icon"] ?? "")
    .filter((name) => name !== "");
}

describe("pure helpers", () => {
  it("lists the tabs in order, each with an icon", () => {
    expect(TABS.map((tab) => [tab.id, tab.label, tab.icon])).toEqual([
      ["agents", "Agents", "bot"],
      ["requests", "Requests", "arrows"],
      ["tools", "Tools", "wrench"],
      ["timeline", "Timeline", "clock"],
      ["models", "Models", "cpu"],
      ["costs", "Costs", "coins"],
      ["alerts", "Alerts", "bell"],
      ["router", "Router", "route"],
      ["settings", "Settings", "settings"],
    ]);
  });

  it("reduces an upstream to its host, with fallbacks", () => {
    expect(hostOf("")).toBe("–");
    expect(hostOf("https://api.anthropic.com")).toBe("api.anthropic.com");
    expect(hostOf("http://127.0.0.1:8787")).toBe("127.0.0.1:8787");
    expect(hostOf("not a url")).toBe("not a url");
  });

  it("derives the hover-tooltip bucket width from the range", () => {
    expect(bucketSpanMs("5m")).toBe(5_000);
    expect(bucketSpanMs("1h")).toBe(60_000);
    expect(bucketSpanMs("24h")).toBe(1_440_000);
  });

  it("labels each range's axis in words", () => {
    expect(rangeLabels("5m").map((label) => label.text)).toEqual(["5 min ago", "now"]);
    expect(rangeLabels("1h").map((label) => label.text)).toEqual(["1 h ago", "30 min", "now"]);
    expect(rangeLabels("24h").map((label) => label.text)).toEqual(["24 h ago", "12 h", "now"]);
  });

  it("computes the cache hit rate over everything the model read", () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitRate({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(0.8);
  });
});

describe("renderApp shell", () => {
  it("shows a connecting state instead of the dashboard before the snapshot", () => {
    const app = renderApp(initialClientState(), NOW, URL);
    expect(byCls(app, "boot-state")).toHaveLength(1);
    expect(emptyTitles(app)).toEqual(["Connecting to the observatory server"]);
    expect(byCls(app, "flow card")).toHaveLength(0);
    expect(byCls(app, "stat-grid")).toHaveLength(0);
    expect(byCls(app, "topbar-fact").map((fact) => fact.text)).toEqual(["Updated never", "Up –"]);
    expect(byCls(app, "banner")).toHaveLength(0);
  });

  it("shows an alert banner that says what happened and what to do", () => {
    const app = renderApp(stateWith({ error: "stream lost" }), NOW, URL);
    const banner = byCls(app, "banner")[0] ?? { tag: "div" };
    expect(banner.attrs?.role).toBe("alert");
    expect(icons(banner)).toEqual(["alert"]);
    expect(byCls(banner, "banner-title")[0]?.text).toBe("Lost contact with the observatory server");
    expect(textOf(banner)).toContain("stream lost. It reconnects on its own; press R to retry now.");
  });

  it("renders the top bar: brand, tabs, connection facts and the three-way theme switch", () => {
    const app = renderApp(stateWith({ tab: "requests", theme: "dark" }), NOW, URL);
    expect(byCls(app, "wordmark")[0]?.text).toBe("Observatory");
    expect(byCls(app, "version")[0]?.text).toBe(`v${VERSION}`);
    const tabs = withAttr(app, "data-action", "tab");
    expect(tabs.map((tab) => tab.attrs?.["data-value"])).toEqual([
      "agents",
      "requests",
      "tools",
      "timeline",
      "models",
      "costs",
      "alerts",
      "router",
      "settings",
    ]);
    const current = tabs.filter((tab) => tab.attrs?.["aria-current"] === "page");
    expect(current.map((tab) => tab.attrs?.["data-value"])).toEqual(["requests"]);
    expect(current[0]?.cls).toBe("tab tab-active");
    expect(byCls(app, "tabs")[0]?.attrs?.["aria-label"]).toBe("Views");
    const conn = byCls(app, "conn")[0] ?? { tag: "span" };
    expect(byCls(conn, "status status-ok")).toHaveLength(1);
    expect(withToken(conn, "dot-pulse")).toHaveLength(1);
    expect(textOf(conn)).toBe("Live");
    expect(byCls(app, "topbar-fact").map((fact) => fact.text)).toEqual(["Updated 5s ago", "Up 2m05s"]);
    expect(withToken(app, "url")[0]?.text).toBe(URL);
    const themes = withAttr(app, "data-action", "theme");
    expect(themes.map((button) => button.attrs?.["data-value"])).toEqual(["system", "light", "dark"]);
    expect(themes.map((button) => button.attrs?.["aria-pressed"])).toEqual(["false", "false", "true"]);
    expect(themes.map((button) => button.attrs?.["aria-label"])).toEqual([
      "Match system theme",
      "Light theme",
      "Dark theme",
    ]);
    expect(byCls(app, "theme-switch").map((group) => group.attrs?.["aria-label"])).toEqual([
      "Time format",
      "Theme",
    ]);
    const times = withAttr(app, "data-action", "time-mode");
    expect(times.map((button) => button.attrs?.["data-value"])).toEqual(["relative", "absolute"]);
    expect(times.map((button) => button.attrs?.["aria-pressed"])).toEqual(["true", "false"]);
    expect(times.map((button) => icons(button)[0])).toEqual(["history", "clock"]);

    const offline = renderApp(stateWith({ connected: false }), NOW, URL);
    const offlineConn = byCls(offline, "conn")[0] ?? { tag: "span" };
    expect(byCls(offlineConn, "status status-err")).toHaveLength(1);
    expect(textOf(offlineConn)).toBe("Offline");
    expect(withAttr(offline, "aria-pressed", "true").map((node) => node.attrs?.["data-value"])).toContain(
      "system",
    );
  });
});

describe("summary cards and token flow", () => {
  it("lays out seven summary cards with icon, value and a context line", () => {
    const app = renderApp(stateWith(), NOW, URL);
    const cards = byCls(app, "stat-card card");
    expect(cards).toHaveLength(7);
    expect(byCls(app, "stat-title").map((title) => title.text)).toEqual([
      "Sessions",
      "Agents",
      "Requests",
      "Tool calls",
      "Errors",
      "Latency p95",
      "Est. cost today",
    ]);
    expect(byCls(app, "stat-value").map((value) => value.text)).toEqual([
      "3",
      "7",
      "12,345",
      "8",
      "2",
      "2m34s",
      "–",
    ]);
    expect(cards.map((card) => icons(card)[0])).toEqual([
      "layers",
      "bot",
      "arrows",
      "wrench",
      "alert",
      "timer",
      "dollar",
    ]);
    expect(byCls(app, "context-text").map((sub) => sub.text)).toEqual([
      "Main agents and subagents",
      "0 in this view",
      "Median 41s",
      "Estimate; Claude models show tokens only",
    ]);
    const words = byCls(app, "status-word").map((word) => word.text);
    expect(words).toContain("2 live, 1 ended");
    expect(words).toContain("Needs a look"); // errors > 0
    expect(words).toContain("None failed"); // no failing tools in view

    const failing = renderApp(stateWith({ tools: [makeTool({ ok: false })] }), NOW, URL);
    expect(byCls(failing, "status-word").map((word) => word.text)).toContain("1 failed");
    const calm = renderApp(stateWith({ summary: { ...SUMMARY, liveSessions: 0, errors: 0 } }), NOW, URL);
    const calmWords = byCls(calm, "status-word").map((word) => word.text);
    expect(calmWords).toContain("None live");
    expect(calmWords).toContain("All clear");
  });

  it("totals the view's tokens with a legend, a cache note, a range control and a stacked chart", () => {
    const requests = [
      makeRequest({
        id: "a",
        ts: NOW - 60_000,
        tokens: { input: 100, output: 50, cacheRead: 300, cacheWrite: 100 },
      }),
    ];
    const app = renderApp(stateWith({ requests }), NOW, URL);
    const flow = byCls(app, "flow card")[0] ?? { tag: "section" };
    expect(byCls(flow, "card-title")[0]?.text).toBe("Token flow");
    expect(byCls(flow, "card-sub")[0]?.text).toBe("All sessions, last hour");
    const hero = withAttr(flow, "data-role", "hero-value")[0];
    expect(hero?.text).toBe("2.5k"); // 2500 tokens from the summary
    expect(byCls(flow, "flow-unit")[0]?.text).toBe("tokens across every session");
    expect(byCls(flow, "legend-label").map((label) => label.text)).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Cache write",
    ]);
    expect(byCls(flow, "legend-value").map((value) => value.text)).toEqual(["100", "50", "300", "100"]);
    expect(byCls(flow, "flow-note")[0]?.text).toBe("60% of prompt tokens came from cache");
    const ranges = withAttr(flow, "data-action", "range");
    expect(ranges.map((button) => textOf(button))).toEqual(["5m", "1h", "24h"]);
    expect(
      ranges.filter((button) => button.attrs?.["aria-pressed"] === "true").map((b) => textOf(b)),
    ).toEqual(["1h"]);
    expect(byCls(flow, "chart")).toHaveLength(1);
    expect(byCls(flow, "chart-band")).toHaveLength(4);
    expect(byCls(flow, "chart-ymax")[0]?.text).toBe("550 per minute");
    expect(byCls(flow, "hero-chart")[0]?.attrs?.["aria-label"]).toBe("Stacked token chart for the last hour");

    const quiet = renderApp(stateWith({ range: "5m" }), NOW, URL);
    expect(byCls(quiet, "flow-note")[0]?.text).toBe("No cache reads in this window");
    expect(byCls(quiet, "chart-ymax")).toHaveLength(0);
    expect(byCls(quiet, "card-sub")[0]?.text).toBe("All sessions, last 5 minutes");

    const day = renderApp(stateWith({ range: "24h", requests }), NOW, URL);
    expect(byCls(day, "chart-ymax")[0]?.text).toBe("550 per 24 min");
    const short = renderApp(
      stateWith({ range: "5m", requests: [{ ...(requests[0] as RequestRecord), ts: NOW - 1_000 }] }),
      NOW,
      URL,
    );
    expect(byCls(short, "chart-ymax")[0]?.text).toBe("550 per 5 s");

    const picked = stateWith({ session: "s1", sessions: [item("s1", { tokens: 900, project: "app" })] });
    const pickedApp = renderApp(picked, NOW, URL);
    expect(withToken(pickedApp, "flow-value")[0]?.text).toBe("900");
    expect(byCls(pickedApp, "flow-unit")[0]?.text).toBe("tokens in this session");
    expect(byCls(byCls(pickedApp, "flow card")[0] ?? { tag: "x" }, "card-sub")[0]?.text).toBe(
      "app, last hour",
    );
  });
});

describe("sessions rail", () => {
  const sessions = [
    item("beta-session", { live: false, startedAt: NOW - 7_200_000, endedAt: NOW - 3_600_000, lastAt: 5 }),
    item("alpha-session", {
      project: "app",
      live: true,
      tokens: 2_500,
      model: "claude-sonnet-5-5",
      startedAt: NOW - 600_000,
      lastAt: 1,
    }),
    item("gamma-session", { live: false, lastAt: 9 }),
  ];

  it("offers All sessions plus one row per session, live first, marking the active one", () => {
    const app = renderApp(stateWith({ sessions, session: "alpha-session" }), NOW, URL);
    const rail = byCls(app, "sessions card")[0] ?? { tag: "aside" };
    expect(byCls(rail, "card-sub")[0]?.text).toBe("3 tracked, 1 live");
    expect(byCls(rail, "session-name").map((name) => name.text)).toEqual([
      "All sessions",
      "app",
      "gamma-se",
      "beta-ses",
    ]);
    expect(byCls(rail, "session-tokens").map((tokens) => tokens.text)).toEqual(["2.5k", "2.5k", "0", "0"]);
    expect(byCls(rail, "status-word").map((word) => word.text)).toEqual(["Live", "Ended", "Ended"]);
    const subs = byCls(rail, "session-sub").map((sub) => textOf(sub));
    expect(subs).toEqual(["Started 10m agoclaude-sonnet-5-5", "Start not recorded", "Ended 1h ago"]);
    const active = withToken(rail, "session-active");
    expect(active.map((row) => row.attrs?.["data-value"])).toEqual(["alpha-session"]);
    expect(active[0]?.attrs?.["aria-pressed"]).toBe("true");
    expect(withAttr(rail, "data-value", "")[0]?.attrs?.["aria-pressed"]).toBe("false");
    expect(byCls(rail, "session-list")[0]?.attrs?.["data-key"]).toBe("sessions");

    const all = renderApp(stateWith({ sessions }), NOW, URL);
    expect(withAttr(all, "data-value", "")[0]?.cls).toContain("session-active");
  });

  it("shows the empty state when nothing has spooled yet", () => {
    const app = renderApp(stateWith({ sessions: [] }), NOW, URL);
    const rail = byCls(app, "sessions card")[0] ?? { tag: "aside" };
    expect(emptyTitles(rail)).toEqual(["No sessions yet"]);
    expect(byCls(rail, "empty-hint")[0]?.text).toBe(
      "Start a Claude Code session and it shows up here within a second.",
    );
  });
});

describe("agents view", () => {
  function treeState(over: Partial<ClientState> = {}): ClientState {
    const main = makeAgentView({
      id: "main",
      requests: 5,
      errors: 2,
      live: true,
      lastAt: 99,
      model: "claude-opus-5-5",
    });
    const sub = makeAgentView({
      id: "researcher",
      parentId: "main",
      kind: "subagent",
      name: "researcher",
      live: false,
      lastAt: 80,
    });
    const ext = makeAgentView({
      id: "ext-1",
      parentId: "main", // a transcript sighting may claim even external agents as children
      kind: "external",
      name: "Fix tests",
      requests: 1,
      live: false,
      lastAt: 70,
    });
    const unnamed = makeAgentView({
      id: "abcdefghijklmnop",
      parentId: "main",
      kind: "subagent",
      name: null,
      live: false,
      lastAt: 90,
    });
    return stateWith({
      sessions: [item("s1", { live: true, lastAt: 99, agentCount: 4, requestCount: 6, tokens: 1_200 })],
      details: { s1: makeSessionView({ id: "s1", agents: [ext, sub, main, unnamed] }) },
      ...over,
    });
  }

  it("renders main, subagents and an external section without duplicating externals", () => {
    const app = renderApp(treeState(), NOW, URL);
    const blocks = byCls(app, "tree-block card");
    expect(blocks).toHaveLength(1);
    const block = blocks[0] ?? { tag: "section" };
    expect(byCls(block, "tree-head-name")[0]?.text).toBe("s1");
    expect(textOf(byCls(block, "tree-head-facts")[0] ?? { tag: "x" })).toBe("4 agents6 requests1.2k");
    expect(byCls(block, "badge badge-ok").map((badge) => textOf(badge))).toEqual(["Live"]);
    expect(byCls(block, "tree-name").map((name) => name.text)).toEqual([
      "main",
      "abcdefghij",
      "researcher",
      "Fix tests",
    ]);
    expect(withToken(block, "tree-row").map((row) => row.attrs?.style)).toEqual([
      "--depth:0",
      "--depth:1",
      "--depth:1",
      "--depth:0",
    ]);
    expect(withToken(block, "tree-model").map((model) => model.text)).toEqual(["claude-opus-5-5"]);
    expect(byCls(block, "tree-reqs").map((reqs) => reqs.text)).toEqual(["5 req", "0 req", "0 req", "1 req"]);
    expect(textOf(byCls(block, "badge badge-err")[0] ?? { tag: "x" })).toBe("2 failed");
    expect(byCls(block, "tree-section")[0]?.text).toBe("External agents (1)");
    const tiles = byCls(block, "icon-tile icon-tile-sm").map((tile) => icons(tile)[0]);
    expect(tiles).toEqual(["bot", "branch", "branch", "plug"]);
    const ended = renderApp(treeState({ sessions: [item("s1", { live: false })] }), NOW, URL);
    expect(byCls(ended, "badge badge-idle").map((badge) => textOf(badge))).toEqual(["Ended"]);
  });

  it("collapses agents and whole sessions through the same collapse set", () => {
    const collapsedAgent = renderApp(treeState({ collapsed: new Set(["s1/main"]) }), NOW, URL);
    expect(byCls(collapsedAgent, "tree-name").map((name) => name.text)).toEqual(["main", "Fix tests"]);
    const agentToggle = withAttr(collapsedAgent, "data-value", "s1/main")[0];
    expect(agentToggle?.attrs?.["aria-expanded"]).toBe("false");
    expect(agentToggle?.attrs?.["aria-label"]).toBe("Expand main");
    expect(icons(agentToggle ?? { tag: "x" })).toEqual(["chevronRight"]);
    const collapsedSession = renderApp(treeState({ collapsed: new Set(["s1/"]) }), NOW, URL);
    expect(byCls(collapsedSession, "tree-name")).toHaveLength(0); // body skipped entirely
    expect(byCls(collapsedSession, "tree-note")).toHaveLength(0);
    expect(withAttr(collapsedSession, "data-value", "s1/")[0]?.attrs?.["aria-expanded"]).toBe("false");

    const open = renderApp(treeState(), NOW, URL);
    const toggles = withAttr(open, "data-action", "collapse");
    expect(toggles.map((toggle) => toggle.attrs?.["data-value"])).toEqual(["s1/", "s1/main"]);
    expect(toggles.map((toggle) => toggle.attrs?.["aria-expanded"])).toEqual(["true", "true"]);
    expect(withAttr(open, "data-value", "s1/main")[0]?.attrs?.["aria-label"]).toBe("Collapse main");
  });

  it("waits for missing details, notes empty sessions and empty views", () => {
    const loading = renderApp(stateWith({ sessions: [item("s1")] }), NOW, URL);
    expect(byCls(loading, "tree-note")[0]?.text).toBe("Loading this session's agents…");
    const bare = renderApp(
      stateWith({ sessions: [item("s1")], details: { s1: makeSessionView({ agents: [] }) } }),
      NOW,
      URL,
    );
    expect(byCls(bare, "tree-note")[0]?.text).toBe("No agents recorded for this session yet.");
    const none = renderApp(stateWith(), NOW, URL);
    expect(emptyTitles(panel(none))).toEqual(["No agents to show"]);
    expect(panel(none).attrs?.["aria-label"]).toBe("Agents");
  });
});

describe("requests view", () => {
  function requestsState(over: Partial<ClientState> = {}): ClientState {
    return stateWith({
      tab: "requests",
      requests: [
        makeRequest({ id: "r-fresh", ts: NOW - 1_000, stopReason: "end_turn" }),
        makeRequest({ id: "r-old", ts: NOW - 10_000 }),
      ],
      ...over,
    });
  }

  it("tabulates every column with formatted cells, keyboard-reachable rows and drawer targets", () => {
    const app = renderApp(requestsState({ request: "r-old" }), NOW, URL);
    expect(byTag(app, "th").map((th) => textOf(th))).toEqual([
      "Time",
      "Agent",
      "Model",
      "Upstream",
      "Latency",
      "Input",
      "Output",
      "Cache read",
      "Cache write",
      "Stop",
      "Est. cost",
    ]);
    expect(byTag(app, "th").filter((th) => th.cls === "num")).toHaveLength(6);
    const rows = withAttr(app, "data-action", "drawer").filter((node) => node.tag === "tr");
    expect(rows.map((row) => row.cls)).toEqual(["row row-new", "row row-active"]);
    expect(rows.map((row) => row.attrs?.tabindex)).toEqual(["0", "0"]);
    expect(rows[1]?.attrs?.["aria-label"]).toMatch(/^claude-sonnet-5-5 at \d{2}:\d{2}:\d{2}, open details$/);
    const cells = rows[1]?.children ?? [];
    expect(textOf(cells[1] ?? { tag: "td" })).toBe("main");
    expect(textOf(cells[2] ?? { tag: "td" })).toBe("claude-sonnet-5-5");
    expect(textOf(cells[3] ?? { tag: "td" })).toBe("api.anthropic.com");
    expect(cells[4]?.text).toBe("100ms");
    expect(cells[4]?.cls).toBe("num");
    expect(cells[5]?.text).toBe("10");
    expect(textOf(cells[9] ?? { tag: "td" })).toBe("–"); // no stop reason
    expect(textOf(rows[0]?.children?.[9] ?? { tag: "td" })).toBe("end_turn");
    expect(cells[0]?.text).toBe("10s ago"); // relative by default
    expect(cells[0]?.attrs?.title).toMatch(/^\d{1,2}:\d{2}/); // the wall clock on hover
    const clock = renderApp(requestsState({ timeMode: "absolute" }), NOW, URL);
    const clockCell = withAttr(clock, "data-action", "drawer")[1]?.children?.[0];
    expect(clockCell?.text).toMatch(/^\d{1,2}:\d{2}/);
    expect(clockCell?.attrs?.title).toBe("10s ago");
    expect(rows[1]?.attrs?.["data-value"]).toBe("r-old");
    expect(byCls(app, "table-wrap")[0]?.attrs?.["data-key"]).toBe("requests-table");
    expect(byCls(panel(app), "card-sub")[0]?.text).toBe("2 in this view");
  });

  it("flashes only requests from the last second and a half", () => {
    const app = renderApp(
      requestsState({
        requests: [
          makeRequest({ id: "edge-in", ts: NOW - 1_500 }),
          makeRequest({ id: "edge-out", ts: NOW - 1_501 }),
        ],
        request: null,
      }),
      NOW,
      URL,
    );
    const rows = withAttr(app, "data-action", "drawer").filter((node) => node.tag === "tr");
    expect(rows.map((row) => row.cls)).toEqual(["row row-new", "row"]);
  });

  it("offers a model filter once more than one model is in view, and narrows the table by it", () => {
    const mixed = requestsState({
      requests: [
        makeRequest({ id: "a", ts: NOW - 5_000 }),
        makeRequest({ id: "b", ts: NOW - 6_000, model: "glm-5.3", provider: "Z.ai" }),
        makeRequest({ id: "c", ts: NOW - 7_000, model: "glm-5.3", provider: "Z.ai" }),
      ],
    });
    const app = renderApp(mixed, NOW, URL);
    const filter = withAttr(app, "data-action", "model");
    expect(filter.map((button) => button.attrs?.["data-value"])).toEqual([
      "",
      "glm-5.3",
      "claude-sonnet-5-5",
    ]);
    expect(filter.map((button) => button.attrs?.["aria-pressed"])).toEqual(["true", "false", "false"]);
    expect(byCls(app, "segment-count").map((count) => count.text)).toEqual(["2", "1"]);
    const narrowed = renderApp({ ...mixed, model: "glm-5.3" }, NOW, URL);
    expect(withAttr(narrowed, "data-action", "drawer").map((row) => row.attrs?.["data-value"])).toEqual([
      "b",
      "c",
    ]);
    const gone = renderApp({ ...mixed, model: "kimi-k3" }, NOW, URL);
    expect(emptyTitles(panel(gone))).toEqual(["No kimi-k3 requests in this view"]);
    const single = renderApp(requestsState(), NOW, URL);
    expect(withAttr(single, "data-action", "model")).toHaveLength(0);
  });

  it("caps the table at the newest 300 and says so", () => {
    const many = Array.from({ length: 305 }, (_, i) => makeRequest({ id: `r${i}`, ts: NOW - 10_000 - i }));
    const app = renderApp(requestsState({ requests: many }), NOW, URL);
    expect(withAttr(app, "data-action", "drawer")).toHaveLength(300);
    expect(byCls(panel(app), "card-sub")[0]?.text).toBe("Newest 300 of 305");
  });

  it("shows the empty state before any request streams in", () => {
    const app = renderApp(stateWith({ tab: "requests" }), NOW, URL);
    expect(emptyTitles(panel(app))).toEqual(["No requests in this view yet"]);
  });
});

describe("tools view", () => {
  it("ranks tools by calls with success/failure bars", () => {
    const app = renderApp(stateWith({ tab: "tools" }), NOW, URL);
    const view = panel(app);
    expect(byCls(view, "card-title").map((title) => title.text)).toEqual(["Most used tools", "Recent calls"]);
    expect(withToken(view, "rank-name").map((name) => name.text)).toEqual(["Bash", "Read"]);
    expect(byCls(view, "rank-meta").map((meta) => meta.text)).toEqual(["10 calls", "4 calls"]);
    expect(withToken(view, "badge").map((badge) => textOf(badge))).toEqual(["1 failed", "No failures"]);
    const bars = byCls(view, "bar-track");
    expect(bars[0]?.children?.map((seg) => seg.attrs?.style)).toEqual([
      "width:90.00%;background:var(--series-5)",
      "width:10.00%;background:var(--danger)",
    ]);
    expect(emptyTitles(view)).toEqual(["No tool calls in this view"]);
  });

  it("lists recent calls with a result badge and an all/failed filter", () => {
    const tools = [
      makeTool({ id: "ok", name: "Read", startedAt: NOW - 2_000, ok: true, durationMs: 1_200 }),
      makeTool({
        id: "bad",
        name: "Bash",
        startedAt: NOW - 1_000,
        ok: false,
        agentId: null,
        sessionId: "s1",
      }),
      makeTool({ id: "far", name: "Grep", startedAt: NOW - 3_000, sessionId: "unknown-session-id" }),
      makeTool({ id: "none", name: "Glob", startedAt: NOW - 4_000, sessionId: null as unknown as string }),
    ];
    const state = stateWith({ tab: "tools", tools, sessions: [item("s1", { project: "app" })] });
    const view = panel(renderApp(state, NOW, URL));
    expect(byTag(view, "th").map((th) => textOf(th))).toEqual([
      "Time",
      "Tool",
      "Session",
      "Agent",
      "Duration",
      "Result",
    ]);
    const rows = byTag(view, "tr").filter((row) => row.cls?.startsWith("row"));
    expect(rows.map((row) => row.cls)).toEqual(["row row-failed", "row", "row", "row"]);
    expect(rows.map((row) => textOf(row.children?.[2] ?? { tag: "td" }))).toEqual([
      "app",
      "app",
      "unknown-",
      "No session",
    ]);
    expect(textOf(rows[0]?.children?.[3] ?? { tag: "td" })).toBe("main");
    expect(rows[1]?.children?.[4]?.text).toBe("1.2s");
    expect(rows.map((row) => textOf(row.children?.[5] ?? { tag: "td" }))).toEqual([
      "Failed",
      "Succeeded",
      "Succeeded",
      "Succeeded",
    ]);
    const filter = withAttr(view, "data-action", "tool-filter");
    expect(filter.map((button) => textOf(button))).toEqual(["All4", "Failed1"]);
    expect(byCls(view, "table-wrap")[0]?.attrs?.["data-key"]).toBe("tools-table");

    const failedOnly = panel(renderApp({ ...state, toolFilter: "failed" }, NOW, URL));
    expect(byTag(failedOnly, "tr").filter((row) => row.cls?.startsWith("row"))).toHaveLength(1);
    expect(byCls(failedOnly, "card-sub")[1]?.text).toBe("Only the calls that failed");
    const allGood = panel(
      renderApp({ ...state, tools: [tools[0] as ToolCallRecord], toolFilter: "failed" }, NOW, URL),
    );
    expect(emptyTitles(allGood)).toEqual(["No failed tool calls"]);
    expect(byCls(allGood, "empty-hint")[0]?.text).toBe("Every tool call in this view succeeded.");
  });

  it("explains an empty ranking", () => {
    const view = panel(renderApp(stateWith({ tab: "tools", models: null }), NOW, URL));
    expect(emptyTitles(view)).toEqual(["No tool calls yet", "No tool calls in this view"]);
  });
});

describe("timeline view", () => {
  it("feeds events with an icon, a plain label, the session's name and a relative time", () => {
    const app = renderApp(
      stateWith({
        tab: "timeline",
        sessions: [item("sess-12345678", { project: "app" })],
        events: [
          {
            seq: 1,
            ts: NOW - 60_000,
            kind: "Stop",
            sessionId: "sess-12345678",
            agentId: null,
            label: "end_turn",
            payload: null,
          },
          {
            seq: 2,
            ts: NOW,
            kind: "PostToolUseFailure",
            sessionId: null,
            agentId: "agent-1",
            label: null,
            payload: null,
          },
          {
            seq: 3,
            ts: NOW - 5_000,
            kind: "Odd",
            sessionId: "other-session",
            agentId: null,
            label: "",
            payload: null,
          },
        ],
      }),
      NOW,
      URL,
    );
    const rows = byCls(app, "feed-row feed-idle").concat(byCls(app, "feed-row feed-err"));
    expect(rows).toHaveLength(3);
    expect(byCls(app, "feed-kind").map((kind) => kind.text)).toEqual(["Tool failed", "Odd", "Turn ended"]);
    expect(byCls(app, "feed-kind")[2]?.attrs?.title).toBe("Stop");
    expect(byCls(app, "feed-label").map((label) => label.text)).toEqual(["end_turn"]);
    expect(byCls(app, "feed-sub").map((sub) => textOf(sub))).toEqual([
      "No sessionagent-1",
      "other-seother-semain",
      "appsess-123main",
    ]);
    expect(byCls(app, "feed-ts").map((ts) => ts.text)).toEqual(["now", "5s ago", "1m ago"]);
    expect(byCls(app, "feed-ts")[0]?.attrs?.datetime).toBe(new Date(NOW).toISOString());
    expect(icons(byCls(app, "feed")[0] ?? { tag: "ol" })).toEqual(["close", "dot", "pause"]);
    expect(byCls(panel(app), "card-sub")[0]?.text).toBe("3 events, newest first");
  });

  it("shows the empty state when no events are in view", () => {
    const app = renderApp(stateWith({ tab: "timeline" }), NOW, URL);
    expect(emptyTitles(panel(app))).toEqual(["No events in this view"]);
  });
});

describe("models view", () => {
  it("ranks models with token bars, then upstreams and a request-rate chart", () => {
    const app = renderApp(stateWith({ tab: "models" }), NOW, URL);
    const view = byCls(app, "stack models")[0] ?? { tag: "div" };
    expect(byCls(view, "card-title").map((title) => title.text)).toEqual([
      "Models",
      "Upstreams",
      "Request rate",
    ]);
    expect(byCls(view, "card-sub").map((sub) => sub.text)).toEqual([
      "2 models, tokens by kind",
      "1 endpoint",
      "Requests per bucket, 1h window",
    ]);
    expect(withToken(view, "rank-name").map((name) => name.text)).toEqual([
      "claude-sonnet-5-5",
      "glm-5.3",
      "api.anthropic.com",
    ]);
    expect(byCls(view, "rank-provider").map((provider) => provider.text)).toEqual(["Anthropic", "Z.ai"]);
    expect(byCls(view, "rank-meta").map((meta) => meta.text)).toEqual([
      "5 requests, median 45ms, unpriced",
      "3 requests, median 120ms, unpriced",
      "5 requests",
    ]);
    expect(byCls(view, "rank-total").map((total) => total.text)).toEqual(["400", "900", "0"]);
    expect(withToken(view, "badge").map((badge) => textOf(badge))).toEqual(["1 failed"]);
    expect(byCls(view, "legend legend-inline")).toHaveLength(1);
    expect(withAttr(view, "id", "rate-gradient")).toHaveLength(1);
    expect(byCls(view, "chart-ymax")[0]?.text).toBe("0 max");
  });

  it("waits for the aggregate snapshot and notes empty lists", () => {
    const waiting = renderApp(stateWith({ tab: "models", models: null }), NOW, URL);
    expect(emptyTitles(panel(waiting))).toEqual(["Waiting for model totals"]);
    const bare = renderApp(
      stateWith({ tab: "models", models: { models: [], upstreams: [], tools: [] } }),
      NOW,
      URL,
    );
    expect(emptyTitles(panel(bare))).toEqual(["No model requests yet", "No upstreams recorded"]);
  });
});

describe("drawer and footer", () => {
  it("details the picked request with a latency verdict against p95", () => {
    const request = makeRequest({
      id: "a",
      model: "glm-5.3",
      provider: "Z.ai",
      upstream: "http://127.0.0.1:8787",
      latencyMs: 700,
      ts: NOW - 30_000,
      tokens: { ...ZERO_TOKENS, input: 12_345, output: 678, cacheRead: 9_000, cacheWrite: 3 },
    });
    const app = renderApp(
      stateWith({
        request: "a",
        requests: [request],
        sessions: [item("s1", { project: "app" })],
        summary: { ...SUMMARY, latencyP95: 1_000 },
      }),
      NOW,
      URL,
    );
    const drawer = byCls(app, "drawer")[0] ?? { tag: "aside" };
    expect(drawer.attrs).toEqual({ role: "dialog", "aria-labelledby": "drawer-title" });
    expect(withToken(drawer, "drawer-title")[0]?.text).toBe("glm-5.3");
    expect(withAttr(app, "data-action", "close-drawer").map((node) => node.cls)).toEqual([
      "scrim",
      "icon-btn",
    ]);
    const fields = fieldValues(drawer);
    expect(fields.get("When")).toMatch(/^\d{2}:\d{2}:\d{2}, 30s ago$/);
    expect(fields.get("Latency")).toBe("700msSlower than most");
    expect(fields.get("Upstream")).toBe("127.0.0.1:8787");
    expect(fields.get("Project")).toBe("app");
    expect(fields.get("Session")).toBe("s1");
    expect(fields.get("Agent")).toBe("main");
    expect(fields.get("Request id")).toBe("a");
    expect(byCls(drawer, "token-num").map((num) => num.text)).toEqual(["12,345", "678", "9,000", "3"]);
    expect(byCls(drawer, "token-total")[0]?.text).toBe("22,026");
    expect(byCls(drawer, "bar-seg")[0]?.attrs?.style).toBe("width:70.00%;background:var(--warning)");
    expect(byCls(drawer, "field-hint")[0]?.text).toBe("Measured against the view's p95 of 1s.");
    expect(textOf(byCls(drawer, "badge badge-idle")[0] ?? { tag: "x" })).toBe("No stop reason");
  });

  it("names fast and slow requests in words, and falls back to raw ids", () => {
    const at = (latencyMs: number, over: Partial<RequestRecord> = {}): UINode =>
      renderApp(
        stateWith({
          request: "x",
          requests: [makeRequest({ id: "x", latencyMs, stopReason: "end_turn", ...over })],
          summary: { ...SUMMARY, latencyP95: 1_000 },
        }),
        NOW,
        URL,
      );
    expect(fieldValues(at(100)).get("Latency")).toBe("100msFast for this view");
    expect(fieldValues(at(900)).get("Latency")).toBe("900msAmong the slowest");
    expect(fieldValues(at(100)).get("Session")).toBe("s1");
    expect(textOf(byCls(at(100), "badge badge-info")[0] ?? { tag: "x" })).toBe("end_turn");
  });

  it("hides the drawer and skips the latency bar when there is nothing to compare", () => {
    const closed = renderApp(stateWith(), NOW, URL);
    expect(byCls(closed, "drawer-hidden")).toHaveLength(1);
    expect(byCls(closed, "drawer")).toHaveLength(0);
    expect(byCls(closed, "scrim")).toHaveLength(0);

    const unmeasured = renderApp(
      stateWith({ request: "n", requests: [makeRequest({ id: "n", latencyMs: null })] }),
      NOW,
      URL,
    );
    expect(byCls(unmeasured, "drawer")).toHaveLength(1);
    expect(byCls(unmeasured, "bar-seg")).toHaveLength(0);
    expect(fieldValues(unmeasured).get("Latency")).toBe("–");
  });

  it("ends with the keyboard hints and version, flagging offline", () => {
    const live = renderApp(stateWith(), NOW, URL);
    const footer = byCls(live, "footer")[0] ?? { tag: "footer" };
    expect(byTag(live, "kbd").map((kbd) => kbd.text)).toEqual(["R", "Esc"]);
    expect(textOf(footer)).toContain("Observatory v0.0.1");
    expect(textOf(footer)).not.toContain("offline");

    const offline = renderApp(stateWith({ connected: false }), NOW, URL);
    expect(textOf(byCls(offline, "footer")[0] ?? { tag: "footer" })).toContain("Observatory v0.0.1, offline");
  });
});

describe("sorting, export and time format", () => {
  it("makes every table header a sort button and marks the sorted column", () => {
    const state = stateWith({ tab: "requests", requests: [makeRequest({ id: "a", ts: NOW - 1_000 })] });
    const app = renderApp(state, NOW, URL);
    const sorts = withAttr(app, "data-action", "sort-requests");
    expect(sorts.map((button) => button.attrs?.["data-value"])).toEqual([
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
    const heads = byTag(app, "th");
    expect(heads.map((th) => th.attrs?.["aria-sort"])).toEqual(["descending", ...Array(10).fill("none")]);
    expect(icons(heads[0] ?? { tag: "th" })).toEqual(["chevronDown"]);
    expect(icons(heads[1] ?? { tag: "th" })).toEqual(["chevronsUpDown"]);
    expect(sorts[0]?.cls).toBe("sort-btn sort-on");
    expect(sorts[4]?.attrs?.title).toBe("Sort by latency");

    const byModel = renderApp({ ...state, requestSort: { key: "model", dir: "asc" } }, NOW, URL);
    const modelHead = byTag(byModel, "th")[2] ?? { tag: "th" };
    expect(modelHead.attrs?.["aria-sort"]).toBe("ascending");
    expect(icons(modelHead)).toEqual(["chevronUp"]);

    const tools = renderApp(
      stateWith({ tab: "tools", tools: [makeTool()], toolSort: { key: "duration", dir: "desc" } }),
      NOW,
      URL,
    );
    expect(
      withAttr(tools, "data-action", "sort-tools").map((button) => button.attrs?.["data-value"]),
    ).toEqual(["time", "tool", "session", "agent", "duration", "result"]);
    expect(withAttr(tools, "aria-sort", "descending").map((th) => textOf(th))).toEqual(["Duration"]);
  });

  it("offers a CSV export of what each table shows", () => {
    const requests = renderApp(stateWith({ tab: "requests", requests: [makeRequest()] }), NOW, URL);
    const exportRequests = withAttr(requests, "data-action", "export");
    expect(exportRequests.map((button) => button.attrs?.["data-value"])).toEqual(["requests"]);
    expect(textOf(exportRequests[0] ?? { tag: "button" })).toBe("Export CSV");
    expect(exportRequests[0]?.attrs?.title).toBe("Download the 1 row shown as CSV");
    const tools = renderApp(
      stateWith({ tab: "tools", tools: [makeTool(), makeTool({ id: "b" })] }),
      NOW,
      URL,
    );
    expect(withAttr(tools, "data-action", "export")[0]?.attrs).toMatchObject({
      "data-value": "tools",
      title: "Download the 2 rows shown as CSV",
    });
  });

  it("switches the rail and the timeline between relative and clock times", () => {
    const sessions = [
      item("a", { live: true, startedAt: NOW - 600_000 }),
      item("b", { live: false, startedAt: NOW - 7_200_000, endedAt: NOW - 3_600_000 }),
    ];
    const events = [
      { seq: 1, ts: NOW - 60_000, kind: "Stop", sessionId: "a", agentId: null, label: null, payload: null },
    ];
    const relative = renderApp(stateWith({ sessions, events, tab: "timeline" }), NOW, URL);
    expect(byCls(relative, "session-sub").map((sub) => textOf(sub))).toEqual([
      "Started 10m ago",
      "Ended 1h ago",
    ]);
    expect(byCls(relative, "feed-ts")[0]?.text).toBe("1m ago");
    const clock = renderApp(stateWith({ sessions, events, tab: "timeline", timeMode: "absolute" }), NOW, URL);
    for (const sub of byCls(clock, "session-sub"))
      expect(textOf(sub)).toMatch(/^(Started|Ended) at \d{1,2}:\d{2}/);
    expect(byCls(clock, "feed-ts")[0]?.text).toMatch(/^\d{1,2}:\d{2}/);
    expect(byCls(clock, "feed-ts")[0]?.attrs?.title).toBe("1m ago");
    expect(withAttr(clock, "data-action", "time-mode").map((b) => b.attrs?.["aria-pressed"])).toEqual([
      "false",
      "true",
    ]);
  });

  it("keeps a requests bar next to the token bar for each model", () => {
    const view = byCls(renderApp(stateWith({ tab: "models" }), NOW, URL), "stack models")[0] ?? {
      tag: "div",
    };
    const pairs = byCls(view, "bar-pair");
    expect(pairs).toHaveLength(2);
    expect(byCls(pairs[0] ?? { tag: "div" }, "bar-label").map((label) => label.text)).toEqual([
      "Requests",
      "Tokens",
    ]);
    expect(byCls(pairs[0] ?? { tag: "div" }, "bar-seg")[0]?.attrs?.style).toBe(
      "width:100.00%;background:var(--series-4)",
    );
    expect(byCls(pairs[1] ?? { tag: "div" }, "bar-seg")[0]?.attrs?.style).toBe(
      "width:60.00%;background:var(--series-1)",
    );
  });

  it("repeats the server facts and the reconnect note in the footer", () => {
    const footer = byCls(renderApp(stateWith(), NOW, URL), "footer")[0] ?? { tag: "footer" };
    expect(byCls(footer, "footer-note")[0]?.text).toBe("The live stream reconnects on its own.");
    expect(byCls(footer, "footer-facts")[0]?.text).toBe(`Server ${URL}, up 2m05s, updated 5s ago`);
    const cold = byCls(renderApp(initialClientState(), NOW, URL), "footer-facts")[0];
    expect(cold?.text).toBe(`Server ${URL}, up –, updated never`);
  });
});
