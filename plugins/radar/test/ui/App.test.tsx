import { screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import type { Summary } from "../../src/shared/model.ts";
import { ZERO_TOKENS } from "../../src/shared/model.ts";
import type { SessionListItem } from "../../src/store/store.ts";
import { App } from "../../src/ui/app/App.tsx";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;

function summary(): Summary {
  return {
    sessions: 1,
    liveSessions: 1,
    agents: 1,
    requests: 0,
    tokens: { ...ZERO_TOKENS },
    errors: 0,
    toolCalls: 0,
    latencyP50: null,
    latencyP95: null,
    startedAt: NOW - 60_000,
    now: NOW,
  };
}

function item(id: string): SessionListItem {
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
  };
}

describe("App", () => {
  it("builds the shell: glass top bar over the neon line, the tab groups, the rail and the view", () => {
    renderApp(<App />, { summary: summary(), sessions: [item("s1")] });
    const header = document.querySelector("[data-scope-header]");
    expect(header?.className).toContain("glass");
    expect(header?.className).toContain("sticky");
    expect(header?.querySelector(".navbar")).not.toBeNull();
    expect(header?.querySelector(".neon-line")).not.toBeNull();
    expect(document.querySelector(".drawer.lg\\:drawer-open")).not.toBeNull();
    expect(document.querySelector(".drawer-toggle#radar-rail")).not.toBeNull();
    expect(document.querySelector(".drawer-side aside")).not.toBeNull();
    const main = document.querySelector("main[data-view]");
    expect(main?.className).toContain("max-w-[1600px]");
    expect(main?.className).toContain("px-8");
    expect(main?.className).toContain("py-6");
  });

  it("opens every tab with its PageIntro: the tab's name and what to do there", () => {
    renderApp(<App />, { summary: summary(), sessions: [item("s1")] });
    const intro = document.querySelector("[data-page-intro]");
    expect(intro).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(intro?.textContent).toContain("The big picture for the sessions you are viewing");
    // the view opens under the intro; the intro carries the tile icon
    expect(intro?.querySelector("svg, img")).not.toBeNull();
  });

  it("splits the tabs into three groups: Activity, Spend and System, in order", () => {
    renderApp(<App />, { summary: summary() });
    const groups = [...document.querySelectorAll("[data-view-tabs] [role='tablist']")];
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Activity", "Spend", "System"]);
    const tabs = [...document.querySelectorAll('[data-view-tabs] [data-action="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("data-value"))).toEqual([
      "overview",
      "requests",
      "agents",
      "tools",
      "timeline",
      "models",
      "costs",
      "alerts",
      "router",
      "settings",
    ]);
  });

  it("marks the active tab and glows it, and counts alerts on the Alerts tab", () => {
    const alert = { id: "a1", kind: "context", sessionId: "", agentId: null, project: "" } as never;
    renderApp(<App />, { summary: summary(), tab: "alerts", alerts: [alert, alert] });
    const alerts = screen.getByRole("tab", { name: /Alerts/ });
    expect(alerts.getAttribute("aria-current")).toBe("page");
    expect(alerts.className).toContain("tab-active");
    expect(alerts.className).toContain("neon-text");
    expect(alerts.querySelector(".badge.badge-error")?.textContent).toBe("2");
  });

  it("shows the intro and skeletons in both columns until the first snapshot arrives", () => {
    renderApp(<App />);
    expect(screen.getByText(/Connecting to the radar server/)).toBeTruthy();
    const skeletons = document.querySelectorAll(".skeleton");
    expect(skeletons.length).toBeGreaterThan(4);
  });

  it("renders the view the tab names", () => {
    renderApp(<App />, { summary: summary(), tab: "agents" });
    expect(screen.getByRole("tab", { name: /Agents/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("No agents to show")).toBeTruthy();
  });

  it("mounts the session's own agents table while one session is picked", () => {
    const { container } = renderApp(
      <App />,
      { summary: summary(), tab: "agents", session: "s1", sessions: [item("s1")] },
      NOW,
    );
    expect(container.textContent).toContain("Loading this session's agents…");
    expect(container.textContent).not.toContain("No agents to show");
  });
});
