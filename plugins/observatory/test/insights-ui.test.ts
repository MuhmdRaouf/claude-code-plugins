import { describe, expect, it } from "vitest";
import type { Alert } from "../src/alerts/engine.ts";
import type { BudgetSpend } from "../src/budget/budgets.ts";
import type { AttributionRow } from "../src/cost/attribution.ts";
import { type Summary, ZERO_TOKENS } from "../src/shared/model.ts";
import type { SessionListItem } from "../src/store/store.ts";
import { attributionCsv } from "../src/ui/export.ts";
import { fmtUsd } from "../src/ui/fmt.ts";
import { alertLabel, budgetTone, costText, renderAlertStrip, renderBudgetCard } from "../src/ui/insights.ts";
import { renderApp } from "../src/ui/render.ts";
import {
  budgetFromDraft,
  type ClientState,
  draftOf,
  initialClientState,
  newDraft,
  requestCost,
  tableAttribution,
  withBudget,
} from "../src/ui/state.ts";
import type { UINode } from "../src/ui/types.ts";
import { makeAgentView, makeRequest, makeSessionView } from "./helpers.ts";

const NOW = 1_800_000_000_000;

const SUMMARY: Summary = {
  sessions: 1,
  liveSessions: 1,
  agents: 1,
  requests: 1,
  tokens: { ...ZERO_TOKENS },
  errors: 0,
  toolCalls: 0,
  latencyP50: null,
  latencyP95: null,
  startedAt: NOW - 1000,
  now: NOW,
  costUsd: 1.25,
};

function walk(node: UINode, out: UINode[] = []): UINode[] {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}
const textOf = (node: UINode): string =>
  (node.children ?? []).reduce((acc, child) => acc + textOf(child), node.text ?? "");
const withToken = (root: UINode, token: string): UINode[] =>
  walk(root).filter((node) => (node.cls ?? "").split(" ").includes(token));
const withAttr = (root: UINode, key: string, value: string): UINode[] =>
  walk(root).filter((node) => node.attrs?.[key] === value);
const view = (root: UINode): UINode => walk(root).find((n) => n.cls === "view") ?? { tag: "x" };

function state(over: Partial<ClientState> = {}): ClientState {
  return { ...initialClientState(), summary: SUMMARY, connected: true, ...over };
}

const ALERT: Alert = {
  id: "loop:s1:main:t1",
  kind: "loop",
  sessionId: "s1",
  agentId: "w1-long-agent-id",
  project: "app",
  since: NOW - 120_000,
  detail: "Bash called 5 times in a row with the same input",
  costUsd: 0.5,
  severity: "warn",
};

const SPEND = (pct: number, action: "warn" | "stop" = "stop"): BudgetSpend => ({
  id: `b${pct}`,
  spentUsd: pct / 10,
  limitUsd: 10,
  pct,
  scope: "provider:zai",
  period: "day",
  action,
  periodStart: 0,
});

const ROWS: AttributionRow[] = [
  { key: "a", label: "alpha", requests: 3, tokens: { ...ZERO_TOKENS, input: 10 }, costUsd: 2, unpriced: 1 },
  {
    key: "b",
    label: "beta",
    requests: 9,
    tokens: { ...ZERO_TOKENS, output: 99 },
    costUsd: null,
    unpriced: 9,
  },
  { key: "c", label: "gamma", requests: 1, tokens: { ...ZERO_TOKENS }, costUsd: 5, unpriced: 0 },
];

describe("cost formatting", () => {
  it("prints estimates with sensible precision", () => {
    expect(fmtUsd(null)).toBe("–");
    expect(fmtUsd(undefined)).toBe("–");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.0012)).toBe("$0.0012");
    expect(fmtUsd(4.2)).toBe("$4.20");
    expect(fmtUsd(12_345.6)).toBe("$12,346");
    expect(costText(null)).toBe("unpriced");
    expect(costText(undefined)).toBe("unpriced");
    expect(costText(1)).toBe("est. $1.00");
    expect(
      requestCost(makeRequest({ model: "glm-5.3", tokens: { ...ZERO_TOKENS, input: 1e6 } })),
    ).toBeCloseTo(1.4);
    expect(requestCost(makeRequest({ model: "glm-5.3", provider: "route" }))).toBeNull();
  });
});

describe("overview additions", () => {
  it("shows the alert strip with dismiss buttons and a count on the Alerts tab", () => {
    expect(renderAlertStrip(state(), NOW)).toBeNull();
    const many = Array.from({ length: 4 }, (_, i) => ({ ...ALERT, id: `a${i}` }));
    const app = renderApp(state({ alerts: many }), NOW, "x");
    expect(withToken(app, "alert-row")).toHaveLength(3);
    expect(withAttr(app, "data-action", "dismiss-alert").map((b) => b.attrs?.["data-value"])).toEqual([
      "a0",
      "a1",
      "a2",
    ]);
    expect(textOf(withToken(app, "alert-strip")[0] ?? { tag: "x" })).toContain("All 4 alerts");
    expect(withToken(app, "tab-count")[0]?.text).toBe("4");
    expect(textOf(withToken(app, "alert-facts")[0] ?? { tag: "x" })).toBe(
      "app, w1-long-agensince 2m agoest. $0.50",
    );
    const one = renderAlertStrip(state({ alerts: [{ ...ALERT, agentId: null, costUsd: null }] }), NOW);
    expect(textOf(one ?? { tag: "x" })).toContain("Alerts");
  });

  it("names where an alert happened", () => {
    const strip = (alert: Alert) => textOf(renderAlertStrip(state({ alerts: [alert] }), NOW) ?? { tag: "x" });
    expect(strip({ ...ALERT, kind: "budget", sessionId: "", project: "" })).toContain("All sessions");
    expect(strip({ ...ALERT, kind: "retry_storm", sessionId: "", project: "" })).toContain("Router");
    expect(strip({ ...ALERT, project: "", agentId: null })).toContain("s1");
    expect(alertLabel("context")).toBe("Context nearly full");
  });

  it("draws budget bars by tone, only when budgets exist", () => {
    expect(renderBudgetCard(state())).toBeNull();
    expect(budgetTone(10)).toBe("ok");
    expect(budgetTone(80)).toBe("warn");
    expect(budgetTone(100)).toBe("err");
    const card = renderBudgetCard(
      state({
        budgetStatus: {
          version: 1,
          updatedAt: NOW,
          stopped: [],
          spend: [SPEND(10), SPEND(85, "warn"), SPEND(120), SPEND(130, "warn")],
        },
      }),
    );
    const words = withToken(card ?? { tag: "x" }, "badge").map(textOf);
    expect(words).toEqual(["On track", "Near", "Stopped", "Over"]);
    expect(textOf(card ?? { tag: "x" })).toContain("$1.00 of $10.00 (10%)");
  });

  it("shows cost on the stat card, the sessions rail, the agent tree and the drawer", () => {
    const item: SessionListItem = {
      id: "s1",
      project: "app",
      cwd: null,
      startedAt: NOW - 5000,
      endedAt: null,
      live: true,
      model: "glm-5.3",
      agentCount: 1,
      requestCount: 1,
      tokens: 10,
      lastAt: NOW,
      external: false,
      title: null,
      costUsd: 0.25,
    };
    const request = makeRequest({ id: "r1", sessionId: "s1", model: "glm-5.3", ts: NOW - 1000 });
    const detail = makeSessionView({
      agents: [
        makeAgentView({ costUsd: 0.25 }),
        makeAgentView({ id: "w1", parentId: "main", kind: "subagent" }),
      ],
    });
    const app = renderApp(
      state({
        sessions: [item],
        spendToday: 3.5,
        details: { s1: detail },
        requests: [request],
        request: "r1",
      }),
      NOW,
      "x",
    );
    const text = textOf(app);
    expect(text).toContain("Est. cost today$3.50");
    expect(text).toContain("$1.25 in this window (estimate)");
    expect(withToken(app, "session-cost")[0]?.text).toBe("$0.25");
    expect(withToken(app, "tree-cost")[0]?.text).toBe("est. $0.25");
    expect(withToken(app, "tree-head-cost")[0]?.text).toBe("est. $0.25");
    expect(text).toContain("Est. costest. $0.0000");
    const scoped = textOf(renderApp(state({ sessions: [item], session: "s1" }), NOW, "x"));
    expect(scoped).toContain("$0.25 in this session (estimate)");
    const nothing = textOf(
      renderApp(state({ sessions: [{ ...item, costUsd: null }], session: "s1", spendToday: 1 }), NOW, "x"),
    );
    expect(nothing).toContain("Nothing priced in this session (estimate)");
  });
});

describe("costs view", () => {
  it("loads, shows an empty period, then a sortable table with an export", () => {
    expect(textOf(view(renderApp(state({ tab: "costs" }), NOW, "x")))).toContain(
      "Adding up the usage ledger",
    );
    expect(textOf(view(renderApp(state({ tab: "costs", attribution: [] }), NOW, "x")))).toContain(
      "Nothing spent in this period",
    );
    const app = view(renderApp(state({ tab: "costs", attribution: ROWS }), NOW, "x"));
    const labels = withToken(app, "attr-name").map((n) => n.text);
    expect(labels).toEqual(["gamma", "alpha", "beta"]);
    expect(textOf(app)).toContain("Today: est. $7.00, 13 requests, 109 tokens");
    expect(textOf(app)).toContain("tokens only");
    expect(withAttr(app, "data-action", "sort-attribution").map((b) => b.attrs?.["data-value"])).toEqual([
      "label",
      "requests",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cost",
    ]);
    expect(withAttr(app, "data-action", "attribution-by")).toHaveLength(4);
    expect(withAttr(app, "data-action", "attribution-range")).toHaveLength(3);
    expect(withAttr(app, "data-value", "attribution")).toHaveLength(1);
    const unpricedOnly = view(
      renderApp(state({ tab: "costs", attribution: [ROWS[1] as AttributionRow] }), NOW, "x"),
    );
    expect(textOf(unpricedOnly)).toContain("unpriced");
  });

  it("sorts rows by any column", () => {
    const base = state({ attribution: ROWS });
    expect(
      tableAttribution({ ...base, attributionSort: { key: "requests", dir: "desc" } }).map((r) => r.key),
    ).toEqual(["b", "a", "c"]);
    expect(
      tableAttribution({ ...base, attributionSort: { key: "label", dir: "asc" } }).map((r) => r.key),
    ).toEqual(["a", "b", "c"]);
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      expect(tableAttribution({ ...base, attributionSort: { key, dir: "desc" } })).toHaveLength(3);
    }
    expect(tableAttribution(state())).toEqual([]);
  });

  it("exports the table as CSV", () => {
    const csv = attributionCsv("project", "day", ROWS);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "project,key,range,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,est_cost_usd,unpriced_requests",
    );
    expect(lines[1]).toBe("alpha,a,day,3,10,0,0,0,2,1");
    expect(lines[2]).toBe("beta,b,day,9,0,99,0,0,,9");
  });
});

describe("alerts view", () => {
  it("lists alerts or says all clear, and explains each kind", () => {
    const clear = textOf(view(renderApp(state({ tab: "alerts" }), NOW, "x")));
    expect(clear).toContain("All clear");
    expect(clear).toContain("How alerts work");
    const busy = view(
      renderApp(state({ tab: "alerts", alerts: [ALERT, { ...ALERT, id: "b", severity: "err" }] }), NOW, "x"),
    );
    expect(withToken(busy, "alert-row")).toHaveLength(2);
    expect(withToken(busy, "alert-err")).toHaveLength(1);
    expect(withToken(busy, "how-term").map(textOf)).toEqual([
      "Stuck",
      "Loop",
      "Retry storm",
      "Context nearly full",
      "Budget",
    ]);
  });
});

describe("router view", () => {
  const provider = {
    plugin: "zai",
    counts: { fallback: 2, refusal: 0, rate_limited: 1, budget_stop: 0, restart: 0 },
    series: [0, 1, 2],
    kindSeries: [],
    lastAt: NOW - 60_000,
    lastReason: "503",
  };

  it("loads, says when nothing happened, and shows providers and recent events", () => {
    const loading = textOf(view(renderApp(state({ tab: "router" }), NOW, "x")));
    expect(loading).toContain("Loading router events");
    expect(loading).toContain("Looking at recent runs");
    const empty = textOf(
      view(
        renderApp(
          state({ tab: "router", router: { windowMs: 1, buckets: 3, providers: [], recent: [] } }),
          NOW,
          "x",
        ),
      ),
    );
    expect(empty).toContain("No router events yet");
    const busy = view(
      renderApp(
        state({
          tab: "router",
          router: {
            windowMs: 1,
            buckets: 3,
            providers: [provider, { ...provider, plugin: "kimi", lastAt: null, lastReason: null }],
            recent: [
              { ts: NOW - 1000, plugin: "zai", event: "fallback", reason: "503", model: "glm-5.3" },
              { ts: NOW - 2000, plugin: "zai", event: "restart", reason: "", model: null },
            ],
          },
        }),
        NOW,
        "x",
      ),
    );
    const text = textOf(busy);
    expect(text).toContain("Z.ai");
    expect(text).toContain("Fallbacks 2");
    expect(text).toContain("Last 1m ago: 503");
    expect(text).toContain("No events");
    expect(text).toContain("Z.ai fell back to Anthropic");
    expect(text).toContain("Z.ai restarted");
  });

  it("shows the advisor's verdict, cautiously", () => {
    const noRuns = textOf(
      view(
        renderApp(
          state({
            tab: "router",
            advisor: { runsChecked: 0, candidates: 0, savingUsd: null, byModel: [], examples: [] },
          }),
          NOW,
          "x",
        ),
      ),
    );
    expect(noRuns).toContain("No subagent runs on a main model yet");
    const allBig = textOf(
      view(
        renderApp(
          state({
            tab: "router",
            advisor: { runsChecked: 3, candidates: 0, savingUsd: null, byModel: [], examples: [] },
          }),
          NOW,
          "x",
        ),
      ),
    );
    expect(allBig).toContain("Every run looked like it needed its model");
    const some = textOf(
      view(
        renderApp(
          state({
            tab: "router",
            advisor: {
              runsChecked: 4,
              candidates: 2,
              savingUsd: 0.09,
              byModel: [
                { model: "glm-5.3", flash: "glm-5.3-flash", runs: 1, costUsd: 0.1, flashCostUsd: 0.01 },
                { model: "claude-opus-5", flash: null, runs: 1, costUsd: null, flashCostUsd: null },
              ],
              examples: [],
            },
          }),
          NOW,
          "x",
        ),
      ),
    );
    expect(some).toContain("of 4 runs look flash-sized, est. saving $0.09");
    expect(some).toContain("could run on glm-5.3-flash");
    expect(some).toContain("$0.10 → $0.01");
    expect(some).toContain("unpriced");
    const unpricedOnly = textOf(
      view(
        renderApp(
          state({
            tab: "router",
            advisor: { runsChecked: 1, candidates: 1, savingUsd: null, byModel: [], examples: [] },
          }),
          NOW,
          "x",
        ),
      ),
    );
    expect(unpricedOnly).toContain("of 1 run look flash-sized");
  });
});

describe("settings view", () => {
  const budget = {
    id: "b1",
    scope: "provider:zai",
    period: "day" as const,
    limitUsd: 5,
    action: "stop" as const,
  };

  it("loads, invites a first budget, then lists budgets with edit and remove", () => {
    expect(textOf(view(renderApp(state({ tab: "settings" }), NOW, "x")))).toContain("Loading budgets");
    const empty = view(renderApp(state({ tab: "settings", budgets: [] }), NOW, "x"));
    expect(textOf(empty)).toContain("No budgets");
    expect(withAttr(empty, "data-action", "new-budget")).toHaveLength(1);
    const listed = view(
      renderApp(
        state({
          tab: "settings",
          budgets: [budget, { ...budget, id: "b2", scope: "total", action: "warn" }],
          budgetStatus: { version: 1, updatedAt: NOW, stopped: [], spend: [{ ...SPEND(50), id: "b1" }] },
        }),
        NOW,
        "x",
      ),
    );
    const text = textOf(listed);
    expect(text).toContain("Z.ai, $5.00 per day");
    expect(text).toContain("$5.00 so far (50%)");
    expect(text).toContain("Total, $5.00 per day");
    expect(withAttr(listed, "data-action", "edit-budget")).toHaveLength(2);
    expect(withAttr(listed, "data-action", "remove-budget")).toHaveLength(2);
  });

  it("renders the form for a new or an edited budget, with messages", () => {
    const form = view(
      renderApp(
        state({
          tab: "settings",
          budgets: [],
          providers: ["zai"],
          draft: { ...newDraft(["zai"]), scope: "provider:acme" },
          formMessage: { tone: "err", text: "Enter a limit" },
        }),
        NOW,
        "x",
      ),
    );
    expect(withAttr(form, "data-field", "scope")[0]?.children?.map((o) => o.attrs?.value)).toEqual([
      "total",
      "provider:zai",
      "provider:acme",
    ]);
    expect(withAttr(form, "selected", "selected").map((o) => o.attrs?.value)).toEqual([
      "provider:acme",
      "month",
      "warn",
    ]);
    expect(withAttr(form, "data-field", "limit")[0]?.attrs?.value).toBe("10");
    expect(textOf(form)).toContain("Add budget");
    expect(withAttr(form, "role", "alert")).toHaveLength(1);
    const edit = view(
      renderApp(
        state({
          tab: "settings",
          budgets: [budget],
          draft: draftOf(budget),
          formMessage: { tone: "ok", text: "Saved" },
        }),
        NOW,
        "x",
      ),
    );
    expect(textOf(edit)).toContain("Save");
    expect(withAttr(edit, "role", "status").length).toBeGreaterThan(0);
    expect(withAttr(edit, "data-action", "new-budget")).toHaveLength(0);
  });

  it("toggles notifications with a switch", () => {
    const on = view(renderApp(state({ tab: "settings", budgets: [] }), NOW, "x"));
    expect(withAttr(on, "data-action", "toggle-notifications")[0]?.attrs?.["aria-checked"]).toBe("true");
    const off = view(
      renderApp(state({ tab: "settings", budgets: [], settings: { notifications: false } }), NOW, "x"),
    );
    expect(withAttr(off, "data-action", "toggle-notifications")[0]?.attrs?.["aria-checked"]).toBe("false");
    expect(textOf(off)).toContain("Off");
  });
});

describe("budget drafts", () => {
  it("start from the first provider and turn into budgets, or say what to fix", () => {
    expect(newDraft([])).toEqual({ id: null, scope: "total", period: "month", limit: "10", action: "warn" });
    expect(newDraft(["kimi"]).scope).toBe("provider:kimi");
    expect(budgetFromDraft({ ...newDraft([]), limit: "$7.555" }, "new")).toEqual({
      id: "new",
      scope: "total",
      period: "month",
      limitUsd: 7.56,
      action: "warn",
    });
    expect(budgetFromDraft({ ...newDraft([]), limit: "abc" }, "n")).toMatch(/above \$0/);
    expect(budgetFromDraft({ ...newDraft([]), limit: "0" }, "n")).toMatch(/above \$0/);
    expect(budgetFromDraft({ ...newDraft([]), limit: "2000000" }, "n")).toMatch(/too large/);
    const b = { id: "b", scope: "total", period: "week" as const, limitUsd: 3, action: "stop" as const };
    expect(draftOf(b)).toEqual({ id: "b", scope: "total", period: "week", limit: "3", action: "stop" });
    expect(budgetFromDraft(draftOf(b), "ignored")).toEqual(b);
    expect(withBudget([], b)).toEqual([b]);
    expect(withBudget([b], { ...b, limitUsd: 4 })).toEqual([{ ...b, limitUsd: 4 }]);
    expect(withBudget([b], { ...b, id: "c" })).toHaveLength(2);
  });
});
