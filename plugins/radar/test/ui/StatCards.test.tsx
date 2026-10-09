import { screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { BudgetSpend } from "../../src/budget/budgets.ts";
import { type Summary, ZERO_TOKENS } from "../../src/shared/model.ts";
import type { SessionListItem } from "../../src/store/store.ts";
import { liveSessions } from "../../src/ui/app/Sessions.tsx";
import { BudgetCard, costSplitText, SessionScopePanel, StatCards } from "../../src/ui/app/StatCards.tsx";
import { makeRequest, makeTool } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;

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

function sessionItem(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s1",
    project: "app",
    cwd: "/Users/raouf/work/app",
    name: null,
    branch: null,
    repo: null,
    parentSessionId: null,
    startedAt: null,
    endedAt: null,
    live: true,
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

/** The sessions the summary's numbers describe: two registry-live main sessions, one ended, one job. */
const SESSIONS = [
  sessionItem({ id: "live-1", lastAt: 3 }),
  sessionItem({ id: "live-2", lastAt: 2 }),
  sessionItem({ id: "ended", live: false, lastAt: 1 }),
  sessionItem({ id: "job:x", external: true, lastAt: 4 }),
];

function texts(selector: string): string[] {
  return [...document.querySelectorAll(selector)].map((node) => node.textContent ?? "");
}

describe("StatCards", () => {
  it("lays the seven numbers into one grid of panel cards, cost first", () => {
    renderApp(<StatCards />, { summary: SUMMARY, sessions: SESSIONS }, NOW);
    const cards = [...document.querySelectorAll(".stats.panel")];
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      expect(card.className).toContain("panel");
      const stat = card.querySelector(".stat");
      expect(stat?.className).toContain("p-5");
    }
    expect(texts(".stat-title")).toEqual([
      "Est. cost today",
      "Sessions",
      "Agents",
      "Requests",
      "Tool calls",
      "Errors",
      "Latency p95",
    ]);
    // with nothing in the last hour, the range-following numbers read zero and a dash, not the all-time totals
    expect(texts(".stat-value")).toEqual(["–", "3", "7", "0", "0", "0", "–"]);
    expect(texts(".stat-desc")).toEqual([
      "Nothing priced yet. A Claude subscription may cover Claude usage; these are API list prices.",
      "2 live now, 1 ended",
      "all time",
      "in the last 1 hour",
      "in the last 1 hour",
      "in the last 1 hour",
      "in the last 1 hour",
    ]);
    expect(texts(".stat-desc .presence-word")).toEqual(["2 live now, 1 ended"]);
    expect(document.querySelector(".dot-pulse")).not.toBeNull();
  });

  it("counts the sessions the rail's live tab counts: registry-live main sessions, never jobs", () => {
    // the summary counts every live session view, jobs included; the stat must match the rail instead
    const rail = liveSessions(SESSIONS).length;
    const rendered = renderApp(<StatCards />, { summary: SUMMARY, sessions: SESSIONS }, NOW);
    expect(rail).toBe(2);
    expect(texts(".stat-desc .presence-word")).toEqual(["2 live now, 1 ended"]);
    rendered.unmount();
    // a fleet of live jobs over five open sessions says 5, as the rail does
    const fleet = [
      ...Array.from({ length: 5 }, (_, i) => sessionItem({ id: `s${i}`, lastAt: 100 - i })),
      ...Array.from({ length: 12 }, (_, i) =>
        sessionItem({ id: `job:${i}`, external: true, lastAt: 200 - i }),
      ),
    ];
    renderApp(
      <StatCards />,
      { summary: { ...SUMMARY, liveSessions: 17, sessions: 22 }, sessions: fleet },
      NOW,
    );
    expect(texts(".stat-value")[1]).toBe("5");
    expect(texts(".stat-desc .presence-word")).toEqual(["5 live now"]);
  });

  it("counts the selected range: requests, tools, errors and latency from its own window", () => {
    renderApp(
      <StatCards />,
      {
        summary: SUMMARY,
        sessions: SESSIONS,
        requests: [
          makeRequest({ id: "r1", ts: NOW - 60_000, latencyMs: 1_000 }),
          makeRequest({ id: "r2", ts: NOW - 120_000, latencyMs: 3_000, stopReason: "api_error" }),
          makeRequest({ id: "old", ts: NOW - 3_780_000, latencyMs: 60_000 }),
        ],
        tools: [
          makeTool({ id: "t1", startedAt: NOW - 60_000, ok: false }),
          makeTool({ id: "t2", startedAt: NOW - 120_000, ok: true }),
        ],
      },
      NOW,
    );
    // two requests, one tool call, one failure plus one error stop; percentiles over the two in-range latencies
    expect(texts(".stat-value")).toEqual(["–", "3", "7", "2", "2", "2", "2.9s"]);
    expect(texts(".stat-desc")).toEqual([
      "Nothing priced yet. A Claude subscription may cover Claude usage; these are API list prices.",
      "2 live now, 1 ended",
      "all time",
      "in the last 1 hour",
      "in the last 1 hour1 failed",
      "in the last 1 hourNeeds a look",
      "Median 2sin the last 1 hour",
    ]);
  });

  it("counts Claude Code's notices in the range the way the all-time count does", () => {
    renderApp(
      <StatCards />,
      {
        summary: SUMMARY,
        sessions: SESSIONS,
        // the old anchor keeps the hour memory-backed (the range answers from records in hand)
        requests: [
          makeRequest({ id: "r1", ts: NOW - 60_000, stopReason: "api_error" }),
          makeRequest({ id: "old", ts: NOW - 3_780_000 }),
        ],
        events: [
          {
            seq: 1,
            ts: NOW - 60_000,
            kind: "Notice",
            sessionId: "live-1",
            agentId: null,
            label: null,
            payload: null,
          },
          {
            seq: 2,
            ts: NOW - 7_200_000,
            kind: "Notice",
            sessionId: "live-1",
            agentId: null,
            label: null,
            payload: null,
          },
        ],
      },
      NOW,
    );
    // one error stop plus the in-range notice; the two-hour-old second notice stays out of the hour
    expect(texts(".stat-value")).toEqual(["–", "3", "7", "1", "0", "2", "100ms"]);
  });

  it("keeps only true sublines: nothing live and nothing broken leaves them out entirely", () => {
    const failing = renderApp(
      <StatCards />,
      { summary: SUMMARY, sessions: SESSIONS, tools: [makeTool({ ok: false, startedAt: NOW - 60_000 })] },
      NOW,
    );
    expect(texts(".stat-desc .presence-word")).toContain("1 failed");
    failing.unmount();
    renderApp(
      <StatCards />,
      {
        summary: { ...SUMMARY, liveSessions: 0, errors: 0 },
        sessions: SESSIONS.filter((item) => !item.live),
      },
      NOW,
    );
    expect(texts(".stat-desc")).toEqual([
      "Nothing priced yet. A Claude subscription may cover Claude usage; these are API list prices.",
      "all time",
      "in the last 1 hour",
      "in the last 1 hour",
      "in the last 1 hour",
      "in the last 1 hour",
    ]);
    expect(texts(".stat-desc")).not.toContain("None live");
    expect(texts(".stat-desc")).not.toContain("All clear");
    expect(texts(".stat-desc")).not.toContain("None failed");
  });

  it("shows nothing but an empty grid before the first snapshot", () => {
    renderApp(<StatCards />);
    const grid = document.querySelector("[data-stat-cards]");
    expect(grid).toBeTruthy();
    expect(grid?.childElementCount).toBe(0);
    expect(screen.queryByText("Sessions")).toBeNull();
  });

  it("costs the picked sessions: one, several, or everything loaded", () => {
    const sessions = [sessionItem({ id: "s1", costUsd: 0.25 }), sessionItem({ id: "s2", costUsd: 1 })];
    const picked = renderApp(
      <StatCards />,
      { summary: { ...SUMMARY, costUsd: 1.5 }, selected: ["s1"], sessions },
      NOW,
    );
    expect(texts(".stat-value")[0]).toBe("–");
    expect(texts(".stat-desc")[0]).toBe("$0.25 in this session (estimate)");
    picked.unmount();
    const unpriced = renderApp(
      <StatCards />,
      {
        summary: { ...SUMMARY, costUsd: null },
        selected: ["s1"],
        sessions: [sessionItem({ id: "s1", costUsd: null })],
        spendToday: 0.5,
      },
      NOW,
    );
    expect(texts(".stat-desc")[0]).toBe("Nothing priced in this session (estimate)");
    unpriced.unmount();
    const set = renderApp(
      <StatCards />,
      { summary: { ...SUMMARY, costUsd: 1.5 }, selected: ["s1", "s2"], sessions, spendToday: 0.5 },
      NOW,
    );
    expect(texts(".stat-desc")[0]).toBe("$1.25 across 2 picked sessions (estimate)");
    set.unmount();
    renderApp(<StatCards />, { summary: { ...SUMMARY, costUsd: 1.5 }, spendToday: 0.5 }, NOW);
    expect(texts(".stat-value")[0]).toBe("$0.50");
    expect(texts(".stat-desc")[0]).toBe("$1.50 across all sessions (estimate)");
  });

  it("sums the picked sessions' items for a multi-pick: sessions, agents, cost and stored requests", () => {
    renderApp(
      <StatCards />,
      {
        summary: SUMMARY,
        // a fixed end sends the range to the history route, where only the stored counts can answer
        range: { preset: null, from: 0, to: NOW - 1 },
        sessions: [
          sessionItem({ id: "s1", live: true, agentCount: 4, requestCount: 9, costUsd: 0.25 }),
          sessionItem({ id: "s2", live: false, agentCount: 2, requestCount: 5, costUsd: 1 }),
          sessionItem({ id: "s3", live: true, agentCount: 7, requestCount: 1 }),
        ],
        selected: ["s1", "s2"],
      },
      NOW,
    );
    // the range-scoped counts cannot follow a picked set onto the history route, so they say all time
    expect(texts(".stat-value")).toEqual(["–", "2", "6", "14", "8", "2", "2m34s"]);
    expect(texts(".stat-desc")).toEqual([
      "$1.25 across 2 picked sessions (estimate)",
      "1 of 2 live now",
      "in the picked sessions, all time",
      "in 2 picked sessions, all time",
      "all time",
      "all time",
      "Median 41s, all time",
    ]);
  });

  it("says nothing is priced today when only the ledger has a number", () => {
    renderApp(<StatCards />, { summary: SUMMARY, spendToday: 0 }, NOW);
    expect(texts(".stat-desc")[0]).toBe("Nothing priced across all sessions (estimate)");
  });
});

describe("SessionScopePanel", () => {
  const picked = {
    summary: SUMMARY,
    selected: ["s1"],
    sessions: [
      sessionItem({
        id: "s1",
        name: "Fleet sweep",
        branch: "homelab",
        startedAt: NOW - 600_000,
        costUsd: 42.05,
        costSplitUsd: { claude: 38.02, glm: 4.03, other: null },
      }),
    ],
  };

  it("shows the scope facts that left the old header for the one picked session", () => {
    renderApp(<SessionScopePanel />, picked, NOW);
    const panel = document.querySelector(".panel");
    expect(panel?.textContent).toContain("Session");
    expect(panel?.textContent).toContain("Fleet sweep");
    expect(panel?.textContent).toContain("~/work/app");
    expect(panel?.textContent).toContain("homelab");
    expect(panel?.textContent).toContain("10m ago");
    expect(panel?.textContent).toContain("$38.02 Claude / $4.03 GLM");
    expect(panel?.textContent).toContain("Live");
  });

  it("hides for no pick, for several, and for a pick the list has not seen", () => {
    const none = renderApp(<SessionScopePanel />, { summary: SUMMARY, sessions: SESSIONS }, NOW);
    expect(document.querySelector(".panel")).toBeNull();
    none.unmount();
    const two = renderApp(<SessionScopePanel />, { ...picked, selected: ["s1", "s2"] }, NOW);
    expect(document.querySelector(".panel")).toBeNull();
    two.unmount();
    renderApp(<SessionScopePanel />, { ...picked, selected: ["ghost"] }, NOW);
    expect(document.querySelector(".panel")).toBeNull();
  });

  it("reads an ended session and skips the split when nothing prices", () => {
    renderApp(
      <SessionScopePanel />,
      {
        ...picked,
        sessions: [sessionItem({ id: "s1", live: false, costUsd: null })],
      },
      NOW,
    );
    const panel = document.querySelector(".panel");
    expect(panel?.textContent).toContain("Ended");
    expect(panel?.textContent).not.toContain("GLM");
  });
});

describe("costSplitText", () => {
  it("shows every priced family, a dash where a family has no price, and null when nothing prices", () => {
    expect(costSplitText({ claude: 38.02, glm: 4.03, other: null })).toBe("$38.02 Claude / $4.03 GLM");
    expect(costSplitText({ claude: null, glm: 1.4, other: 0.1 })).toBe("– Claude / $1.40 GLM / $0.10 other");
    expect(costSplitText({ claude: null, glm: null, other: null })).toBeNull();
  });
});

describe("BudgetCard", () => {
  it("renders nothing when no budget is set", () => {
    const { container } = renderApp(<BudgetCard />);
    expect(container.querySelector(".panel")).toBeNull();
  });

  it("draws budget bars by tone on the shared panel, with a stop rule per budget", () => {
    renderApp(
      <BudgetCard />,
      {
        budgetStatus: {
          version: 1,
          updatedAt: NOW,
          stopped: [],
          spend: [SPEND(10), SPEND(85, "warn"), SPEND(120), SPEND(130, "warn")],
        },
      },
      NOW,
    );
    expect(document.querySelector(".panel")).not.toBeNull();
    expect(screen.getByText("Budgets")).toBeTruthy();
    expect(screen.getByText("Estimated spend against each limit")).toBeTruthy();
    expect(texts(".badge")).toEqual(["On track", "Near", "Stopped", "Over"]);
    expect(texts(".badge").map((_, i) => document.querySelectorAll(".badge")[i]?.className)).toEqual([
      "badge badge-sm badge-success badge-soft shrink-0",
      "badge badge-sm badge-warning badge-soft shrink-0",
      "badge badge-sm badge-error badge-soft shrink-0",
      "badge badge-sm badge-error badge-soft shrink-0",
    ]);
    expect(texts("[data-budget-row] .font-medium")).toEqual([
      "Z.ai, today",
      "Z.ai, today",
      "Z.ai, today",
      "Z.ai, today",
    ]);
    expect(texts("[data-budget-row] .text-base-content\\/60")).toEqual([
      "Stops requests at 100%",
      "Warns only",
      "Stops requests at 100%",
      "Warns only",
    ]);
    expect(texts("[data-budget-row] .num")[0]).toBe("$1.00 of $10.00 (10%)");
    // the 120% budget is capped at a full bar; its action is warn, but 130% still reads as an error
    expect([...document.querySelectorAll<HTMLElement>(".bar-seg")].map((seg) => seg.style.width)).toEqual([
      "10.00%",
      "85.00%",
      "100.00%",
      "100.00%",
    ]);
    expect(
      [...document.querySelectorAll<HTMLElement>(".bar-seg")].map((seg) => seg.style.background),
    ).toEqual(["var(--success)", "var(--warning)", "var(--danger)", "var(--danger)"]);
  });

  it("opens the settings tab from the Edit button", async () => {
    const { act } = renderApp(
      <BudgetCard />,
      {
        budgetStatus: { version: 1, updatedAt: NOW, stopped: [], spend: [SPEND(10)] },
      },
      NOW,
    );
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("data-action")).toBe("tab");
    expect(edit.getAttribute("data-value")).toBe("settings");
    expect(edit.className).toContain("btn-ghost");
    await userEvent.click(edit);
    expect(act).toHaveBeenCalledWith("tab", "settings");
  });
});
