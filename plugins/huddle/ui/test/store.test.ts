import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api.ts";
import {
  type Attention,
  type Board,
  createSoon,
  createStore,
  type FeedEvent,
  freshInboxText,
  type HuddleState,
  hasOrch,
  inboxKeys,
  type Timers,
  usd,
} from "../src/store.ts";

// ── fakes: timers that only move when the test moves them ────────────────────
type Job = { id: number; fn: () => void; at: number; every?: number };

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, Job>();
  const timers: Timers = {
    after(fn, ms) {
      const id = ++seq;
      jobs.set(id, { id, fn, at: now + ms });
      return id;
    },
    cancel(h) {
      jobs.delete(h as number);
    },
    interval(fn, ms) {
      const id = ++seq;
      jobs.set(id, { id, fn, at: now + ms, every: ms });
      return id;
    },
    stop(h) {
      jobs.delete(h as number);
    },
  };
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    for (;;) {
      const due = [...jobs.values()].filter((j) => j.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      jobs.delete(due.id);
      due.fn();
      if (due.every !== undefined) jobs.set(due.id, { ...due, at: due.at + due.every });
    }
    // let the loaders the jobs started finish their microtasks, like a real event loop would
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { timers, advance };
}

// ── fakes: an Api that answers from a route table (a promise route waits) ────
type Routes = Record<string, unknown>;

function fakeApi(routes: Routes, failures: Record<string, Error> = {}) {
  const calls: string[] = [];
  const api: Api = {
    api: async (path) => {
      calls.push(path);
      const fail = failures[path];
      if (fail) throw fail;
      if (!(path in routes)) throw new Error(`no route for ${path}`);
      const v = routes[path];
      // fresh copies, the way parsed JSON would be: the store mutates what it loads
      return v instanceof Promise ? v : structuredClone(v);
    },
    op: async () => ({}),
    channelPath: (ch, p) => `/api/c/${encodeURIComponent(ch)}${p}`,
    channelHref: (ch, p) => `#/c/${ch}${p}`,
  };
  return { calls, api };
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const BOARD: Board = {
  phases: [{ n: 1, title: "Setup" }],
  steps: [
    { id: "t1", title: "First", status: "todo" },
    { id: "t2", title: "Second", status: "doing", owner: "a.b" },
  ],
};
const SESSIONS = {
  sessions: [{ name: "a.b", state: "working", control: "" }],
  turn: { holder: null },
  config: { title: "Ch" },
};
const ATT: Attention = {
  asks: [{ seq: 7, from: "a.b", msg: "hello" }],
  gates: [{ id: "t2", title: "Second" }],
  paused: [{ name: "c.d", by: "owner" }],
  blocked: [{ id: "t3", title: "Third" }],
};
const EVENTS: FeedEvent[] = [
  { seq: 1, topic: "session.joined", from: "a.b" },
  { seq: 2, topic: "ask", from: "a.b", to: "owner", msg: "which port?" },
  { seq: 3, topic: "reply", from: "owner", to: "a.b", reply_to: 2, msg: "8080" },
];
const APPROVALS = {
  approvals: [
    { seq: 1, from: "a.b", labels: ["rm"] },
    { seq: 2, from: "c.d" },
  ],
};
const RADAR = {
  available: true,
  alerts: [{ id: 1, kind: "stuck", session: "a.b" }],
  cost: { "a.b": 1.5 },
  total: 1.5,
};

/** A store over fakes, with every knob the tests need in reach. */
function harness(routes: Routes = {}, failures: Record<string, Error> = {}) {
  const timers = fakeTimers();
  const api = fakeApi(routes, failures);
  let hidden = false;
  const announce = vi.fn();
  const store = createStore({ api: api.api, timers: timers.timers, hidden: () => hidden, announce });
  const seen: { what: string; x?: unknown }[] = [];
  store.subscribe((what, x) => seen.push({ what, x }));
  return {
    store,
    seen,
    announce,
    calls: api.calls,
    advance: timers.advance,
    setHidden: (v: boolean) => {
      hidden = v;
    },
  };
}

const count = (calls: string[], path: string): number => calls.filter((c) => c === path).length;

describe("channel switching", () => {
  it("opens a channel: the name is set, its data resets, the page-wide data is kept", async () => {
    const h = harness({ "/api/c/c1": { name: "c1" }, "/api/c/c1/timeline?limit=300": EVENTS });
    h.store.setChannel("c1");
    await h.store.loadInfo();
    await h.store.loadTimeline();
    h.store.setChannels([{ name: "c1" }]);

    h.store.setChannel("c2");
    const s: HuddleState = h.store.getState();
    expect(s.ch).toBe("c2");
    expect(s.info).toBeNull();
    expect(s.board).toBeNull();
    expect(s.byId.size).toBe(0);
    expect(s.sessions).toBeNull();
    expect(s.timeline).toBeNull();
    expect(s.attention).toBeNull();
    expect(s.channels).toEqual([{ name: "c1" }]); // page-wide, not per channel
  });

  it("starts with no channel and a live status of connecting", () => {
    const { store } = harness();
    expect(store.getState().ch).toBeNull();
    expect(store.getState().live).toBe("connecting");
  });

  it("keeps the reply map across a channel switch, until the timeline reloads (as data.js did)", async () => {
    const h = harness({ "/api/c/c1/timeline?limit=300": EVENTS, "/api/c/c2/timeline?limit=300": [] });
    h.store.setChannel("c1");
    h.store.recordEvent({ seq: 9, topic: "reply", from: "owner", reply_to: 5 });
    expect(h.store.getState().replies.get(5)).toEqual(["owner"]);
    h.store.setChannel("c2");
    expect(h.store.getState().replies.get(5)).toEqual(["owner"]);
    await h.store.loadTimeline();
    expect(h.store.getState().replies.size).toBe(0);
  });
});

describe("loaders", () => {
  it("loadInfo fetches the channel row and broadcasts info", async () => {
    const h = harness({ "/api/c/c1": { name: "c1", config: { title: "Ch" } } });
    h.store.setChannel("c1");
    await h.store.loadInfo();
    expect(h.store.getState().info?.config?.title).toBe("Ch");
    expect(h.seen.at(-1)?.what).toBe("info");
  });

  it("loadInfo rethrows a 404 so syncChannel can paint the no-channel page", async () => {
    const missing = harness({}, { "/api/c/c1": Object.assign(new Error("no channel c1"), { status: 404 }) });
    missing.store.setChannel("c1");
    await expect(missing.store.loadInfo()).rejects.toThrow("no channel c1");
    expect(missing.store.getState().info).toBeNull();
  });

  it("loadInfo keeps the old row on failure, drops a stale answer, and does nothing without a channel", async () => {
    const failing = harness({});
    failing.store.setChannel("c1");
    await failing.store.loadInfo(); // no route → the error is swallowed
    expect(failing.store.getState().info).toBeNull();

    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    const slow = harness({ "/api/c/c1": gate });
    slow.store.setChannel("c1");
    const pending = slow.store.loadInfo();
    slow.store.setChannel("c2");
    release({ name: "c1" });
    await pending;
    expect(slow.store.getState().info).toBeNull();

    const bare = harness({ "/api/c/null": { name: "null" } });
    await bare.store.loadInfo();
    expect(bare.calls).toEqual([]);
    expect(bare.store.getState().info).toBeNull();
  });

  it("loadBoard fills board and the byId map, gives the board back, and rejects on failure", async () => {
    const h = harness({ "/api/c/c1/board": BOARD });
    h.store.setChannel("c1");
    await expect(h.store.loadBoard()).resolves.toEqual(BOARD);
    expect(h.store.getState().board).toEqual(BOARD);
    expect(h.store.getState().byId.get("t1")?.title).toBe("First");
    expect(h.seen.some((s) => s.what === "board")).toBe(true);

    const bad = harness({}, { "/api/c/c1/board": new Error("boom") });
    bad.store.setChannel("c1");
    await expect(bad.store.loadBoard()).rejects.toThrow("boom");
    expect(bad.store.getState().board).toBeNull();
  });

  it("loadBoard drops a stale answer (wrong channel) and says so with null", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    const h = harness({ "/api/c/c1/board": gate });
    h.store.setChannel("c1");
    const pending = h.store.loadBoard();
    h.store.setChannel("c2");
    release(BOARD);
    await expect(pending).resolves.toBeNull();
    expect(h.store.getState().board).toBeNull();
    expect(h.store.getState().byId.size).toBe(0);
  });

  it("loadSessions fills the roster and keeps the old one when the fetch fails", async () => {
    const h = harness({ "/api/c/c1/sessions": SESSIONS });
    h.store.setChannel("c1");
    await h.store.loadSessions();
    expect(h.store.getState().sessions?.sessions[0]?.name).toBe("a.b");
    expect(h.seen.at(-1)?.what).toBe("sess");

    const bad = harness({});
    bad.store.setChannel("c1");
    await bad.store.loadSessions();
    expect(bad.store.getState().sessions).toBeNull();
  });

  it("loadSessions drops a stale roster after a channel switch", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    const h = harness({ "/api/c/c1/sessions": gate });
    h.store.setChannel("c1");
    const pending = h.store.loadSessions();
    h.store.setChannel("c2");
    release(SESSIONS);
    await pending;
    expect(h.store.getState().sessions).toBeNull();
  });

  it("loadAttention fills the Inbox and stays quiet when nothing is fresh", async () => {
    const h = harness({ "/api/c/c1/attention": ATT });
    h.store.setChannel("c1");
    await h.store.loadAttention();
    expect(h.store.getState().attention).toEqual(ATT);
    expect(h.announce).not.toHaveBeenCalled(); // the first load is the baseline

    await h.store.loadAttention(); // nothing new: no announcement
    expect(h.announce).not.toHaveBeenCalled();
  });

  it("announces the fresh items by name, three named and the rest counted", async () => {
    const base: Attention = { asks: [], gates: [], paused: [], blocked: [] };
    const grown: Attention = {
      asks: [
        { seq: 1, from: "owner" },
        { seq: 2, from: "a.b" },
        { seq: 3, from: "c.d" },
        { seq: 4, from: "e.f" },
      ],
      gates: [{ id: "t5" }],
      paused: [],
      blocked: [],
    };
    const routes: Routes = { "/api/c/c1/attention": base };
    const h = harness(routes);
    h.store.setChannel("c1");
    await h.store.loadAttention();
    expect(h.announce).not.toHaveBeenCalled();

    routes["/api/c/c1/attention"] = grown;
    await h.store.loadAttention();
    expect(h.announce).toHaveBeenCalledTimes(1);
    expect(h.announce).toHaveBeenCalledWith(
      "New in Inbox: You asks you; a.b asks you; c.d asks you and 2 more.",
    );
  });

  it("keeps the old Inbox when the fetch fails or the answer arrives for the previous channel", async () => {
    const bad = harness({ "/api/c/c1/attention": ATT }, { "/api/c/c1/attention": new Error("boom") });
    bad.store.setChannel("c1");
    await bad.store.loadAttention();
    expect(bad.store.getState().attention).toBeNull();

    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    const slow = harness({ "/api/c/c1/attention": gate });
    slow.store.setChannel("c1");
    const pending = slow.store.loadAttention();
    slow.store.setChannel("c2");
    release(ATT);
    await pending;
    expect(slow.store.getState().attention).toBeNull();
  });

  it("does nothing without a channel: every loader and the fresh-item line stay put", async () => {
    const h = harness({ "/api/c/null/attention": ATT });
    await h.store.loadAttention();
    await h.store.loadSessions();
    await h.store.loadTimeline();
    await expect(h.store.olderTimeline()).resolves.toBe(0);
    await h.store.loadInfo();
    await expect(h.store.loadBoard()).resolves.toBeNull();
    expect(h.calls).toEqual([]);
    expect(freshInboxText(["a", "b"])).toBe("New in Inbox: a; b.");
  });
});

describe("inboxKeys and inboxCount", () => {
  it("keys every family of Inbox items and names the owner You", () => {
    const keys = inboxKeys(ATT);
    expect(keys.get("a7")).toBe("a.b asks you");
    expect(keys.get("gt2")).toBe("t2 waits for your approval");
    expect(keys.get("pc.d")).toBe("c.d is paused");
    expect(keys.get("bt3")).toBe("t3 is blocked");
    expect(keys.get("a9")).toBeUndefined();
    expect(inboxKeys({}).size).toBe(0);
    expect(inboxKeys({ asks: [{ seq: 1, from: "owner" }] }).get("a1")).toBe("You asks you");
  });

  it("counts asks, gates, paused and blocked, plus the extras that need the owner", async () => {
    const h = harness({
      "/api/c/c1/attention": ATT,
      "/api/c/c1/x/approvals": APPROVALS,
      "/api/c/c1/x/radar": RADAR,
    });
    expect(h.store.inboxCount()).toBe(0);
    h.store.setChannel("c1");
    await h.store.loadAttention();
    expect(h.store.inboxCount()).toBe(4);
    await h.store.loadExtras();
    expect(h.store.inboxCount()).toBe(4 + 3); // 2 approvals + 1 alert
  });

  it("counts nothing without attention", () => {
    const h = harness();
    h.store.setChannel("c1");
    expect(h.store.inboxCount()).toBe(0);
  });

  it("counts a partial Inbox: the families the snapshot lacks count as zero", async () => {
    const h = harness({
      "/api/c/c1/attention": { asks: [{ seq: 1, from: "a.b" }] },
      "/api/c/c1/x/approvals": { approvals: APPROVALS.approvals },
      "/api/c/c1/x/radar": { available: true, cost: { "a.b": 2 } }, // Radar without alerts
    });
    h.store.setChannel("c1");
    await h.store.loadAttention();
    expect(h.store.inboxCount()).toBe(1);
    await h.store.loadExtras();
    expect(h.store.needs()).toBe(2); // the approvals, with no alerts to add
    expect(h.store.inboxCount()).toBe(3);

    const gated = harness({ "/api/c/c1/attention": { gates: [{ id: "t5" }], blocked: [{ id: "t6" }] } });
    gated.store.setChannel("c1");
    await gated.store.loadAttention();
    expect(gated.store.inboxCount()).toBe(2); // no asks, no paused: those count as zero
  });
});

describe("timeline and replies", () => {
  it("loads the timeline, rebuilds the reply map and broadcasts tl", async () => {
    const h = harness({ "/api/c/c1/timeline?limit=300": EVENTS });
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    expect(h.store.getState().timeline).toEqual(EVENTS);
    expect(h.store.getState().replies.get(2)).toEqual(["owner"]);
    expect(h.seen.at(-1)?.what).toBe("tl");
  });

  it("keeps the timeline empty when the fetch fails, and drops a stale timeline", async () => {
    const h = harness({});
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    expect(h.store.getState().timeline).toEqual([]);
    expect(h.store.getState().replies.size).toBe(0);

    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    const slow = harness({ "/api/c/c1/timeline?limit=300": gate });
    slow.store.setChannel("c1");
    const pending = slow.store.loadTimeline();
    slow.store.setChannel("c2");
    release(EVENTS);
    await pending;
    expect(slow.store.getState().timeline).toBeNull();
  });

  it("olderTimeline prepends the older page, counts what it added and folds in its replies", async () => {
    const older: FeedEvent[] = [
      { seq: -1, topic: "msg", from: "c.d", msg: "earlier" },
      { seq: 0, topic: "reply", from: "c.d", reply_to: 2 },
    ];
    const h = harness({
      "/api/c/c1/timeline?limit=300": EVENTS,
      "/api/c/c1/timeline?limit=300&before=1": older,
    });
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    await expect(h.store.olderTimeline()).resolves.toBe(2);
    expect(h.store.getState().timeline?.map((e) => e.seq)).toEqual([-1, 0, 1, 2, 3]);
    expect(h.store.getState().replies.get(2)).toEqual(["owner", "c.d"]); // the newer answer first
  });

  it("olderTimeline does nothing without a first event or on a failed fetch", async () => {
    const h = harness({});
    h.store.setChannel("c1");
    await expect(h.store.olderTimeline()).resolves.toBe(0);
    expect(h.calls).toEqual([]);

    const loaded = harness({ "/api/c/c1/timeline?limit=300": EVENTS });
    loaded.store.setChannel("c1");
    await loaded.store.loadTimeline();
    await expect(loaded.store.olderTimeline()).resolves.toBe(0); // the older page fails → []
    expect(loaded.store.getState().timeline).toEqual(EVENTS);
  });

  it("olderTimeline prepends onto an empty timeline when the channel closed mid-flight (as data.js did)", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    const h = harness({
      "/api/c/c1/timeline?limit=300": EVENTS,
      "/api/c/c1/timeline?limit=300&before=1": gate,
    });
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    const pending = h.store.olderTimeline();
    h.store.setChannel(null); // the timeline goes with it
    release([{ seq: 0, topic: "msg", from: "a.b" }]);
    await expect(pending).resolves.toBe(1);
    // data.js:101 reassigns S.tl no matter what: the older page stays
    expect(h.store.getState().timeline).toEqual([{ seq: 0, topic: "msg", from: "a.b" }]);
  });
});

describe("stream patches", () => {
  it("recordEvent appends, notes the reply, and refills the Inbox and roster (debounced)", async () => {
    const h = harness({
      "/api/c/c1/timeline?limit=300": EVENTS,
      "/api/c/c1/attention": ATT,
      "/api/c/c1/sessions": SESSIONS,
      "/api/c/c1/x/approvals": { approvals: [] },
      "/api/c/c1/x/radar": { available: false },
    });
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    h.seen.length = 0;
    const e: FeedEvent = { seq: 4, topic: "reply", from: "a.b", reply_to: 2 };
    expect(h.store.recordEvent(e)).toBe(true);
    expect(h.store.getState().timeline?.at(-1)).toEqual(e);
    expect(h.store.getState().replies.get(2)).toEqual(["owner", "a.b"]);
    expect(h.seen[0]).toEqual({ what: "event", x: e });
    await h.advance(500);
    expect(h.seen.some((s) => s.what === "att")).toBe(true);
    await h.advance(400);
    expect(h.seen.some((s) => s.what === "sess")).toBe(true);
  });

  it("recordEvent still counts when the timeline is not loaded yet, and refuses old events", async () => {
    const h = harness();
    h.store.setChannel("c1");
    expect(h.store.recordEvent({ seq: 9, topic: "msg", from: "a.b" })).toBe(true);
    expect(h.store.getState().timeline).toBeNull();

    const h2 = harness({ "/api/c/c1/timeline?limit=300": EVENTS });
    h2.store.setChannel("c1");
    await h2.store.loadTimeline();
    h2.seen.length = 0;
    expect(h2.store.recordEvent({ seq: 3, topic: "msg", from: "a.b" })).toBe(false);
    expect(h2.store.recordEvent({ seq: 2, topic: "msg", from: "a.b" })).toBe(false);
    expect(h2.store.getState().timeline).toHaveLength(3);
    expect(h2.seen).toEqual([]);
  });

  it("recordEvent starts from an empty timeline, and only notes replies that name their sender", async () => {
    const h = harness({ "/api/c/c1/timeline?limit=300": [] });
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    expect(h.store.recordEvent({ seq: 1, topic: "msg", from: "a.b" })).toBe(true);
    expect(h.store.getState().timeline).toEqual([{ seq: 1, topic: "msg", from: "a.b" }]);

    h.store.recordEvent({ seq: 2, topic: "reply", reply_to: 1 }); // no sender: nothing noted
    h.store.recordEvent({ seq: 3, topic: "msg", from: "a.b" }); // no reply_to: nothing noted
    expect(h.store.getState().replies.size).toBe(0);
    h.store.recordEvent({ seq: 4, topic: "reply", from: "a.b", reply_to: 3 });
    expect(h.store.getState().replies.get(3)).toEqual(["a.b"]);
  });

  it("recordEvent tolerates a timeline whose last event carries no seq", async () => {
    const h = harness({ "/api/c/c1/timeline?limit=300": [{ seq: 1 }, { topic: "odd" }] });
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    expect(h.store.recordEvent({ seq: 2, topic: "msg", from: "a.b" })).toBe(true); // 2 follows "nothing"
    expect(h.store.getState().timeline).toHaveLength(3);
  });

  it("caps the timeline at 3000 events", async () => {
    const big: FeedEvent[] = Array.from({ length: 3000 }, (_, i) => ({
      seq: i + 1,
      topic: "msg",
      from: "a",
    }));
    const h = harness({ "/api/c/c1/timeline?limit=300": big });
    h.store.setChannel("c1");
    await h.store.loadTimeline();
    h.store.recordEvent({ seq: 3001, topic: "msg", from: "a" });
    const tl = h.store.getState().timeline;
    expect(tl).toHaveLength(3000);
    expect(tl?.[0]?.seq).toBe(2);
    expect(tl?.at(-1)?.seq).toBe(3001);
  });

  it("broadcasts kb when the event is a knowledge event", () => {
    const h = harness();
    h.store.setChannel("c1");
    h.store.recordEvent({ seq: 1, topic: "kb.added", from: "a.b" });
    expect(h.seen.some((s) => s.what === "kb")).toBe(true);
    h.store.recordEvent({ seq: 2, topic: "msg", from: "a.b" });
    expect(h.seen.filter((s) => s.what === "kb")).toHaveLength(1);
  });

  it("applyPresence patches a known session and appends an unknown one with defaults", async () => {
    const h = harness({ "/api/c/c1/sessions": SESSIONS });
    h.store.setChannel("c1");
    await h.store.loadSessions();
    h.seen.length = 0;
    h.store.applyPresence({ name: "a.b", state: "blocked", stale: false });
    await h.advance(60);
    const roster = h.store.getState().sessions?.sessions ?? [];
    expect(roster.find((s) => s.name === "a.b")?.state).toBe("blocked");
    expect(roster.find((s) => s.name === "a.b")?.control).toBe(""); // untouched fields survive
    expect(h.seen.some((s) => s.what === "sess")).toBe(true);

    h.store.applyPresence({ name: "new.guy", state: "working" });
    const added = h.store.getState().sessions?.sessions.find((s) => s.name === "new.guy");
    expect(added).toEqual({ unread: 0, open: 0, holds_turn: false, name: "new.guy", state: "working" });
  });

  it("applyPresence refills the Inbox only when the pause state changed, and ignores empty input", async () => {
    const h = harness({
      "/api/c/c1/sessions": SESSIONS,
      "/api/c/c1/attention": ATT,
      "/api/c/c1/x/approvals": { approvals: [] },
      "/api/c/c1/x/radar": { available: false },
    });
    h.store.setChannel("c1");
    await h.store.loadSessions();
    await h.advance(100); // settle the extras fill that the roster load asked for
    h.calls.length = 0;

    h.store.applyPresence({ name: "a.b", control: "pause" });
    await h.advance(500);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);

    h.calls.length = 0;
    h.store.applyPresence({ name: "a.b", control: "pause" });
    await h.advance(500);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(0);

    h.store.applyPresence(null as unknown as { name: string });
    h.store.applyPresence({ name: "a.b" });
    await h.advance(500);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(0);

    const bare = harness();
    bare.store.setChannel("c1"); // no sessions yet
    bare.store.applyPresence({ name: "a.b", state: "idle" });
    await bare.advance(60);
    expect(bare.store.getState().sessions).toBeNull();
  });
});

describe("debounced refills", () => {
  it("attChanged, sessChanged and boardChanged refill once per window, only with a channel", async () => {
    const h = harness({
      "/api/c/c1/attention": ATT,
      "/api/c/c1/sessions": SESSIONS,
      "/api/c/c1/board": BOARD,
      "/api/c/c1/x/approvals": { approvals: [] },
      "/api/c/c1/x/radar": { available: false },
    });
    h.store.attChanged(); // no channel: none of the three asks for anything
    h.store.sessChanged();
    h.store.boardChanged();
    await h.advance(1000);
    expect(h.calls).toEqual([]);

    h.store.setChannel("c1");
    h.store.attChanged();
    h.store.attChanged(); // same window: the earlier one is replaced
    h.store.sessChanged();
    h.store.boardChanged();
    await h.advance(349);
    expect(h.calls).toEqual([]);
    await h.advance(1); // 350: board
    expect(count(h.calls, "/api/c/c1/board")).toBe(1);
    await h.advance(50); // 400: sessions
    expect(count(h.calls, "/api/c/c1/sessions")).toBe(1);
    await h.advance(100); // 500: attention
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);
    await h.advance(1000); // settled: nothing else refills
    expect(
      count(h.calls, "/api/c/c1/board") +
        count(h.calls, "/api/c/c1/sessions") +
        count(h.calls, "/api/c/c1/attention"),
    ).toBe(3);
  });

  it("boardChanged swallows a failed board load", async () => {
    const h = harness({}, { "/api/c/c1/board": new Error("boom") });
    h.store.setChannel("c1");
    h.store.boardChanged();
    await h.advance(350);
    expect(h.store.getState().board).toBeNull();
  });
});

describe("extras: approvals and Radar", () => {
  it("loads approvals and Radar, and broadcasts att and ext", async () => {
    const h = harness({ "/api/c/c1/x/approvals": APPROVALS, "/api/c/c1/x/radar": RADAR });
    h.store.setChannel("c1");
    await h.store.loadExtras();
    expect(h.store.getState().extras).toEqual({ ch: "c1", approvals: APPROVALS.approvals, obs: RADAR });
    expect(h.seen.some((s) => s.what === "att")).toBe(true);
    expect(h.seen.some((s) => s.what === "ext")).toBe(true);
  });

  it("keeps obs null when Radar is off, and empty approvals when the fetches fail", async () => {
    const off = harness({ "/api/c/c1/x/approvals": APPROVALS, "/api/c/c1/x/radar": { available: false } });
    off.store.setChannel("c1");
    await off.store.loadExtras();
    expect(off.store.getState().extras?.obs).toBeNull();
    expect(off.store.getState().extras?.approvals).toHaveLength(2);

    const bad = harness({});
    bad.store.setChannel("c1");
    await bad.store.loadExtras();
    expect(bad.store.getState().extras).toEqual({ ch: "c1", approvals: [], obs: null });
  });

  it("drops a stale extras answer after a channel switch, and does nothing without a channel", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise<unknown>((res) => {
      release = res;
    });
    const h = harness({ "/api/c/c1/x/approvals": gate });
    h.store.setChannel("c1");
    const pending = h.store.loadExtras();
    h.store.setChannel("c2");
    release(APPROVALS);
    await pending;
    expect(h.store.getState().extras).toBeNull();

    const bare = harness({});
    await bare.store.loadExtras();
    expect(bare.calls).toEqual([]);
    expect(bare.store.getState().extras).toBeNull();
  });

  it("needs counts approvals plus alerts for the open channel only", async () => {
    const h = harness({ "/api/c/c1/x/approvals": APPROVALS, "/api/c/c1/x/radar": RADAR });
    expect(h.store.needs()).toBe(0);
    h.store.setChannel("c1");
    expect(h.store.needs()).toBe(0);
    await h.store.loadExtras();
    expect(h.store.needs()).toBe(3);
    h.store.setChannel("c2");
    expect(h.store.needs()).toBe(0);
  });

  it("needsText spells the counts, singular and plural, and skips empty halves", async () => {
    const h = harness({ "/api/c/c1/x/approvals": APPROVALS, "/api/c/c1/x/radar": RADAR });
    expect(h.store.needsText()).toBe("");
    h.store.setChannel("c1");
    expect(h.store.needsText()).toBe("");
    await h.store.loadExtras();
    expect(h.store.needsText()).toBe("2 permission requests · 1 Radar alert");

    const one = harness({
      "/api/c/c1/x/approvals": { approvals: [APPROVALS.approvals[0]] },
      "/api/c/c1/x/radar": { available: true, alerts: [RADAR.alerts[0]] },
    });
    one.store.setChannel("c1");
    await one.store.loadExtras();
    expect(one.store.needsText()).toBe("1 permission request · 1 Radar alert");

    const onlyAlerts = harness({
      "/api/c/c1/x/approvals": { approvals: [] },
      "/api/c/c1/x/radar": { available: true, alerts: [RADAR.alerts[0], { ...RADAR.alerts[0], id: 2 }] },
    });
    onlyAlerts.store.setChannel("c1");
    await onlyAlerts.store.loadExtras();
    expect(onlyAlerts.store.needsText()).toBe("2 Radar alerts");

    const quiet = harness({
      "/api/c/c1/x/approvals": { approvals: [] },
      "/api/c/c1/x/radar": { available: true },
    });
    quiet.store.setChannel("c1");
    await quiet.store.loadExtras();
    expect(quiet.store.needsText()).toBe("");
  });

  it("costOf reads Radar's per-session cost for the open channel", async () => {
    const h = harness({ "/api/c/c1/x/approvals": { approvals: [] }, "/api/c/c1/x/radar": RADAR });
    expect(h.store.costOf("a.b")).toBeUndefined();
    h.store.setChannel("c1");
    expect(h.store.costOf("a.b")).toBeUndefined();
    await h.store.loadExtras();
    expect(h.store.costOf("a.b")).toBe(1.5);
    expect(h.store.costOf("nobody")).toBeUndefined();
    h.store.setChannel("c2");
    expect(h.store.costOf("a.b")).toBeUndefined();
  });

  it("polls Radar every 30 s while a channel is open, Radar runs and the page is visible", async () => {
    const h = harness({ "/api/c/c1/x/approvals": APPROVALS, "/api/c/c1/x/radar": RADAR });
    h.store.setChannel("c1");
    await h.store.loadExtras();
    h.calls.length = 0;

    await h.advance(29_999);
    expect(h.calls).toEqual([]);
    await h.advance(1);
    expect(count(h.calls, "/api/c/c1/x/approvals")).toBe(1);
    expect(count(h.calls, "/api/c/c1/x/radar")).toBe(1);

    h.setHidden(true); // hidden: skipped
    h.calls.length = 0;
    await h.advance(30_000);
    expect(h.calls).toEqual([]);

    h.setHidden(false); // visible again: back on
    await h.advance(30_000);
    expect(count(h.calls, "/api/c/c1/x/radar")).toBe(1);
  });

  it("polls even when Radar said unavailable, so one that starts later is found", async () => {
    const noRadar = harness({
      "/api/c/c1/x/approvals": { approvals: [] },
      "/api/c/c1/x/radar": { available: false },
    });
    noRadar.store.setChannel("c1");
    await noRadar.store.loadExtras();
    expect(noRadar.store.getState().extras?.obs).toBeNull();
    noRadar.calls.length = 0;
    await noRadar.advance(30_000);
    expect(count(noRadar.calls, "/api/c/c1/x/radar")).toBe(1);
  });

  it("does not poll without a channel, or after dispose", async () => {
    const bare = harness({});
    await bare.advance(60_000);
    expect(bare.calls).toEqual([]);

    const disposed = harness({ "/api/c/c1/x/approvals": APPROVALS, "/api/c/c1/x/radar": RADAR });
    disposed.store.setChannel("c1");
    await disposed.store.loadExtras();
    disposed.store.dispose();
    disposed.calls.length = 0;
    await disposed.advance(90_000);
    expect(disposed.calls).toEqual([]);
  });

  it("refills soon after an approval.request event, and fills once when a channel just opened", async () => {
    const h = harness({
      "/api/c/c1/timeline?limit=300": EVENTS,
      "/api/c/c1/x/approvals": APPROVALS,
      "/api/c/c1/x/radar": RADAR,
    });
    h.store.setChannel("c1");
    await h.store.loadTimeline(); // a change lands while the extras are still empty
    h.calls.length = 0;
    await h.advance(50);
    expect(count(h.calls, "/api/c/c1/x/approvals")).toBe(1); // the just-opened fill
    await h.advance(30_000); // settle the poll

    h.calls.length = 0;
    h.store.recordEvent({ seq: 9, topic: "approval.request", from: "a.b" });
    await h.advance(299);
    expect(count(h.calls, "/api/c/c1/x/approvals")).toBe(0);
    await h.advance(1);
    expect(count(h.calls, "/api/c/c1/x/approvals")).toBe(1);

    h.calls.length = 0;
    h.store.recordEvent({ seq: 10, topic: "msg", from: "a.b" }); // not an approval request
    h.store.changed("att"); // the extras' own changes never ask for a refill
    h.store.changed("ext");
    await h.advance(10_000);
    expect(count(h.calls, "/api/c/c1/x/approvals")).toBe(0);
  });
});

describe("change subscriptions", () => {
  it("subscribers get (what, x), and an unsubscribe stops them", () => {
    const h = harness();
    const { store } = harness();
    let got = "";
    const stop = store.subscribe((what) => {
      got = what;
    });
    store.changed("tl");
    expect(got).toBe("tl");
    stop();
    store.changed("info");
    expect(got).toBe("tl");

    h.store.setChannel("c1");
    h.store.changed("conflict", { file: "a.ts" });
    expect(h.seen.at(-1)).toEqual({ what: "conflict", x: { file: "a.ts" } });
  });

  it("a throwing subscriber does not break the others", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = harness();
    store.subscribe(() => {
      throw new Error("bad listener");
    });
    let got = "";
    store.subscribe((what) => {
      got = what;
    });
    store.changed("tl");
    expect(got).toBe("tl");
    expect(err).toHaveBeenCalledWith(expect.any(Error));
    err.mockRestore();
  });
});

describe("channels list", () => {
  it("loads every channel once per page and keeps failures silent", async () => {
    const h = harness({ "/api/channels": [{ name: "c1", title: "One" }] });
    await h.store.loadChannels();
    expect(h.store.getState().channels).toEqual([{ name: "c1", title: "One" }]);

    const bad = harness({});
    await bad.store.loadChannels();
    expect(bad.store.getState().channels).toBeNull();
  });

  it("setChannels sets the list directly", () => {
    const { store } = harness();
    store.setChannels([{ name: "c9" }]);
    expect(store.getState().channels).toEqual([{ name: "c9" }]);
  });
});

describe("usd, hasOrch and createSoon", () => {
  it("formats dollars: nothing, zero, sub-cent, cents and whole dollars", () => {
    expect(usd(undefined)).toBe("");
    expect(usd(null)).toBe("");
    expect(usd(0)).toBe("$0");
    expect(usd(0.001)).toBe("$0.001");
    expect(usd(0.009)).toBe("$0.009");
    expect(usd(0.01)).toBe("$0.01");
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(99.999)).toBe("$100.00");
    expect(usd(100)).toBe("$100");
    expect(usd(1234.5)).toBe("$1235");
  });

  it("hasOrch is true only when a config carries an orchestrator", () => {
    expect(hasOrch(null)).toBe(false);
    expect(hasOrch({})).toBe(false);
    expect(hasOrch({ config: {} })).toBe(false);
    expect(hasOrch({ config: { orchestrator: undefined } })).toBe(false);
    expect(hasOrch({ config: { orchestrator: "boss.bot" } })).toBe(true);
  });

  it("createSoon debounces by key and lets keys run independently", async () => {
    const t = fakeTimers();
    const soon = createSoon(t.timers);
    const a = vi.fn();
    const b = vi.fn();
    soon("a", a, 100);
    await t.advance(50);
    soon("a", a, 100); // replaces the pending one
    soon("b", b, 100);
    await t.advance(99);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    await t.advance(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    soon("c", a); // the default window is 350 ms
    await t.advance(349);
    expect(a).toHaveBeenCalledTimes(1);
    await t.advance(1);
    expect(a).toHaveBeenCalledTimes(2);
  });
});
