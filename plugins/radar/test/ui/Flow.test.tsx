import { fireEvent, act as flush, screen } from "@testing-library/preact";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Summary, ZERO_TOKENS } from "../../src/shared/model.ts";
import { bucketPlan } from "../../src/shared/time-range.ts";
import { Flow } from "../../src/ui/app/Flow.tsx";
import { fmtClock } from "../../src/ui/fmt.ts";
import { makeRequest } from "../helpers.ts";
import { renderApp } from "./render.tsx";

const NOW = 1_800_000_000_000;
const SUMMARY: Summary = {
  sessions: 1,
  liveSessions: 1,
  agents: 1,
  requests: 2,
  tokens: { ...ZERO_TOKENS, input: 1_000, output: 1_500 },
  errors: 0,
  toolCalls: 0,
  latencyP50: 1_000,
  latencyP95: 2_000,
  startedAt: NOW - 60_000,
  now: NOW,
};

/** Mock prefers-reduced-motion so the hero shows its target at once (or tweens when false). */
function motion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }));
}

const hero = () => document.querySelector("[data-role=hero-value]")?.textContent;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Flow", () => {
  it("totals the range's tokens, with a legend, a cache note and the range control", async () => {
    motion(true);
    const requests = [
      // the oldest request sits on the window's left edge, so the hour is answered from memory
      makeRequest({ id: "old", ts: NOW - 3_600_000, tokens: { ...ZERO_TOKENS } }),
      makeRequest({ id: "a", ts: NOW - 10_000, tokens: { ...ZERO_TOKENS, input: 100, cacheRead: 300 } }),
    ];
    const { act } = renderApp(
      <Flow />,
      { summary: SUMMARY, requests, range: { preset: "1h", from: 0, to: null } },
      NOW,
    );
    expect(screen.getByText("400").getAttribute("data-role")).toBe("hero-value");
    expect(screen.getByText("tokens in the last 1 hour")).toBeTruthy();
    expect(screen.getByText("Last 1 hour, 1 min per bar")).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Tokens in the Last 1 hour" }).querySelectorAll("li"),
    ).toHaveLength(4);
    expect(screen.getByText("75% of prompt tokens came from cache")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Stacked token chart for the Last 1 hour" }).querySelector("svg"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Last 1 hour/ }));
    await userEvent.click(screen.getByRole("button", { name: "Last 24 hours" }));
    expect(act).toHaveBeenCalledWith("range", "24h");
  });

  it("scopes to the picked session and says when nothing came from cache", () => {
    motion(true);
    const sessions = [{ id: "s1", project: "homelab", tokens: 42 } as never];
    renderApp(
      <Flow />,
      {
        summary: SUMMARY,
        sessions,
        session: "s1",
        range: { preset: "5m", from: 0, to: null },
        // the oldest request sits on the window's left edge, so memory answers the whole 5 minutes
        requests: [
          makeRequest({ id: "old", ts: NOW - 300_000, tokens: { ...ZERO_TOKENS } }),
          makeRequest({ id: "a", ts: NOW - 10_000, tokens: { ...ZERO_TOKENS } }),
        ],
      },
      NOW,
    );
    expect(hero()).toBe("0");
    expect(screen.getByText("tokens in this session, last 5 minutes")).toBeTruthy();
    expect(screen.getByText("No cache reads in this window")).toBeTruthy();
  });

  it("falls back to the session's own total when only the history route could answer the range", () => {
    motion(true);
    const sessions = [{ id: "s1", project: "homelab", tokens: 42 } as never];
    renderApp(
      <Flow />,
      { summary: SUMMARY, sessions, session: "s1", range: { preset: "7d", from: 0, to: null } },
      NOW,
    );
    expect(hero()).toBe("42");
    expect(screen.getByText("tokens in this session, all time")).toBeTruthy();
  });

  it("counts up to a new total instead of jumping, and never past it", async () => {
    motion(false);
    let frame = 0;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      frame += 1;
      return frame;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const { rerender, value } = renderApp(
      <Flow />,
      { summary: { ...SUMMARY, tokens: { ...ZERO_TOKENS } } },
      NOW,
    );
    expect(hero()).toBe("0");
    const { AppContext } = await import("../../src/ui/app/context.ts");
    rerender(
      <AppContext.Provider
        value={{
          ...value,
          state: {
            ...value.state,
            // the edge request keeps the hour answered from memory, so the tween has a target at once
            requests: [
              makeRequest({ id: "old", ts: NOW - 3_600_000, tokens: { ...ZERO_TOKENS } }),
              makeRequest({
                id: "big",
                ts: NOW - 10_000,
                tokens: { ...ZERO_TOKENS, input: 1_000, output: 1_500 },
              }),
            ],
          },
        }}
      >
        <Flow />
      </AppContext.Provider>,
    );
    const start = performance.now();
    await flush(() => frames.shift()?.(start + 150));
    const mid = Number(
      screen.getByText(/\d/, { selector: "[data-role=hero-value]" }).textContent?.replace("k", "e3"),
    );
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(2_500);
    await flush(() => frames.shift()?.(start + 1_000));
    expect(hero()).toBe("2.5k");
  });

  it("shows a crosshair and a per-kind tooltip under the pointer, and hides it on leave", () => {
    motion(true);
    const requests = [
      makeRequest({ id: "old", ts: NOW - 300_000 }),
      makeRequest({ id: "a", ts: NOW - 1_000, tokens: { ...ZERO_TOKENS, input: 7, output: 3 } }),
    ];
    renderApp(<Flow />, { summary: SUMMARY, requests, range: { preset: "5m", from: 0, to: null } }, NOW);
    const chart = screen.getByRole("img", { name: /Stacked token chart/ });
    const svg = chart.querySelector("svg");
    if (svg === null) throw new Error("no svg");
    svg.getBoundingClientRect = () => ({ left: 0, top: 100, width: 600, height: 168 }) as DOMRect;
    fireEvent.pointerMove(chart, { clientX: 599, clientY: 150 });
    const tip = document.querySelector(".chart-tip");
    expect(tip?.querySelector(".tip-head")?.textContent).toMatch(/10 tokens$/);
    expect(tip?.querySelectorAll(".tip-line")).toHaveLength(4);
    expect((document.querySelector(".chart-cross") as HTMLElement).style.height).toBe("168px");
    fireEvent.pointerMove(chart, { clientX: 900, clientY: 150 }); // past the plot: no bucket
    expect(document.querySelector(".chart-tip")).toBeNull();
    fireEvent.pointerMove(chart, { clientX: 10, clientY: 150 });
    expect(document.querySelector(".chart-tip")).not.toBeNull();
    fireEvent.pointerLeave(chart);
    expect(document.querySelector(".chart-tip")).toBeNull();
  });

  it("clocks the tooltip by the bucket under the pointer: the left edge is the window's start", () => {
    motion(true);
    const requests = [
      makeRequest({ id: "old", ts: NOW - 300_000 }),
      makeRequest({ id: "a", ts: NOW - 1_000, tokens: { ...ZERO_TOKENS, input: 7, output: 3 } }),
    ];
    renderApp(<Flow />, { summary: SUMMARY, requests, range: { preset: "5m", from: 0, to: null } }, NOW);
    const chart = screen.getByRole("img", { name: /Stacked token chart/ });
    const svg = chart.querySelector("svg");
    if (svg === null) throw new Error("no svg");
    svg.getBoundingClientRect = () => ({ left: 0, top: 100, width: 600, height: 168 }) as DOMRect;
    const from = NOW - 300_000;
    const { bucketMs, buckets } = bucketPlan(from, NOW);
    fireEvent.pointerMove(chart, { clientX: 1, clientY: 150 }); // the oldest bucket sits at the left edge
    expect(document.querySelector(".chart-tip .tip-head")?.textContent).toContain(fmtClock(from));
    fireEvent.pointerMove(chart, { clientX: 599, clientY: 150 }); // the newest bucket sits at the right edge
    expect(document.querySelector(".chart-tip .tip-head")?.textContent).toContain(
      fmtClock(from + (buckets - 1) * bucketMs),
    );
  });

  it("draws the fetched history answer when the range runs on the history route", () => {
    motion(true);
    renderApp(
      <Flow />,
      {
        summary: SUMMARY,
        range: { preset: "7d", from: 0, to: null },
        flow: {
          key: "range=7d",
          series: {
            from: NOW - 7 * 86_400_000,
            to: NOW,
            bucketMs: 10_800_000,
            requests: [1],
            kinds: { input: [2], output: [3], cacheRead: [0], cacheWrite: [0] },
          },
        },
      },
      NOW,
    );
    expect(screen.getByText("Last 7 days, 3 h per bar")).toBeTruthy();
    // the legend and the headline total the fetched answer, not the (empty) requests in memory
    expect(screen.getByText("2")).toBeTruthy();
    expect(hero()).toBe("5");
    expect(screen.getByText("tokens in the last 7 days")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Stacked token chart/ }).querySelector("svg")).toBeTruthy();
  });

  it("shows a skeleton while the fetch runs and an alert when history did not answer", () => {
    motion(true);
    const { container } = renderApp(
      <Flow />,
      { summary: SUMMARY, range: { preset: "7d", from: 0, to: null }, flowLoading: true },
      NOW,
    );
    expect(screen.getByRole("status", { name: "Loading token flow" })).toBeTruthy();
    expect(container.querySelector(".skeleton")).toBeTruthy();
    // the headline and the legend wait as skeletons too, never zeros that read as a quiet range
    expect(container.querySelectorAll("[data-legend-value] .skeleton")).toHaveLength(4);
    expect(container.querySelector("[data-role=hero-value] .skeleton")).toBeTruthy();
    const failed = renderApp(
      <Flow />,
      {
        summary: SUMMARY,
        range: { preset: "7d", from: 0, to: null },
        flowError: "GET /api/history/flow → 503",
      },
      NOW,
    );
    expect(failed.container.querySelector(".alert-error")?.textContent).toMatch(/History did not answer/);
  });

  it("offers a reset button once the range is custom, and resets on it and on a double-click", async () => {
    motion(true);
    const { act } = renderApp(
      <Flow />,
      { summary: SUMMARY, range: { preset: null, from: NOW - 600_000, to: NOW - 60_000 } },
      NOW,
    );
    const reset = screen.getByRole("button", { name: "Reset to last 1 hour" });
    await userEvent.click(reset);
    expect(act).toHaveBeenCalledWith("range-reset");
    fireEvent.dblClick(screen.getByRole("img", { name: /Stacked token chart/ }));
    expect(act).toHaveBeenCalledWith("range-reset");
  });

  it("zooms to a dragged span and shows the selection while dragging", () => {
    motion(true);
    const { act } = renderApp(
      <Flow />,
      { summary: SUMMARY, range: { preset: "5m", from: 0, to: null } },
      NOW,
    );
    const chart = screen.getByRole("img", { name: /Stacked token chart/ });
    const svg = chart.querySelector("svg");
    if (svg === null) throw new Error("no svg");
    svg.getBoundingClientRect = () => ({ left: 0, top: 100, width: 600, height: 168 }) as DOMRect;
    // a click is not a zoom
    fireEvent.pointerDown(chart, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(chart, { clientX: 102, button: 0 });
    expect(act).not.toHaveBeenCalledWith("range-custom", expect.anything());
    fireEvent.pointerDown(chart, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(chart, { clientX: 250 });
    const selection = document.querySelector("[data-role=flow-plot] .bg-base-content\\/10");
    expect(selection).not.toBeNull();
    fireEvent.pointerUp(chart, { clientX: 250, button: 0 });
    // 5m over 600px: 100→250 maps to from+50_000 … from+125_000
    const from = NOW - 300_000;
    expect(act).toHaveBeenCalledWith("range-custom", `from=${from + 50_000}&to=${from + 125_000}`);
    expect(document.querySelector(".hero-chart .bg-base-content\\/10")).toBeNull();
  });
});
