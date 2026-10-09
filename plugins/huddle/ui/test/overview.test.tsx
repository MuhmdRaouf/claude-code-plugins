// overview.test.tsx — the Overview page: the plan's ring and its per-state breakdown, the stat
// cards, the needs banner, Radar's estimated cost, the conflicts card over GET /conflicts, the
// activity chart with its kept window, and the pure helpers (ovVals/ovSub/ovTexts/ovRows/ovSeries).
import { act, fireEvent, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Api, createApi, type FetchFn } from "../src/api.ts";
import {
  type ConflictFile,
  Overview,
  ovRows,
  ovSeries,
  ovSub,
  ovTexts,
  ovVals,
} from "../src/pages/Overview.tsx";
import { readPref, type Storage } from "../src/storage.ts";
import { createStore, type FeedEvent, type HuddleState, type Timers } from "../src/store.ts";
import { renderHuddle } from "./render";

const NOW = Date.parse("2026-10-08T12:00:00Z");

/** Site storage the tests read back. */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

/** A JSON response with the usual content type. */
function jsonResponse(v: unknown): Response {
  return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
}

const ev = (seq: number, minsAgo: number): FeedEvent =>
  ({ seq, topic: "msg", from: "api", ts: new Date(NOW - minsAgo * 60000).toISOString() }) as FeedEvent;

/** The state of a channel mid-plan: four tasks, two sessions, one ask, a few events. */
function state(over: Partial<HuddleState> = {}): Partial<HuddleState> {
  return {
    ch: "dev",
    info: {
      name: "dev",
      config: { title: "Checkout", description: "The shop plan" },
      stats: { knowledge: 3, last: 42 },
      views: [],
    },
    board: {
      phases: [{ n: 1, title: "One" }],
      steps: [
        { id: "t1", title: "Done one", status: "done" },
        { id: "t2", title: "Doing two", status: "doing" },
        { id: "t3", title: "Waiting three", status: "todo", blocked_by: ["t2"] },
        { id: "t4", title: "Blocked four", status: "blocked" },
      ],
    },
    sessions: {
      sessions: [
        { name: "api", state: "working", parent: null },
        { name: "api.worker", state: "working", parent: "api" },
      ],
    },
    timeline: [ev(7, 1), ev(8, 2), ev(9, 40)],
    attention: { asks: [{ seq: 5, from: "api" }], gates: [], paused: [], blocked: [] },
    ...over,
  };
}

const CONFLICTS = {
  window_min: 30,
  conflicts: [
    {
      path: "src/app.ts",
      repo: "/repo",
      repo_name: "shop",
      sessions: [
        { name: "api", at: "2026-10-08T11:59:00Z" },
        { name: "owl", at: "2026-10-08T11:58:00Z" },
      ],
    } satisfies ConflictFile,
  ],
};

/** The fetch the page sees: conflicts for the conflicts path, {} for anything else. */
const fetchF =
  (conflicts: unknown = CONFLICTS): FetchFn =>
  (url) => {
    if (String(url).includes("/conflicts")) return Promise.resolve(jsonResponse(conflicts));
    return Promise.resolve(jsonResponse({}));
  };

/** The real API client over a fetch, so the store and the page read the same routes. */
const apiOver = (fetchFn: FetchFn): Api => createApi(fetchFn, () => {});

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
});

describe("Overview plan progress", () => {
  it("shows the ring, the done count and the breakdown", () => {
    renderHuddle(<Overview />, state(), NOW, fetchF());
    expect(screen.getByRole("img", { name: "25% of the tasks done" })).not.toBeNull();
    expect(document.querySelector('[data-ov="done"]')?.textContent).toBe("1");
    expect(document.querySelector('[data-ov="total"]')?.textContent).toBe("4");
    expect(document.querySelector('[data-ovtxt="sub"]')?.textContent).toBe("25% of the plan across 1 phase");
    expect(screen.getByText("Doing")).not.toBeNull();
    expect(screen.getByText("Waiting on others")).not.toBeNull();
    expect(screen.getByText("Blocked")).not.toBeNull();
    expect(screen.getByText("To do")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Blocked: 1 of 4" })).not.toBeNull();
  });

  it("says nothing is planned on an empty board", () => {
    renderHuddle(
      <Overview />,
      state({
        board: { phases: [], steps: [] },
        attention: { asks: [], gates: [], paused: [], blocked: [] },
      }),
      NOW,
      fetchF(),
    );
    expect(screen.getByText("Nothing planned yet")).not.toBeNull();
    expect(screen.getByRole("img", { name: "0% of the tasks done" })).not.toBeNull();
  });
});

describe("Overview stats", () => {
  it("counts the sessions, the questions, the knowledge and the events", () => {
    renderHuddle(<Overview />, state(), NOW, fetchF());
    expect(screen.getByText("Sessions online")).not.toBeNull();
    expect(screen.getByText("1 top-level, 1 subagent")).not.toBeNull();
    expect(screen.getByText("Questions for you")).not.toBeNull();
    expect(screen.getByText("Waiting in your Inbox")).not.toBeNull();
    expect(screen.getByText("Entries the sessions share")).not.toBeNull();
    expect(screen.getByText("Published in this channel")).not.toBeNull();
  });

  it("names the empty roster and the answered questions", () => {
    renderHuddle(
      <Overview />,
      state({
        sessions: { sessions: [] },
        attention: { asks: [], gates: [], paused: [], blocked: [] },
      }),
      NOW,
      fetchF(),
    );
    expect(screen.getByText("Nobody online")).not.toBeNull();
    expect(screen.getByText("All answered")).not.toBeNull();
  });
});

describe("Overview needs banner", () => {
  it("counts what needs the owner and links to the Inbox", () => {
    const { value } = renderHuddle(<Overview />, state(), NOW, fetchF());
    expect(screen.getByText("1 thing needs you")).not.toBeNull();
    expect(screen.getByText("1 question")).not.toBeNull();
    expect(document.querySelector('a[href="#/c/dev/inbox"]')).not.toBeNull();
    expect(value.go).toBeDefined();
  });

  it("joins the attention kinds and the extras' needs", () => {
    renderHuddle(
      <Overview />,
      state({
        attention: {
          asks: [
            { seq: 1, from: "api" },
            { seq: 2, from: "owl" },
          ],
          gates: [{ id: "t9" }],
          paused: [{ name: "api" }],
          blocked: [],
        },
        extras: {
          ch: "dev",
          approvals: [
            { seq: 1, from: "api" },
            { seq: 2, from: "owl" },
          ],
          obs: null,
        },
      }),
      NOW,
      fetchF(),
    );
    expect(screen.getByText("6 things need you")).not.toBeNull();
    expect(
      screen.getByText("2 questions, 1 approval, 1 paused session, 2 permission requests"),
    ).not.toBeNull();
  });

  it("stays out when nothing needs the owner", () => {
    renderHuddle(
      <Overview />,
      state({ attention: { asks: [], gates: [], paused: [], blocked: [] } }),
      NOW,
      fetchF(),
    );
    expect(document.querySelector("[data-needs]")).toBeNull();
  });
});

describe("Overview cost card", () => {
  it("shows Radar's estimated cost per session when Radar runs", () => {
    renderHuddle(
      <Overview />,
      state({
        extras: {
          ch: "dev",
          approvals: [],
          obs: { available: true, total: 12, cost: { api: 8, owl: 4 }, range: "day" },
        },
      }),
      NOW,
      fetchF(),
    );
    expect(screen.getByText("Estimated cost today")).not.toBeNull();
    expect(screen.getByText("$12.00")).not.toBeNull();
    expect(screen.getByRole("img", { name: "owl: $4.00" })).not.toBeNull();
  });

  it("says nothing was spent when Radar runs without figures", () => {
    renderHuddle(
      <Overview />,
      state({
        extras: { ch: "dev", approvals: [], obs: { available: true, total: 0, cost: {}, range: "day" } },
      }),
      NOW,
      fetchF(),
    );
    expect(screen.getByText("No spend recorded for this channel's sessions today.")).not.toBeNull();
  });

  it("stays out without Radar", () => {
    renderHuddle(<Overview />, state(), NOW, fetchF());
    expect(screen.queryByText("Estimated cost today")).toBeNull();
  });
});

describe("Overview conflicts", () => {
  it("lists the files two sessions both edited", async () => {
    renderHuddle(<Overview />, state(), NOW, fetchF());
    await waitFor(() => expect(screen.getByText("src/app.ts")).not.toBeNull());
    expect(screen.getByText("shop")).not.toBeNull();
    expect(screen.getByText("owl")).not.toBeNull();
  });

  it("names the repo a conflicted file lives in", async () => {
    renderHuddle(
      <Overview />,
      state(),
      NOW,
      fetchF({
        window_min: 30,
        conflicts: [{ path: "src/app.ts", repo: "shoprepo", repo_name: "shop", sessions: [{ name: "owl" }] }],
      }),
    );
    await waitFor(() => expect(screen.getByTitle("shoprepo")).not.toBeNull());
    expect(screen.getByTitle("shoprepo").textContent).toContain("shop");
  });

  it("reads the window the server answered with", async () => {
    renderHuddle(<Overview />, state(), NOW, fetchF({ window_min: 15, conflicts: [] }));
    await waitFor(() => expect(screen.getByText(/last 15 minutes/)).not.toBeNull());
  });

  it("sits empty while nobody overlaps", async () => {
    renderHuddle(<Overview />, state(), NOW, fetchF({ window_min: 30, conflicts: [] }));
    await waitFor(() => expect(screen.getByText("No overlapping edits")).not.toBeNull());
  });

  it("reads again on every mount of the page", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = (url) => {
      if (String(url).includes("/conflicts")) seen.push(String(url));
      return Promise.resolve(jsonResponse({ window_min: 30, conflicts: [] }));
    };
    const first = renderHuddle(<Overview />, state(), NOW, fetchFn);
    await waitFor(() => expect(seen.length).toBe(1));
    first.unmount();
    renderHuddle(<Overview />, state(), NOW, fetchFn);
    await waitFor(() => expect(seen.length).toBe(2));
  });

  it("reads again when the stream delivers a conflict push", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = (url) => {
      if (String(url).includes("/conflicts")) seen.push(String(url));
      return Promise.resolve(jsonResponse({ window_min: 30, conflicts: [] }));
    };
    const timers: Timers = {
      after: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as number),
      interval: () => 0,
      stop: () => {},
    };
    const announce = (): void => {};
    const store = createStore({ api: apiOver(fetchFn), timers, hidden: () => false, announce });
    try {
      const { unmount } = renderHuddle(<Overview store={store} />, state(), NOW, fetchFn);
      await waitFor(() => expect(seen.length).toBe(1));
      // the roster's presence patch does not move state.sessions: the push itself must refetch
      store.changed("conflict", { repo: "/repo", path: "src/app.ts", sessions: ["api", "owl"] });
      await waitFor(() => expect(seen.length).toBe(2));
      unmount();
    } finally {
      store.dispose();
    }
  });
});

describe("Overview activity", () => {
  it("draws the chart over the current window and keeps the pick per channel", () => {
    const st = memStorage();
    const { unmount } = renderHuddle(<Overview prefs={st} />, state(), NOW, fetchF());
    expect(screen.getByRole("img", { name: "Events per minute over the last 15m" })).not.toBeNull();
    act(() => {
      fireEvent.click(screen.getByText("1 hour"));
    });
    expect(screen.getByRole("img", { name: "Events per minute over the last 1h" })).not.toBeNull();
    expect(readPref(st, "ovwin:dev", "15m")).toBe("1h");
    unmount();
  });

  it("notes an empty window", () => {
    renderHuddle(<Overview />, state({ timeline: [] }), NOW, fetchF());
    expect(screen.getByText("No activity in this window")).not.toBeNull();
  });
});

describe("Overview header", () => {
  it("hands Send a message to the composer", () => {
    const onCompose = vi.fn();
    renderHuddle(<Overview onCompose={onCompose} />, state(), NOW, fetchF());
    fireEvent.click(screen.getByText("Send a message"));
    expect(onCompose).toHaveBeenCalledTimes(1);
  });
});

describe("Overview without a channel", () => {
  it("renders nothing while Home is open", () => {
    const { container } = renderHuddle(<Overview />, state({ ch: null }), NOW, fetchF());
    expect(container.textContent).toBe("");
  });
});

describe("Overview helpers", () => {
  it("ovVals reads the whole snapshot", () => {
    const v = ovVals(state() as HuddleState);
    expect(v).toMatchObject({
      done: 1,
      total: 4,
      phases: 1,
      pct: 25,
      live: 2,
      tops: 1,
      doing: 1,
      waiting: 1,
      blocked: 1,
      todo: 0,
      asks: 1,
      kb: 3,
      ev: 42,
    });
  });

  it("ovSub and ovTexts speak the plan's and the roster's state", () => {
    const v = ovVals(state() as HuddleState);
    expect(ovSub(v)).toBe("25% of the plan across 1 phase");
    expect(ovSub({ ...v, phases: 0 })).toBe("25% of the plan");
    expect(ovSub({ ...v, total: 0 })).toBe("Nothing planned yet");
    expect(ovTexts(v).livesub).toBe("1 top-level, 1 subagent");
    expect(ovTexts({ ...v, live: 3, tops: 1 }).livesub).toBe("1 top-level, 2 subagents");
    expect(ovTexts({ ...v, live: 1, tops: 1 }).livesub).toBe("1 top-level, 0 subagents");
    expect(ovTexts({ ...v, live: 0 }).livesub).toBe("Nobody online");
    expect(ovTexts(v).asksub).toBe("Waiting in your Inbox");
    expect(ovTexts({ ...v, asks: 0 }).asksub).toBe("All answered");
  });

  it("ovRows gives each open state its share", () => {
    const rows = ovRows(ovVals(state() as HuddleState));
    expect(rows.map((r) => r.k)).toEqual(["doing", "waiting", "blocked", "todo"]);
    // t3 waits on t2, so the plan shows no plain "to do"
    expect(rows.map((r) => r.n)).toEqual([1, 1, 1, 0]);
    expect(rows.filter((r) => r.n > 0).every((r) => r.pct === 25)).toBe(true);
    expect(rows.find((r) => r.k === "todo")?.pct).toBe(0);
    expect(ovRows({ ...ovVals(state() as HuddleState), total: 0 }).every((r) => r.pct === 0)).toBe(true);
  });

  it("ovSeries bins the timeline per minute and rate", () => {
    const s = ovSeries(state().timeline as FeedEvent[], "15m", NOW);
    // three events: two in the last two minutes, one 40 minutes back (outside the window)
    const values = s.series[0]?.values ?? [];
    expect(values).toHaveLength(15);
    // one event a minute back sits in bin 13, one two minutes back in bin 12
    expect(values[13]).toBe(1);
    expect(values[12]).toBe(1);
    expect(values[0]).toBe(0);
    expect(s.axis).toHaveLength(3);
    expect(s.tipOf(13)[1]).toBe("1 event in the bin · 1/min");
    expect(s.tipOf(0)[1]).toBe("0 events in the bin · 0/min");
  });

  it("ovSeries spreads the hour window over five-minute bins", () => {
    const s = ovSeries([ev(1, 9)], "1h", NOW);
    const values = s.series[0]?.values ?? [];
    expect(values).toHaveLength(12);
    // nine minutes back lands in the 5-10 min bin, one per minute
    expect(values[10]).toBeCloseTo(0.2, 5);
    // an event without a timestamp is skipped, not a crash
    expect(ovSeries([{ seq: 1, topic: "msg" } as FeedEvent], "1h", NOW).series[0]?.values[0]).toBe(0);
  });

  it("ovSeries labels a day window with its weekday", () => {
    const s = ovSeries([ev(1, 30)], "24h", NOW);
    expect(s.axis[0]).toMatch(/^[A-Z][a-z][a-z] /);
    // a 24h bin covers an hour, so one event is 1/60 per minute
    expect(s.series[0]?.values[23]).toBeCloseTo(1 / 60, 5);
  });
});
