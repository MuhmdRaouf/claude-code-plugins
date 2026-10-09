import { screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import type { ProviderHealth, RouterHealth } from "../../src/router/health.ts";
import { RouterView } from "../../src/ui/app/views/Router.tsx";
import { renderApp } from "./render.tsx";

const NOW = 1_790_000_000_000;

const PROVIDER: ProviderHealth = {
  plugin: "zai",
  counts: { fallback: 2, refusal: 0, rate_limited: 1, budget_stop: 0, restart: 0 },
  series: [0, 1, 2],
  kindSeries: [],
  lastAt: NOW - 60_000,
  lastReason: "503",
};

const EMPTY_HEALTH: RouterHealth = { windowMs: 1, buckets: 3, providers: [], recent: [] };

const BUSY_HEALTH: RouterHealth = {
  windowMs: 1,
  buckets: 3,
  providers: [
    PROVIDER,
    { ...PROVIDER, plugin: "kimi", lastAt: null, lastReason: null },
    { ...PROVIDER, plugin: "deepseek", lastAt: NOW - 60_000, lastReason: null },
  ],
  recent: [
    { ts: NOW - 1000, plugin: "zai", event: "fallback", reason: "503", model: "glm-5.3" },
    { ts: NOW - 2000, plugin: "zai", event: "restart", reason: "", model: null },
  ],
};

describe("RouterView", () => {
  it("says what it is still waiting for while health and the advisor load", () => {
    const { container } = renderApp(<RouterView />, {}, NOW);
    expect(container.textContent).toContain("Router health");
    expect(container.textContent).toContain("Loading router events");
    expect(container.textContent).toContain("Model advisor");
    expect(container.textContent).toContain("Looking at recent runs");
    expect(container.textContent).not.toContain("Recent router events");
  });

  it("says when no provider router fired anything", () => {
    const { container } = renderApp(<RouterView />, { router: EMPTY_HEALTH }, NOW);
    expect(container.textContent).toContain("Last 24 hours");
    expect(container.textContent).toContain("No router events yet");
  });

  it("shows each provider with badges, its rate chart and its last event", () => {
    const { container } = renderApp(<RouterView />, { router: BUSY_HEALTH }, NOW);
    expect(container.textContent).toContain("Z.ai");
    expect(container.textContent).toContain("3 events in 24 h");
    for (const text of ["Fallbacks 2", "Rate limits 1"]) {
      expect(screen.getAllByText(text).map((b) => b.closest(".badge")?.className)).toEqual([
        "badge badge-warning badge-soft",
        "badge badge-warning badge-soft",
        "badge badge-warning badge-soft",
      ]);
    }
    for (const text of ["Refusals 0", "Budget stops 0", "Restarts 0"]) {
      expect(screen.getAllByText(text).map((b) => b.closest(".badge")?.className)).toEqual([
        "badge badge-ghost",
        "badge badge-ghost",
        "badge badge-ghost",
      ]);
    }
    expect(screen.getByText("Last 1m ago: 503")).toBeTruthy();
    expect(screen.getByText("Last 1m ago")).toBeTruthy();
    expect(container.textContent).toContain("No events");
    expect(container.textContent).toContain("2 per hour max");
    expect(container.textContent).toContain("24 h ago");
    expect(document.querySelector("svg.chart")).toBeTruthy();
  });

  it("lists recent events newest first, with reason and model when there are any", () => {
    renderApp(<RouterView />, { router: BUSY_HEALTH }, NOW);
    expect(screen.getByText("Recent router events")).toBeTruthy();
    expect(screen.getByText("Newest first")).toBeTruthy();
    const rows = document.querySelectorAll("ul.list > li.list-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Z.ai fell back to Anthropic")).toBeTruthy();
    expect(screen.getByText("503")).toBeTruthy();
    // the request's model reads as its chip: short name, raw id as its title
    const model = screen.getByText("GLM 5.3").closest(".model-chip");
    expect(model?.getAttribute("title")).toBe("glm-5.3");
    expect(screen.getByText("Z.ai restarted")).toBeTruthy();
    const restart = screen.getByText("Z.ai restarted").closest("li.list-row") as HTMLElement;
    expect(restart.querySelectorAll("p")).toHaveLength(1); // no reason line, no model line
  });

  it("hides the recent-events card when the window has none", () => {
    const { container } = renderApp(
      <RouterView />,
      { router: { ...EMPTY_HEALTH, providers: [PROVIDER] } },
      NOW,
    );
    expect(container.textContent).not.toContain("Recent router events");
  });

  it("shows the advisor's empty verdicts, cautiously", () => {
    const { unmount } = renderApp(
      <RouterView />,
      { advisor: { runsChecked: 0, candidates: 0, savingUsd: null, byModel: [], examples: [] } },
      NOW,
    );
    expect(screen.getByText("No subagent runs on a main model yet")).toBeTruthy();
    expect(document.querySelector(".empty-hint")?.textContent).toContain("0 runs checked");
    unmount();
    renderApp(
      <RouterView />,
      { advisor: { runsChecked: 3, candidates: 0, savingUsd: null, byModel: [], examples: [] } },
      NOW,
    );
    expect(screen.getByText("Every run looked like it needed its model")).toBeTruthy();
    expect(document.querySelector(".empty-hint")?.textContent).toContain("3 runs checked");
  });

  it("shows the advisor's count, saving and per-model rows when runs look flash-sized", () => {
    const { container } = renderApp(
      <RouterView />,
      {
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
      },
      NOW,
    );
    expect(document.querySelector(".empty") === null).toBe(true);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("of 4 runs look flash-sized, est. saving $0.09")).toBeTruthy();
    // model ids read through the chip: short name, raw id as its title
    expect(container.textContent).toContain("could run on GLM 5.3 Flash");
    expect(screen.getByText("GLM 5.3 Flash").closest(".model-chip")?.getAttribute("title")).toBe(
      "glm-5.3-flash",
    );
    expect(screen.getByText("$0.10 → $0.01")).toBeTruthy();
    expect(screen.getByText("unpriced")).toBeTruthy();
    const unpricedRow = screen.getByText("unpriced").closest("[data-advisor-row]") as HTMLElement;
    expect(unpricedRow.textContent).toContain("1 run");
    expect(unpricedRow.textContent).not.toContain("could run on");
  });

  it("leaves the saving out when none of the candidates is priced", () => {
    renderApp(
      <RouterView />,
      { advisor: { runsChecked: 1, candidates: 1, savingUsd: null, byModel: [], examples: [] } },
      NOW,
    );
    expect(screen.getByText("of 1 run look flash-sized")).toBeTruthy();
  });
});
