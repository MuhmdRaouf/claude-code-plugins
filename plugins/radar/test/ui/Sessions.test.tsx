import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UNATTACHED_NAME } from "../../src/shared/model.ts";
import type { SessionListItem } from "../../src/store/store.ts";
import {
  LiveRail,
  liveRepos,
  liveSessions,
  matches,
  orderedSessions,
  PanelTabs,
  RailFilters,
  Sessions,
  sessionsCost,
  sessionsTotal,
} from "../../src/ui/app/Sessions.tsx";
import type { HistoryRoot } from "../../src/ui/state.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;
const QUIET_ACTIVITY = {
  bucketMs: 18_750,
  counts: new Array<number>(48).fill(0),
  models: new Array<string>(48).fill(""),
};

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
    activity: QUIET_ACTIVITY,
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

function busyActivity(models: string[]): typeof QUIET_ACTIVITY {
  return {
    bucketMs: 18_750,
    counts: [0, 4, 2, ...new Array<number>(45).fill(0)],
    models: [...models, ...new Array<string>(48 - models.length).fill("")],
  };
}

/** A history page entry, as much of one as the rail's counts read: the Unattached group carries a
 *  job's id and name. */
function historyRoot(id: string, over: Partial<HistoryRoot> = {}): HistoryRoot {
  return { id, sessionId: id.replace(/\/main$/, ""), name: id, ...over } as HistoryRoot;
}

describe("session helpers", () => {
  it("orders live sessions first then most recently active, and sums tokens and cost", () => {
    const sessions = [
      item("a", { live: false, lastAt: 9 }),
      item("b", { live: true, lastAt: 1, tokens: 100, costUsd: 0.5 }),
      item("c", { live: false, lastAt: 5, tokens: 23, costUsd: null }),
    ];
    expect(orderedSessions(sessions).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(orderedSessions(sessions)).not.toBe(sessions);
    expect(sessionsTotal(sessions)).toBe(123);
    expect(sessionsTotal([])).toBe(0);
    expect(sessionsCost(sessions)).toBeCloseTo(0.5);
    expect(sessionsCost([item("x")])).toBe(0);
  });

  it("keeps the live tab to the open main sessions, never jobs", () => {
    const sessions = [
      item("open", { live: true, lastAt: 9 }),
      item("zai:job", { live: true, external: true, lastAt: 8 }),
      item("ended", { live: false, lastAt: 7 }),
      item("colon:job", { live: true, lastAt: 6 }),
    ];
    expect(liveSessions(sessions).map((s) => s.id)).toEqual(["open"]);
  });

  it("matches the filter text against name, repo, project, cwd and branch", () => {
    const session = item("a", { name: "Fleet sweep", repo: "~/work/app", branch: "homelab" });
    expect(matches(session, "")).toBe(true);
    expect(matches(session, "sweep")).toBe(true);
    expect(matches(session, "HOMELAB")).toBe(true);
    expect(matches(session, "nothing")).toBe(false);
  });

  it("lists the repos the live cards run in, alphabetically", () => {
    const repos = liveRepos([
      item("a", { repo: "/z/repo", cwd: null }),
      item("b", { repo: "/a/repo", cwd: null }),
      item("c", { repo: null, cwd: "/a/repo" }),
      item("d", {}),
    ]);
    expect(repos).toEqual([
      { repo: "/a/repo", count: 2 },
      { repo: "/z/repo", count: 1 },
    ]);
  });
});

describe("the rail's Live/History tabs", () => {
  it("are a large tabs box, mark the panel that is on, and carry the counts as badges", async () => {
    const first = renderApp(<PanelTabs live={3} history={12} />, { sessionsPanel: "live" }, NOW);
    const box = document.querySelector('[data-key="panel-tabs"]');
    expect(box?.className).toContain("tabs-box");
    expect(box?.className).toContain("tabs-lg");
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-action="panel"]')];
    expect(tabs.map((tab) => tab.dataset.value)).toEqual(["live", "history"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.textContent).toContain("Live");
    expect(tabs[0]?.textContent).toContain("3");
    expect(tabs[1]?.textContent).toContain("12");
    // each count sits in its own badge: the on tab's primary, the other's ghost
    const liveBadge = tabs[0]?.querySelector(".badge");
    const historyBadge = tabs[1]?.querySelector(".badge");
    expect(liveBadge?.className).toContain("badge-primary");
    expect(liveBadge?.className).toContain("badge-soft");
    expect(historyBadge?.className).toContain("badge-ghost");
    await userEvent.click(tabs[1] as HTMLButtonElement);
    expect(first.act).toHaveBeenCalledWith("panel", "history");
    first.unmount();
    // a loading history page carries no count yet
    const loading = renderApp(<PanelTabs live={1} history={null} />, { sessionsPanel: "live" }, NOW);
    expect(loading.container.querySelector('[data-value="history"]')?.querySelector(".badge")).toBeNull();
    loading.unmount();
  });

  it("is one tab stop: the off tab is unreachable by Tab and the arrow keys switch", async () => {
    const { act, container } = renderApp(<PanelTabs live={1} history={2} />, { sessionsPanel: "live" }, NOW);
    const live = container.querySelector<HTMLButtonElement>('[data-value="live"]');
    const history = container.querySelector<HTMLButtonElement>('[data-value="history"]');
    expect(live?.tabIndex).toBe(0);
    expect(history?.tabIndex).toBe(-1);
    live?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(act).toHaveBeenCalledWith("panel", "history");
    expect(document.activeElement).toBe(history);
    await userEvent.keyboard("{ArrowLeft}");
    expect(act).toHaveBeenCalledWith("panel", "live");
    expect(document.activeElement).toBe(live);
  });
});

describe("the live rail", () => {
  const sessions = [
    item("alpha", {
      name: "Fleet sweep",
      live: true,
      status: "working",
      tokens: 2_500,
      costUsd: 0.42,
      repo: "/Users/raouf/work/app",
      cwd: "/Users/raouf/work/app/.agents/worktrees/homelab",
      branch: "homelab",
      agentCount: 3,
      liveAgentCount: 3,
      startedAt: NOW - 600_000,
      lastAt: NOW - 40_000,
      now: { what: "↳ prompt: sweep the fleet", ts: NOW - 40_000 },
      context: { used: 124_000, window: 200_000 },
      activity: busyActivity(["claude-opus-5-5", "claude-opus-5-5", "glm-5.3-flash"]),
    }),
    item("beta", {
      live: true,
      status: "idle",
      project: "docs",
      startedAt: NOW - 7_200_000,
      lastAt: NOW - 90_000,
    }),
  ];

  it("shows the All sessions card and one card per open session", () => {
    const { container } = renderApp(<LiveRail />, { sessions, selected: [] }, NOW);
    const all = container.querySelector<HTMLButtonElement>('button[data-value=""]');
    expect(all?.textContent).toContain("All sessions");
    expect(all?.textContent).toContain("2.5k");
    expect(all?.textContent).toContain("$0.42");
    const cards = [...container.querySelectorAll<HTMLButtonElement>("button[data-card]")];
    expect(cards).toHaveLength(3);
    expect(cards[1]?.textContent).toContain("Fleet sweep");
    expect(cards[1]?.textContent).toContain("$0.42");
    expect(cards[2]?.textContent).toContain("docs");
    expect(cards[2]?.textContent).toContain("Waiting for you");
  });

  it("wraps the picked card in the aura and presses it, the fleet card wearing the aura when none is picked", () => {
    const none = renderApp(<LiveRail />, { sessions, selected: [] }, NOW);
    const all = none.container.querySelector('button[data-value=""]')?.parentElement;
    expect(all?.className).toContain("aura");
    expect(all?.className).toContain("aura-sm");
    expect(all?.className).toContain("block");
    expect(all?.children).toHaveLength(1); // the aura wraps exactly the card
    const bareCard = none.container.querySelector<HTMLButtonElement>('button[data-value="alpha"]');
    expect(bareCard?.getAttribute("aria-pressed")).toBe("false");
    expect(bareCard?.closest(".aura")).toBeNull();
    none.unmount();
    const picked = renderApp(<LiveRail />, { sessions, selected: ["alpha"] }, NOW);
    const wrapper = picked.container.querySelector('button[data-value="alpha"]')?.parentElement;
    expect(wrapper?.className).toContain("aura");
    expect(wrapper?.className).toContain("aura-sm");
    expect(picked.container.querySelector('button[data-value="alpha"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    // the fleet card stands plain once a set is picked, and the picked card wears the Viewing check
    expect(picked.container.querySelector('button[data-value=""]')?.closest(".aura")).toBeNull();
    expect(picked.container.querySelector('button[data-value="alpha"]')?.textContent).toContain("Viewing");
  });

  it("runs the toggle from a card and clears from the fleet row, X on the rail clearing too", async () => {
    const { act, container } = renderApp(<LiveRail />, { sessions, selected: ["alpha"] }, NOW);
    await userEvent.click(container.querySelector('button[data-value="beta"]') as HTMLElement);
    expect(act).toHaveBeenCalledWith("session", "beta"); // the controller toggles
    await userEvent.click(container.querySelector('button[data-value=""]') as HTMLElement);
    expect(act).toHaveBeenCalledWith("session", "");
    const list = container.querySelector("[data-card-list]");
    list?.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
    expect(act).toHaveBeenCalledWith("clearSelection");
  });

  it("moves the focus with the arrow keys and picks with Enter", async () => {
    const { act, container } = renderApp(<LiveRail />, { sessions }, NOW);
    const cards = [...container.querySelectorAll<HTMLButtonElement>("button[data-card]")];
    cards[0]?.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(cards[1]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(cards[0]);
    await userEvent.keyboard("{ArrowUp}"); // the first card has nothing above it
    expect(document.activeElement).toBe(cards[0]);
    await userEvent.keyboard("{Enter}");
    expect(act).toHaveBeenCalledWith("session", "");
  });

  it("narrow the cards with the live filters", async () => {
    const { act, container } = renderApp(<Sessions />, { sessions }, NOW);
    expect(container.querySelectorAll("button[data-card]")).toHaveLength(3);
    const filtered = renderApp(<LiveRail />, { sessions, liveInput: "sweep" }, NOW);
    expect(filtered.container.querySelectorAll("button[data-card]")).toHaveLength(2); // fleet row + alpha
    filtered.unmount();
    const repoOnly = renderApp(<LiveRail />, { sessions, liveRepo: "/Users/raouf/work/app" }, NOW);
    expect(repoOnly.container.querySelectorAll("button[data-card]")).toHaveLength(2);
    repoOnly.unmount();
    const none = renderApp(<LiveRail />, { sessions, liveInput: "zzz" }, NOW);
    expect(none.container.textContent).toContain("Nothing open matches");
    none.unmount();
    await userEvent.type(container.querySelector('[data-key="live-search"]') as HTMLElement, "a");
    expect(act).toHaveBeenCalledWith("live-input", "a");
  });

  it("offers the live repo picker the repos of the open cards, never the ended or the jobs", () => {
    const mixed = [
      item("open", { live: true, repo: "/a" }),
      item("ended", { repo: "/a" }),
      item("zai:job", { live: true, external: true, repo: "/b" }),
      item("solo", { live: true, repo: "/c" }),
    ];
    const { container } = renderApp(<Sessions />, { sessions: mixed }, NOW);
    const select = container.querySelector<HTMLSelectElement>('[data-key="live-repo"]');
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual([
      "All repos",
      "/a (1)",
      "/c (1)",
    ]);
  });

  it("says the rail is empty before the first session spools, and when a filter matches nothing", () => {
    const empty = renderApp(<LiveRail />, { sessions: [] }, NOW);
    expect(screen.getByText("No sessions yet")).toBeTruthy();
    empty.unmount();
    expect(renderApp(<LiveRail />, { sessions, liveRepo: "/gone" }, NOW).container.textContent).toContain(
      "Nothing open matches",
    );
  });
});

describe("the rail filters", () => {
  it("are full-size fields side by side, bound to the panel they are on", async () => {
    const { act, container } = renderApp(
      <RailFilters repos={[{ repo: "/a", count: 2 }]} />,
      { sessionsPanel: "history", historyInput: "", historyRepo: null },
      NOW,
    );
    const row = container.querySelector('[data-key="rail-filters"]');
    const search = container.querySelector<HTMLInputElement>('[data-key="history-search"]');
    const label = search?.closest("label");
    expect(label?.className).toContain("input");
    expect(label?.className).not.toContain("input-sm");
    expect(search?.placeholder).toBe("Filter sessions");
    const select = container.querySelector<HTMLSelectElement>('[data-key="history-repo"]');
    expect(select?.className).toContain("select");
    expect(select?.className).not.toContain("select-sm");
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual(["All repos", "/a (2)"]);
    await userEvent.type(search as HTMLElement, "f");
    expect(act).toHaveBeenCalledWith("history-input", "f");
    await userEvent.selectOptions(select as HTMLSelectElement, "/a");
    expect(act).toHaveBeenCalledWith("history-repo", "/a");
    expect(row?.className).toContain("gap-2");
  });

  it("run the live actions on the live panel", async () => {
    const { act, container } = renderApp(
      <RailFilters repos={[{ repo: "/a", count: 1 }]} />,
      { sessionsPanel: "live" },
      NOW,
    );
    await userEvent.type(container.querySelector('[data-key="live-search"]') as HTMLElement, "x");
    expect(act).toHaveBeenCalledWith("live-input", "x");
    await userEvent.selectOptions(
      container.querySelector('[data-key="live-repo"]') as HTMLSelectElement,
      "/a",
    );
    expect(act).toHaveBeenCalledWith("live-repo", "/a");
  });
});

describe("Sessions", () => {
  it("shows the tabs, the filters and the live list on the live panel", () => {
    const { container } = renderApp(<Sessions />, { sessions: [item("s1", { live: true })] }, NOW);
    expect(container.querySelector('[data-key="rail"]')).toBeTruthy();
    expect(container.querySelector('[data-key="panel-tabs"]')).toBeTruthy();
    expect(container.querySelector('[data-key="sessions"]')).toBeTruthy();
    expect(container.querySelector('[data-action="panel"][data-value="live"]')?.className).toContain(
      "tab-active",
    );
  });

  it("shows the history list, the repo picker and the counts the panel carries", () => {
    const { container } = renderApp(
      <Sessions />,
      {
        sessions: [item("s1", { live: true }), item("s2")],
        sessionsPanel: "history",
        historyRoots: [],
        historyRepos: [{ repo: "/a", roots: 4 }],
      },
      NOW,
    );
    expect(container.querySelector('[data-key="history"]')).toBeTruthy();
    expect(container.querySelector('[data-action="panel"][data-value="live"]')?.textContent).toContain("1");
    expect(container.querySelector('[data-action="panel"][data-value="history"]')?.textContent).toContain(
      "0",
    );
    expect(container.textContent).toContain("/a (4)");
  });

  it("reads the History badge from the store's count before the tab is ever opened", () => {
    const { container } = renderApp(
      <Sessions />,
      {
        sessions: [item("s1", { live: true })],
        historyRoots: null,
        historyRootsLoading: false,
        historyStats: { bytes: 1, nodes: 2, requests: 3, roots: 7, retentionDays: 30 },
      },
      NOW,
    );
    expect(container.querySelector('[data-action="panel"][data-value="history"]')?.textContent).toContain(
      "7",
    );
    // and with neither a page nor a count yet, the badge stays hidden rather than reading 0
    const silent = renderApp(<Sessions />, { sessions: [item("s1", { live: true })] }, NOW);
    expect(silent.container.querySelector('[data-value="history"]')?.querySelector(".badge")).toBeNull();
    silent.unmount();
  });

  it("counts the History badge in sessions once the page is in, the Unattached group not one of them", () => {
    const page = [
      historyRoot("s1/main", { name: "first" }),
      historyRoot("s2/main", { name: "second" }),
      historyRoot(`${"outside-a-session"}/main`, { name: UNATTACHED_NAME }),
    ];
    const { container } = renderApp(
      <Sessions />,
      { sessions: [item("s1", { live: true })], historyRoots: page },
      NOW,
    );
    const badge = container.querySelector('[data-action="panel"][data-value="history"]');
    expect(badge?.textContent).toContain("2");
    expect(badge?.textContent).not.toContain("3");
    // a page without the group counts every entry, as before
    const plain = renderApp(
      <Sessions />,
      { sessions: [item("s1", { live: true })], historyRoots: page.slice(0, 2) },
      NOW,
    );
    expect(
      plain.container.querySelector('[data-action="panel"][data-value="history"]')?.textContent,
    ).toContain("2");
    plain.unmount();
  });
});
