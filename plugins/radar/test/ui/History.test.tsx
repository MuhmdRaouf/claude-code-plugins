import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UNATTACHED_NAME } from "../../src/shared/model.ts";
import {
  cardOfRoot,
  dayKey,
  dayLabel,
  HistoryRail,
  historyGroups,
  isUnattached,
  sessionCount,
} from "../../src/ui/app/History.tsx";
import type { HistoryRoot } from "../../src/ui/state.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;

/** The weekday-and-date words the same timestamp reads as, composed here from the calendar. */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function expectDay(ts: number): string {
  const date = new Date(ts);
  return `${WD[date.getDay()]} ${date.getDate()} ${MO[date.getMonth()]}`;
}

function root(id: string, over: Partial<HistoryRoot> = {}): HistoryRoot {
  return {
    id,
    kind: "main",
    parentId: null,
    sessionId: id.replace(/\/main$/, ""),
    agentId: "main",
    label: null,
    agentType: null,
    description: null,
    project: "app",
    cwd: "/Users/smoke/work/app",
    model: "glm-5.3",
    provider: "Z.ai",
    toolUseId: null,
    spawnDepth: 0,
    jobState: null,
    repo: "/Users/smoke/work/app",
    branch: "homelab",
    name: "fix radar",
    parentSessionId: null,
    startedAt: NOW - 3_600_000,
    endedAt: NOW - 60_000,
    lastAt: NOW - 60_000,
    requests: 12,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    nodes: 3,
    liveNodes: 0,
    activity: {
      bucketMs: 18_750,
      counts: new Array<number>(48).fill(0),
      models: new Array<string>(48).fill(""),
    },
    costUsd: 0.42,
    ...over,
  };
}

describe("day groups", () => {
  it("name a day Today, Yesterday, or by weekday and date", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today");
    expect(dayLabel(NOW - 86_400_000, NOW)).toBe("Yesterday");
    expect(dayLabel(NOW - 3 * 86_400_000, NOW)).toBe(expectDay(NOW - 3 * 86_400_000));
    expect(dayKey(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("group the roots per day in the order they arrive, Unattached last", () => {
    const roots = [
      root("r1/main", { startedAt: NOW - 3_600_000 }),
      root("r2/main", { startedAt: NOW - 3_600_000, name: "second today" }),
      root("r3/main", { startedAt: NOW - 30 * 86_400_000, lastAt: NOW - 30 * 86_400_000 }),
      root("outside-a-session/main", { name: UNATTACHED_NAME, startedAt: NOW - 60_000 }),
    ];
    const groups = historyGroups(roots, NOW);
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      expectDay(NOW - 30 * 86_400_000),
      UNATTACHED_NAME,
    ]);
    expect(groups[0]?.roots.map((entry) => entry.name)).toEqual(["fix radar", "second today"]);
    expect(groups[2]?.roots).toHaveLength(1);
    expect(isUnattached(roots[3] as HistoryRoot)).toBe(true);
    expect(isUnattached(roots[0] as HistoryRoot)).toBe(false);
  });

  it("keeps an unattached root by its session id even when renamed, and dates a root without a start by its last activity", () => {
    expect(isUnattached(root("x/main", { sessionId: "outside-a-session", name: "renamed" }))).toBe(true);
    const groups = historyGroups([root("r1/main", { startedAt: null, lastAt: NOW - 86_400_000 * 2 })], NOW);
    expect(groups[0]?.label).toBe(expectDay(NOW - 86_400_000 * 2));
  });

  it("counts the page's sessions, the Unattached roll-up group left out", () => {
    const page = [
      root("r1/main"),
      root("r2/main"),
      root(`${"outside-a-session"}/main`, { name: UNATTACHED_NAME }),
    ];
    expect(sessionCount(page)).toBe(2);
    expect(sessionCount(page.slice(0, 2))).toBe(2);
    expect(sessionCount([page[2] as HistoryRoot])).toBe(0);
    expect(sessionCount([])).toBe(0);
  });
});

describe("a history card", () => {
  it("carries the root's name, repo, branch, cost and models, without a live badge", () => {
    const card = cardOfRoot(root("r1/main"));
    expect(card.name).toBe("fix radar");
    expect(card.repo).toBe("/Users/smoke/work/app");
    expect(card.cwd).toBe("/Users/smoke/work/app");
    expect(card.branch).toBe("homelab");
    expect(card.costUsd).toBe(0.42);
    expect(card.liveAgents).toBe(0);
    expect(card.agentCount).toBe(3); // the tree's node count, the muted "3 agents" total
    expect(card.live).toBe(false);
    expect(card.startedAt).toBe(NOW - 3_600_000);
    expect(card.endedAt).toBe(NOW - 60_000);
    expect(card.lastAt).toBe(NOW - 60_000);
    // no now line or context gauge for a session that is over
    expect(card.now).toBeNull();
    expect(card.context).toBeNull();
    expect(card.status).toBeNull();
    // liveNodes of 3 is the root's own main node plus 2 subagents, so the badge says 2
    const live = cardOfRoot(root("r2/main", { liveNodes: 3 }));
    expect(live.live).toBe(true);
    expect(live.liveAgents).toBe(2);
  });

  it("falls back through the root's names to the id", () => {
    expect(cardOfRoot(root("r9/main", { name: null, label: "task", project: null })).name).toBe("task");
    expect(cardOfRoot(root("r9/main", { name: null, label: null, project: null })).name).toBe("r9/main");
  });
});

describe("the history rail", () => {
  const railState = {
    sessionsPanel: "history" as const,
    historyRoots: [root("r1/main"), root(`${"outside-a-session"}/main`, { name: UNATTACHED_NAME })],
    historyNext: null,
    historyRepos: [{ repo: "/Users/smoke/work/app", roots: 2 }],
    historyInput: "",
    historyQuery: "",
    historyRepo: null,
  };

  it("renders sticky day headers and one card per root, Unattached in its own group", () => {
    const { container } = renderApp(<HistoryRail />, railState, NOW);
    const days = [...container.querySelectorAll("[data-day]")];
    expect(days).toHaveLength(2);
    expect(days[0]?.querySelector("h3")?.textContent).toBe("Today");
    expect(days[0]?.querySelector("h3")?.className).toContain("sticky");
    expect(days[1]?.getAttribute("data-day")).toBe("unattached");
    expect(days[1]?.textContent).toContain(UNATTACHED_NAME);
    const cards = [...container.querySelectorAll("button[data-card]")];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("fix radar");
    expect(cards[0]?.textContent).toContain("$0.42");
    expect(cards[0]?.textContent).toContain("homelab");
    expect(cards[0]?.textContent).toContain("3 agents");
    // the now line says when it ended and how long it ran
    expect(cards[0]?.textContent).toContain("Ended 1m ago · ran 59m00s");
    expect(cards[0]?.textContent).not.toContain(" live");
    expect(cards[0]?.textContent).not.toContain("running");
  });

  it("says the sr-only count in sessions, the Unattached group not one of them", () => {
    const { container } = renderApp(<HistoryRail />, railState, NOW);
    expect(container.querySelector("p.sr-only")?.textContent).toBe("1 session in history");
  });

  it("scopes to a root on click, and marks the picked one with the aura", async () => {
    const { act, container } = renderApp(<HistoryRail />, railState, NOW);
    await userEvent.click(container.querySelector('button[data-card][data-value="r1/main"]') as HTMLElement);
    expect(act).toHaveBeenCalledWith("scope", JSON.stringify({ rootId: "r1/main", nodeId: null }));
    const picked = renderApp(
      <HistoryRail />,
      { ...railState, historyScope: { rootId: "r1/main", nodeId: null } },
      NOW,
    );
    const wrapper = picked.container.querySelector('button[data-value="r1/main"]')?.parentElement;
    expect(wrapper?.className).toContain("aura");
    expect(wrapper?.className).toContain("aura-sm");
    expect(picked.container.querySelector('button[data-value="r1/main"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    const bare = picked.container.querySelector('button[data-value="outside-a-session/main"]');
    expect(bare?.closest(".aura")).toBeNull();
  });

  it("clears the scope again on a second click of the picked root", async () => {
    const picked = renderApp(
      <HistoryRail />,
      { ...railState, historyScope: { rootId: "r1/main", nodeId: null } },
      NOW,
    );
    await userEvent.click(
      picked.container.querySelector('button[data-card][data-value="r1/main"]') as HTMLElement,
    );
    expect(picked.act).toHaveBeenCalledWith("scope-clear");
    // a different root still scopes, never clears
    await userEvent.click(
      picked.container.querySelector('button[data-card][data-value="outside-a-session/main"]') as HTMLElement,
    );
    expect(picked.act).toHaveBeenCalledWith(
      "scope",
      JSON.stringify({ rootId: "outside-a-session/main", nodeId: null }),
    );
  });

  it("loads more when a cursor exists, and not otherwise", async () => {
    const withMore = renderApp(<HistoryRail />, { ...railState, historyNext: 123 }, NOW);
    const more = withMore.container.querySelector('button[data-action="more-roots"]');
    expect(more?.textContent).toBe("Load more");
    await userEvent.click(more as HTMLElement);
    expect(withMore.act).toHaveBeenCalledWith("more-roots");
    withMore.unmount();
    const atEnd = renderApp(<HistoryRail />, railState, NOW);
    expect(atEnd.container.querySelector('button[data-action="more-roots"]')).toBeNull();
  });

  it("shows skeleton cards while the first page loads, and the words for nothing and failure", () => {
    const loading = renderApp(
      <HistoryRail />,
      { sessionsPanel: "history" as const, historyRootsLoading: true },
      NOW,
    );
    expect(loading.container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    loading.unmount();
    const idle = renderApp(
      <HistoryRail />,
      { sessionsPanel: "history" as const, historyRoots: null, historyRootsLoading: false },
      NOW,
    );
    expect(idle.container.textContent).toContain("No history loaded");
    idle.unmount();
    const empty = renderApp(<HistoryRail />, { sessionsPanel: "history" as const, historyRoots: [] }, NOW);
    expect(empty.container.textContent).toContain("Nothing in history here");
    empty.unmount();
    const failed = renderApp(
      <HistoryRail />,
      { sessionsPanel: "history" as const, historyRoots: [], historyRootsError: "GET → 503" },
      NOW,
    );
    expect(failed.container.textContent).toContain("GET → 503");
  });
});
