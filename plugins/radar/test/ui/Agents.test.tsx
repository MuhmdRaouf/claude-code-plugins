import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ZERO_TOKENS } from "../../src/shared/model.ts";
import type { SessionListItem } from "../../src/store/store.ts";
import { AgentsView, compareAgents } from "../../src/ui/app/views/Agents.tsx";
import type { ClientState } from "../../src/ui/state.ts";
import { makeAgentView, makeSessionView } from "../helpers.ts";
import { renderApp } from "./render.tsx";

function item(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    project: null,
    cwd: null,
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: false,
    status: null,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    model: null,
    agentCount: 0,
    liveAgentCount: 0,
    requestCount: 0,
    tokens: 0,
    lastAt: 0,
    external: false,
    title: null,
    ...over,
  };
}

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
  requests: 2,
  tools: 1,
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
  requests: 1,
  live: false,
  lastAt: 90,
});

function treeState(over: Partial<ClientState> = {}): Partial<ClientState> {
  return {
    sessions: [item("s1", { live: true, lastAt: 99, agentCount: 4, requestCount: 6, tokens: 1_200 })],
    details: { s1: makeSessionView({ id: "s1", agents: [ext, sub, main, unnamed] }) },
    ...over,
  };
}

function texts(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((node) => node.textContent ?? "");
}

function first(root: Element, selector: string): Element {
  const hit = root.querySelector(selector);
  if (hit === null) throw new Error(`no element matches ${selector}`);
  return hit;
}

function iconsOf(root: Element): string[] {
  return [...root.querySelectorAll("[data-icon]")].map((node) => node.getAttribute("data-icon") ?? "");
}

describe("AgentsView", () => {
  it("renders one table per session: main first, then subagents, externals at the bottom", () => {
    const { container } = renderApp(<AgentsView />, treeState());
    const block = first(container, "section.tree-block");
    expect(container.querySelectorAll("section.tree-block")).toHaveLength(1);
    expect(texts(block, ".tree-head-name")).toEqual(["s1"]);
    expect(texts(block, ".tree-head-facts")).toEqual(["4 agents6 requests1.2k"]);
    expect(texts(block, ".badge-success")).toEqual(["Live", "Live"]); // the session head and the live row
    expect(texts(block, "thead th")).toEqual([
      "Status",
      "Agent",
      "Model",
      "Requests",
      "Tokens",
      "Est. cost",
      "Latency p95",
      "Last activity",
    ]);
    expect(texts(block, ".tree-name")).toEqual(["Main", "abcdefghij", "researcher", "Fix tests"]);
    expect([...block.querySelectorAll("tbody tr")].map((row) => row.getAttribute("class") ?? "")).toEqual([
      "row cursor-pointer transition-colors hover:bg-base-200/50",
      "row opacity-60 cursor-pointer transition-colors hover:bg-base-200/50",
      "row opacity-60 cursor-pointer transition-colors hover:bg-base-200/50",
      "",
      "row opacity-60 cursor-pointer transition-colors hover:bg-base-200/50",
    ]);
    expect(
      [...block.querySelectorAll(".tree-name")].map((name) =>
        (name.closest("div")?.getAttribute("style") ?? "").replace(/\s/g, "").replace(/;$/, ""),
      ),
    ).toEqual(["padding-left:0px", "padding-left:22px", "padding-left:22px", "padding-left:0px"]);
    expect(texts(block, ".model-chip")).toEqual(["Opus 5.5"]);
    expect(first(block, ".model-chip").getAttribute("title")).toBe("claude-opus-5-5");
    expect(texts(block, "td.num")).toEqual([
      "5",
      "0",
      "–",
      "–",
      "1",
      "0",
      "–",
      "–",
      "2",
      "0",
      "–",
      "–",
      "1",
      "0",
      "–",
      "–",
    ]);
    expect(texts(block, ".badge-error")).toEqual(["2 failed"]);
    expect(texts(block, ".tree-section")).toEqual(["Jobs (1)"]);
    expect(texts(block, ".tree-toggle.tree-leaf")).toHaveLength(3);
    expect(
      [...block.querySelectorAll("tbody .icon-xs[data-icon]")].map((icon) => icon.getAttribute("data-icon")),
    ).toEqual(["bot", "branch", "branch", "plug"]);
    expect(texts(block, ".badge-ghost")).toEqual(["Ended", "Ended", "Ended"]);
    expect(block.querySelector(".status-success")).not.toBeNull(); // the live row's neon dot

    const ended = renderApp(
      <AgentsView />,
      treeState({
        sessions: [item("s1", { live: false, lastAt: 99, agentCount: 4, requestCount: 6, tokens: 1_200 })],
      }),
    );
    expect(texts(ended.container, ".badge-ghost")).toEqual(["Ended", "Ended", "Ended", "Ended"]); // head + rows
  });

  it("orders agents main, subagent, external and by recency inside a kind", () => {
    const mainView = makeAgentView({ id: "m", kind: "main", lastAt: 1 });
    const subNew = makeAgentView({ id: "sn", kind: "subagent", lastAt: 30 });
    const subOld = makeAgentView({ id: "so", kind: "subagent", lastAt: 10 });
    const subNever = makeAgentView({ id: "s0", kind: "subagent", lastAt: null });
    const extView = makeAgentView({ id: "e", kind: "external", lastAt: 99 });
    expect(compareAgents(subNew, mainView)).toBeGreaterThan(0);
    expect(compareAgents(extView, subNew)).toBeGreaterThan(0);
    expect(compareAgents(subNew, subOld)).toBeLessThan(0);
    expect(compareAgents(subOld, subNew)).toBeGreaterThan(0);
    expect(compareAgents(subOld, subOld)).toBe(0);
    expect(compareAgents(subNever, subOld)).toBeGreaterThan(0); // never active sorts last
    expect(compareAgents(subOld, subNever)).toBeLessThan(0);
  });

  it("collapses agents and whole sessions through the same collapse set", async () => {
    const collapsedAgent = renderApp(<AgentsView />, treeState({ collapsed: new Set(["s1/main"]) }));
    expect(texts(collapsedAgent.container, ".tree-name")).toEqual(["Main", "Fix tests"]);
    const toggle = first(collapsedAgent.container, '[data-action="collapse"][data-value="s1/main"]');
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Expand main");
    expect(iconsOf(toggle)).toEqual(["chevronRight"]);
    await userEvent.click(toggle);
    expect(collapsedAgent.act).toHaveBeenCalledWith("collapse", "s1/main");
    collapsedAgent.unmount();

    const collapsedSession = renderApp(<AgentsView />, treeState({ collapsed: new Set(["s1/"]) }));
    expect(collapsedSession.container.querySelectorAll(".tree-name")).toHaveLength(0); // body skipped entirely
    expect(collapsedSession.container.querySelectorAll(".tree-note")).toHaveLength(0);
    const head = first(collapsedSession.container, '[data-action="collapse"][data-value="s1/"]');
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(iconsOf(head)).toEqual(["chevronRight"]);
    await userEvent.click(head);
    expect(collapsedSession.act).toHaveBeenCalledWith("collapse", "s1/");
    collapsedSession.unmount();

    const open = renderApp(<AgentsView />, treeState());
    const toggles = [...open.container.querySelectorAll('[data-action="collapse"]')];
    expect(toggles.map((node) => node.getAttribute("data-value"))).toEqual(["s1/", "s1/main"]);
    expect(toggles.map((node) => node.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect(first(open.container, '[data-value="s1/main"]').getAttribute("aria-label")).toBe("Collapse main");
    expect(iconsOf(first(open.container, '[data-value="s1/main"]'))).toEqual(["chevronDown"]);
    expect(iconsOf(first(open.container, '[data-value="s1/"]'))).toEqual(["chevronDown"]);
  });

  it("waits for missing details, notes empty sessions and empty views", () => {
    const loading = renderApp(<AgentsView />, { sessions: [item("s1")] });
    expect(texts(loading.container, ".tree-note")).toEqual(["Loading this session's agents…"]);
    loading.unmount();

    const bare = renderApp(<AgentsView />, {
      sessions: [item("s1")],
      details: { s1: makeSessionView({ agents: [] }) },
    });
    expect(texts(bare.container, ".tree-note")).toEqual(["No agents recorded for this session yet."]);
    bare.unmount();

    const none = renderApp(<AgentsView />);
    expect(screen.getByText("No agents to show")).toBeTruthy();
    expect(
      screen.getByText("Each session's main agent and its subagents appear here as they run."),
    ).toBeTruthy();
    expect(texts(none.container, "section h2")).toEqual(["Agents"]);
  });

  it("prices agents and sessions, and marks live agents and failures", () => {
    const priced = makeAgentView({
      id: "p",
      parentId: "m",
      kind: "subagent",
      requests: 1,
      costUsd: 0.25,
      errors: 1,
      lastAt: 5,
    });
    const unpriced = makeAgentView({
      id: "u",
      parentId: "m",
      kind: "subagent",
      name: null,
      requests: 1,
      costUsd: null,
      lastAt: 4,
    });
    const unnamedChild = makeAgentView({
      id: "u2",
      parentId: "u",
      kind: "subagent",
      name: null,
      requests: 1,
      lastAt: 3,
    });
    const pricedMain = makeAgentView({
      id: "m",
      costUsd: 1.5,
      requests: 3,
      tokens: { ...ZERO_TOKENS, input: 500 },
      lastAt: 9,
    });
    const { container } = renderApp(<AgentsView />, {
      sessions: [item("s1", { live: true, costUsd: 2, agentCount: 3, requestCount: 1, tokens: 700 })],
      details: { s1: makeSessionView({ id: "s1", agents: [pricedMain, priced, unpriced, unnamedChild] }) },
    });
    expect(texts(container, ".tree-cost")).toEqual(["$1.50", "$0.25"]); // an unpriced agent shows –
    expect(first(container, 'td[title="Estimate at list price"]')).toBeTruthy();
    expect(texts(container, ".tree-head-cost")).toEqual(["$2.00"]); // the header says Est. cost, so the cell does not
    expect(texts(container, "td.num")).toContain("500");
    expect(texts(container, ".badge-error")).toEqual(["1 failed"]);
    expect(container.querySelectorAll(".tree-section")).toHaveLength(0); // no externals, no section
    expect(first(container, '[data-value="s1/u"]').getAttribute("aria-label")).toBe("Collapse u"); // no name, so the id

    const unpricedSession = renderApp(<AgentsView />, {
      sessions: [item("s1", { costUsd: null })],
      details: { s1: makeSessionView({ id: "s1", agents: [pricedMain] }) },
    });
    expect(unpricedSession.container.querySelectorAll(".tree-head-cost")).toHaveLength(0);
  });

  it("hides agents whose parent has not been sighted yet", () => {
    const orphan = makeAgentView({ id: "orphan", parentId: "ghost", kind: "subagent", lastAt: 5 });
    const { container } = renderApp(<AgentsView />, {
      sessions: [item("s1", { live: true })],
      details: { s1: makeSessionView({ id: "s1", agents: [orphan] }) },
    });
    expect(container.querySelectorAll(".tree-name")).toHaveLength(0);
    expect(container.querySelectorAll(".tree-section")).toHaveLength(0);
  });

  it("hides subagents that never ran behind a Show empty agents toggle", async () => {
    const ran = makeAgentView({
      id: "r",
      parentId: "main",
      kind: "subagent",
      name: "ran one",
      requests: 4,
      lastAt: 9,
    });
    const idle = makeAgentView({
      id: "i",
      parentId: "main",
      kind: "subagent",
      name: "idle one",
      lastAt: 8,
    });
    const idleToo = makeAgentView({
      id: "i2",
      parentId: "main",
      kind: "subagent",
      name: "idle two",
      lastAt: 7,
    });
    const state = (shown: boolean): Partial<ClientState> => ({
      sessions: [item("s1", { live: true, agentCount: 4 })],
      details: { s1: makeSessionView({ id: "s1", agents: [main, ran, idle, idleToo] }) },
      ...(shown ? { emptyAgents: new Set(["s1"]) } : {}),
    });
    const hidden = renderApp(<AgentsView />, state(false));
    expect(texts(hidden.container, ".tree-name")).toEqual(["Main", "ran one"]); // idle rows are gone
    const toggle = first(hidden.container, '[data-action="empty-agents"]');
    expect(toggle.textContent).toBe("Show 2 empty agents");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(hidden.act).toHaveBeenCalledWith("empty-agents", "s1");
    hidden.unmount();

    const shown = renderApp(<AgentsView />, state(true));
    expect(texts(shown.container, ".tree-name")).toEqual(["Main", "ran one", "idle one", "idle two"]);
    const open = first(shown.container, '[data-action="empty-agents"]');
    expect(open.textContent).toBe("Hide 2 empty agents");
    expect(open.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows each agent's latency p95, a dash when too few requests carry one", () => {
    const timed = makeAgentView({
      id: "t",
      parentId: "main",
      kind: "subagent",
      name: "timed",
      requests: 6,
      latencyP95: 875,
      lastAt: 9,
    });
    const untimed = makeAgentView({
      id: "n",
      parentId: "main",
      kind: "subagent",
      name: "untimed",
      requests: 2,
      latencyP95: null,
      lastAt: 8,
    });
    const unmeasured = makeAgentView({
      id: "u",
      parentId: "main",
      kind: "subagent",
      name: "raw",
      requests: 1, // ran, so the row shows; its view predates the p95 field
      lastAt: 7,
    });
    const { container } = renderApp(<AgentsView />, {
      sessions: [item("s1", { live: true, agentCount: 4 })],
      details: { s1: makeSessionView({ id: "s1", agents: [main, timed, untimed, unmeasured] }) },
    });
    const rows = [...container.querySelectorAll("tbody tr")];
    const p95Of = (row: Element | undefined): string | null =>
      row?.querySelector('td[title="95th percentile request latency"]')?.textContent ?? null;
    expect(p95Of(rows[0])).toBe("–"); // main carries no p95 in this fixture
    expect(p95Of(rows[1])).toBe("875ms");
    expect(p95Of(rows[2])).toBe("–"); // null: under five timed requests
    expect(p95Of(rows[3])).toBe("–"); // the field itself missing: an older wire shape
  });

  it("names a row after its task with its type beside it, falling back to today's name", () => {
    const explorer = makeAgentView({
      id: "e1",
      parentId: "main",
      kind: "subagent",
      name: "Explore",
      agentType: "Explore",
      description: "Find every caller of buildSessionView",
      model: "zai:glm-5.3-flash",
      requests: 3,
      lastAt: 9,
    });
    const untyped = makeAgentView({
      id: "e2",
      parentId: "main",
      kind: "subagent",
      name: "researcher",
      requests: 2,
      lastAt: 8,
    });
    const { container } = renderApp(<AgentsView />, {
      sessions: [item("s1", { live: true, agentCount: 3 })],
      details: { s1: makeSessionView({ id: "s1", agents: [main, explorer, untyped] }) },
    });
    expect(texts(container, ".tree-name")).toEqual([
      "Main",
      "Find every caller of buildSessionView",
      "researcher",
    ]);
    expect(texts(container, ".tree-type")).toEqual(["Explore"]);
    expect(texts(container, ".model-chip")).toEqual(["Opus 5.5", "GLM 5.3 Flash"]);
    expect(container.querySelectorAll('[data-action="empty-agents"]')).toHaveLength(0); // no idle agents
  });

  it("renders a job's subagents under the job's row, collapsible with it", () => {
    const worker = makeAgentView({
      id: "w1",
      parentId: "ext-1", // the job's own subagents are keyed under the job's external agent
      kind: "subagent",
      name: "job worker",
      requests: 1,
      live: false,
      lastAt: 60,
    });
    const detail = makeSessionView({ id: "s1", agents: [ext, worker, main] });
    const shown = renderApp(<AgentsView />, treeState({ details: { s1: detail } }));
    expect(texts(shown.container, "tbody .tree-name")).toEqual(["Main", "Fix tests", "job worker"]);
    const row = [...shown.container.querySelectorAll("tbody .tree-name")][2];
    expect(row?.closest("div")?.getAttribute("style")).toBe("padding-left: 22px;"); // nested under the job
    shown.unmount();
    // the job's chevron folds its subagents away, like any parent's
    const folded = renderApp(
      <AgentsView />,
      treeState({ details: { s1: detail }, collapsed: new Set(["s1/ext-1"]) }),
    );
    expect(texts(folded.container, "tbody .tree-name")).toEqual(["Main", "Fix tests"]);
  });
});
