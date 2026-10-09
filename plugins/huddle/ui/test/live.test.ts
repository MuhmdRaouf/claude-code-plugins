import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api.ts";
import { createLive, type EventSourceLike, type Live, type Notifications } from "../src/live.ts";
import type { Storage as PrefStorage } from "../src/storage.ts";
import { createStore, type FeedEvent, type HuddleStore, type Timers } from "../src/store.ts";

// ── fakes ────────────────────────────────────────────────────────────────────
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

/** One open stream, poked by the test: open(), fail(), send(). */
class FakeSource implements EventSourceLike {
  static instances: FakeSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  fail(): void {
    this.onerror?.();
  }
  send(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  sendRaw(data: string): void {
    this.onmessage?.({ data });
  }
}

function fakeApi(routes: Record<string, unknown>, failures: Record<string, Error> = {}) {
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

function fakeNotify() {
  const shown: { title: string; body: string; tag: string; onClick: () => void }[] = [];
  let supported = true;
  let permission: "granted" | "denied" | "default" = "default";
  let requestAnswer: "granted" | "denied" | "default" | null = null;
  let rejectRequest = false;
  const notify: Notifications = {
    supported: () => supported,
    permission: () => permission,
    requestPermission: async () => {
      if (rejectRequest) throw new Error("blocked");
      return requestAnswer ?? permission;
    },
    show: (title, body, tag, onClick) => {
      shown.push({ title, body, tag, onClick });
    },
  };
  return {
    notify,
    shown,
    grant: () => {
      permission = "granted";
    },
    deny: () => {
      permission = "denied";
    },
    unsupported: () => {
      supported = false;
    },
    breakRequest: () => {
      rejectRequest = true;
    },
    answerRequest: (p: "granted" | "denied" | "default") => {
      requestAnswer = p;
    },
  };
}

const memStorage = (): PrefStorage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
};

const TIMELINE = [
  { seq: 1, topic: "session.joined", from: "a.b" },
  { seq: 2, topic: "ask", from: "a.b", to: "owner", msg: "which port?" },
];
const SESSIONS = { sessions: [{ name: "a.b", state: "working", control: "" }], turn: null };
const ATT = { asks: [{ seq: 2, from: "a.b", msg: "which port?" }], gates: [], paused: [], blocked: [] };

/** Everything the live module needs, wired to fakes, with the fixtures above served. */
function harness() {
  const timers = fakeTimers();
  const api = fakeApi({
    "/api/c/c1/timeline?limit=300": TIMELINE,
    "/api/c/c1/sessions": SESSIONS,
    "/api/c/c1/attention": ATT,
    "/api/c/c1/board": { phases: [], steps: [] },
    "/api/c/c1": { name: "c1" },
  });
  let hidden = false;
  let inboxOpen = false;
  const store: HuddleStore = createStore({
    api: api.api,
    timers: timers.timers,
    hidden: () => hidden,
    announce: vi.fn(),
  });
  const whoami = vi.fn(async () => new Response(JSON.stringify({ id: "o" }), { status: 200 }));
  const fn = fakeNotify();
  const storage = memStorage();
  const onSignedOut = vi.fn();
  const toast = vi.fn();
  const focusInbox = vi.fn();
  const live: Live = createLive({
    store,
    EventSource: (url: string) => new FakeSource(url),
    fetch: whoami,
    storage,
    notify: fn.notify,
    onSignedOut,
    toast,
    hidden: () => hidden,
    inboxOpen: () => inboxOpen,
    focusInbox,
  });
  store.setChannel("c1");
  return {
    live,
    store,
    calls: api.calls,
    advance: timers.advance,
    whoami,
    onSignedOut,
    toast,
    focusInbox,
    shown: fn.shown,
    notify: fn.notify,
    nf: fn,
    storage,
    es: () => FakeSource.instances[FakeSource.instances.length - 1] as FakeSource,
    setHidden: (v: boolean) => {
      hidden = v;
    },
    setInboxOpen: (v: boolean) => {
      inboxOpen = v;
    },
  };
}

const count = (calls: string[], path: string): number => calls.filter((c) => c === path).length;

describe("connection", () => {
  it("opens the stream for the open channel and starts as connecting", () => {
    const h = harness();
    FakeSource.instances.length = 0;
    h.live.connect();
    const es = h.es();
    expect(es.url).toBe("/api/c/c1/live?as=owner");
    expect(h.store.getState().live).toBe("connecting");
    expect(es.closed).toBe(false);
  });

  it("closes the previous stream when it connects again, even without a channel", () => {
    const h = harness();
    FakeSource.instances.length = 0;
    h.live.connect();
    const first = h.es();
    h.live.disconnect();
    expect(first.closed).toBe(true);

    h.store.setChannel(null);
    h.live.connect();
    expect(h.es().url).toBe("/api/c//live?as=owner");
  });

  it("goes live on open and offline on an error", () => {
    const h = harness();
    h.live.connect();
    h.es().open();
    expect(h.store.getState().live).toBe("live");
    h.es().fail();
    expect(h.store.getState().live).toBe("offline");
  });

  it("checks whoami on an error and signs out only on a 401 that says signin", async () => {
    const h = harness();
    h.live.connect();
    h.es().fail();
    await vi.waitFor(() => expect(h.whoami).toHaveBeenCalledWith("/api/whoami"));
    expect(h.onSignedOut).not.toHaveBeenCalled();

    h.whoami.mockImplementation(async () => new Response(JSON.stringify({ signin: true }), { status: 401 }));
    h.es().fail();
    await vi.waitFor(() => expect(h.onSignedOut).toHaveBeenCalledTimes(1));

    h.whoami.mockImplementation(async () => new Response("<html>", { status: 401 }));
    h.es().fail();
    await vi.waitFor(() => expect(h.whoami).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(h.onSignedOut).toHaveBeenCalledTimes(1);

    h.whoami.mockImplementation(async () => new Response("null", { status: 401 })); // parses, says nothing
    h.es().fail();
    await vi.waitFor(() => expect(h.whoami).toHaveBeenCalledTimes(4));
    await Promise.resolve();
    expect(h.onSignedOut).toHaveBeenCalledTimes(1);

    h.whoami.mockImplementation(async () => {
      throw new Error("down");
    });
    h.es().fail();
    await vi.waitFor(() => expect(h.whoami).toHaveBeenCalledTimes(5));
  });
});

describe("stream messages", () => {
  it("the first hello goes live and loads the timeline once", async () => {
    const h = harness();
    h.live.connect();
    h.es().send({ type: "hello" });
    expect(h.store.getState().live).toBe("live");
    await vi.waitFor(() => expect(count(h.calls, "/api/c/c1/timeline?limit=300")).toBe(1));
  });

  it("a second hello resyncs everything the reconnect could have missed", async () => {
    const h = harness();
    h.live.connect();
    await h.store.loadTimeline();
    await h.store.loadSessions();
    h.calls.length = 0;

    h.es().send({ type: "hello" }); // HELLO 0 → 1: the first hello of this connection
    h.es().send({ type: "hello" }); // HELLO 1 → 2: a reconnect — read everything once
    await vi.waitFor(() => {
      expect(count(h.calls, "/api/c/c1/timeline?limit=300")).toBe(1);
      expect(count(h.calls, "/api/c/c1/sessions")).toBe(1);
      expect(count(h.calls, "/api/c/c1")).toBe(1);
    });
    await h.advance(350);
    expect(count(h.calls, "/api/c/c1/board")).toBe(1);
    await h.advance(150);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);
  });

  it("ignores junk and messages from a channel it is no longer on", async () => {
    const h = harness();
    h.live.connect();
    h.es().sendRaw("not json");
    h.es().send({ type: "hello" });
    await vi.waitFor(() => expect(h.store.getState().live).toBe("live"));

    h.store.setChannel("c2");
    h.es().send({ type: "event", data: { seq: 9, topic: "msg", from: "a.b" } });
    expect(h.store.getState().timeline).toBeNull(); // the event never landed
  });
});

describe("events", () => {
  const ask = (over: Partial<FeedEvent> = {}): FeedEvent => ({
    seq: 5,
    topic: "ask",
    from: "a.b",
    to: "owner",
    msg: "keep going?",
    ...over,
  });

  it("appends the event to the timeline and notes the reply", async () => {
    const h = harness();
    h.live.connect();
    await h.store.loadTimeline();
    h.es().send({ type: "event", data: { seq: 6, topic: "reply", from: "owner", reply_to: 2 } });
    expect(h.store.getState().timeline?.at(-1)?.seq).toBe(6);
    expect(h.store.getState().replies.get(2)).toEqual(["owner"]);
  });

  it("toasts an owner-addressed message: asks one way, everything else the other", async () => {
    const h = harness();
    h.live.connect();
    h.es().send({ type: "event", data: ask() });
    expect(h.toast).toHaveBeenCalledWith("a.b asks you: keep going?");

    h.toast.mockClear();
    h.es().send({ type: "event", data: ask({ seq: 6, topic: "msg", msg: "status?" }) });
    expect(h.toast).toHaveBeenCalledWith("a.b to you: status?");

    h.toast.mockClear();
    h.es().send({ type: "event", data: { seq: 7, topic: "ask", from: "a.b", to: "owner" } }); // no message
    expect(h.toast).toHaveBeenCalledWith("a.b asks you: ask");

    h.toast.mockClear();
    h.es().send({ type: "event", data: ask({ seq: 8, from: "owner" }) });
    h.es().send({ type: "event", data: ask({ seq: 9, to: "c.d" }) });
    h.es().send({ type: "event", data: ask({ seq: 10, topic: "reply", msg: "done" }) });
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("truncates the toast text at 140 characters", async () => {
    const h = harness();
    h.live.connect();
    const long = "x".repeat(200);
    h.es().send({ type: "event", data: ask({ msg: long }) });
    expect(h.toast).toHaveBeenCalledWith(`a.b asks you: ${"x".repeat(140)}`);
  });

  it("notifies an ask that waits for the owner, unless the Inbox is already open and visible", async () => {
    const h = harness();
    h.live.connect();
    h.nf.grant();
    h.storage.setItem("huddle:notify", "true");

    h.setInboxOpen(true);
    h.es().send({ type: "event", data: ask({ needs_reply: true }) });
    expect(h.shown).toEqual([]); // visible on the Inbox: the ask is already in view

    h.setHidden(true);
    h.es().send({ type: "event", data: ask({ seq: 6, needs_reply: true }) });
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.title).toBe("a.b asks you");
    expect(h.shown[0]?.body).toBe("keep going?");
    expect(h.shown[0]?.tag).toBe("huddle-c1-6");

    h.setHidden(false);
    h.setInboxOpen(false);
    h.es().send({ type: "event", data: ask({ seq: 7, needs_reply: true }) });
    expect(h.shown).toHaveLength(2);
  });

  it("does not notify without the setting, and truncates the body at 200 characters", async () => {
    const h = harness();
    h.live.connect();
    h.nf.grant();
    h.storage.setItem("huddle:notify", "true");
    h.setHidden(true);
    const long = "y".repeat(300);
    h.es().send({ type: "event", data: ask({ needs_reply: true, msg: long }) });
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.body).toBe("y".repeat(200));

    const quiet = harness();
    quiet.live.connect();
    quiet.setHidden(true);
    quiet.es().send({ type: "event", data: ask({ needs_reply: true }) });
    expect(quiet.shown).toEqual([]); // the owner never switched notifications on
  });

  it("old events are answered with silence (no toast, no notification)", async () => {
    const h = harness();
    h.live.connect();
    await h.store.loadTimeline();
    h.es().send({ type: "event", data: ask({ seq: 1, needs_reply: true }) });
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.shown).toEqual([]);
  });

  it("refills the Inbox and roster after an event, and flags knowledge events", async () => {
    const h = harness();
    h.live.connect();
    await h.store.loadTimeline();
    h.calls.length = 0;
    h.es().send({ type: "event", data: { seq: 6, topic: "kb.added", from: "a.b" } });
    await h.advance(500);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);
    await h.advance(400);
    expect(count(h.calls, "/api/c/c1/sessions")).toBe(1);
  });
});

describe("presence", () => {
  it("patches the roster entry and repaints the roster soon", async () => {
    const h = harness();
    h.live.connect();
    await h.store.loadSessions();
    h.es().send({ type: "presence", data: { name: "a.b", state: "blocked" } });
    await h.advance(60);
    expect(h.store.getState().sessions?.sessions.find((s) => s.name === "a.b")?.state).toBe("blocked");
  });

  it("refills the Inbox when a session's pause state flips", async () => {
    const h = harness();
    h.live.connect();
    await h.store.loadSessions();
    await h.advance(100); // settle the refills the roster load asked for
    h.calls.length = 0;
    h.es().send({ type: "presence", data: { name: "a.b", control: "pause" } });
    await h.advance(500);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);
    h.calls.length = 0;
    h.es().send({ type: "presence", data: { name: "a.b", control: "pause" } });
    await h.advance(500);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(0);
  });
});

describe("other messages", () => {
  it("task and plan messages refill board and Inbox and pass the task id on", async () => {
    const h = harness();
    h.live.connect();
    const seen: { what: string; x?: unknown }[] = [];
    h.store.subscribe((what, x) => seen.push({ what, x }));
    h.es().send({ type: "task", data: { id: "t1" } });
    expect(seen.at(-1)).toEqual({ what: "task", x: "t1" });
    await h.advance(650); // board at 350, attention at 500
    expect(count(h.calls, "/api/c/c1/board")).toBe(1);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);

    h.calls.length = 0;
    h.es().send({ type: "plan", data: { id: "t2" } });
    expect(seen.at(-1)).toEqual({ what: "task", x: "t2" });
    await h.advance(350);
    expect(count(h.calls, "/api/c/c1/board")).toBe(1);
    await h.advance(150);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);
  });

  it("an ack refills the roster, a channel message refills the row too, a conflict is passed on", async () => {
    const h = harness();
    h.live.connect();
    const seen: { what: string; x?: unknown }[] = [];
    h.store.subscribe((what, x) => seen.push({ what, x }));
    await h.advance(1000); // settle the fill that opening the channel asked for
    h.calls.length = 0;

    h.es().send({ type: "ack", data: {} });
    await h.advance(400);
    expect(count(h.calls, "/api/c/c1/sessions")).toBe(1);

    h.es().send({ type: "channel", data: {} });
    await vi.waitFor(() => expect(count(h.calls, "/api/c/c1")).toBe(1));
    await h.advance(400);
    await h.advance(100);
    expect(count(h.calls, "/api/c/c1/sessions")).toBe(2);
    expect(count(h.calls, "/api/c/c1/attention")).toBe(1);

    h.es().send({ type: "conflict", data: { file: "a.ts" } });
    expect(seen.at(-1)).toEqual({ what: "conflict", x: { file: "a.ts" } });
  });
});

describe("notifications", () => {
  it("notifyOn is true only when the setting is kept, the browser can, and it granted", () => {
    const h = harness();
    expect(h.live.notifyOn()).toBe(false);
    h.storage.setItem("huddle:notify", "true");
    expect(h.live.notifyOn()).toBe(false);
    h.nf.grant();
    expect(h.live.notifyOn()).toBe(true);
    h.nf.unsupported();
    expect(h.live.notifyOn()).toBe(false);
  });

  it("toggleNotify toasts when the browser cannot show notifications at all", async () => {
    const h = harness();
    h.nf.unsupported();
    await h.live.toggleNotify();
    expect(h.toast).toHaveBeenCalledWith("This browser cannot show notifications.", { bad: true });
    expect(h.storage.getItem("huddle:notify")).toBeNull();
  });

  it("toggleNotify switches an active setting off", async () => {
    const h = harness();
    h.nf.grant();
    h.storage.setItem("huddle:notify", "true");
    await h.live.toggleNotify();
    expect(h.storage.getItem("huddle:notify")).toBe("false");
    expect(h.toast).toHaveBeenCalledWith("Notifications off");
  });

  it("toggleNotify asks the browser and keeps the setting when granted", async () => {
    const h = harness();
    h.nf.grant();
    await h.live.toggleNotify();
    expect(h.storage.getItem("huddle:notify")).toBe("true");
    expect(h.toast).toHaveBeenCalledWith("You will get a notification when a session asks you something.");

    const asked = harness();
    asked.nf.answerRequest("granted"); // the browser answers the prompt with granted
    await asked.live.toggleNotify();
    expect(asked.storage.getItem("huddle:notify")).toBe("true");
    expect(asked.toast).toHaveBeenCalledWith(
      "You will get a notification when a session asks you something.",
    );
  });

  it("toggleNotify switches off when the browser denies or blocks the request", async () => {
    const h = harness();
    h.nf.deny();
    await h.live.toggleNotify();
    expect(h.storage.getItem("huddle:notify")).toBe("false");
    expect(h.toast).toHaveBeenCalledWith(
      "The browser blocked notifications for this page. Allow them in the site settings.",
      { bad: true },
    );

    const broken = harness();
    broken.nf.breakRequest();
    await broken.live.toggleNotify();
    expect(broken.storage.getItem("huddle:notify")).toBe("false");
    expect(broken.toast).toHaveBeenCalledWith(
      "The browser blocked notifications for this page. Allow them in the site settings.",
      { bad: true },
    );
  });

  it("notifyAsk shows the ask and raises the Inbox when clicked", async () => {
    const h = harness();
    h.nf.grant();
    h.storage.setItem("huddle:notify", "true");
    h.live.notifyAsk({ seq: 3, topic: "ask", from: "a.b", msg: "shall I deploy?" });
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.tag).toBe("huddle-c1-3");
    h.shown[0]?.onClick();
    expect(h.focusInbox).toHaveBeenCalledWith("c1");
  });

  it("notifyAsk stays quiet while the page is visible on the Inbox, and swallows failures", () => {
    const h = harness();
    h.nf.grant();
    h.storage.setItem("huddle:notify", "true");
    h.setInboxOpen(true);
    h.live.notifyAsk({ seq: 3, topic: "ask", from: "a.b" });
    expect(h.shown).toEqual([]);

    h.setHidden(true);
    h.live.notifyAsk({ seq: 4, topic: "ask", from: "a.b" });
    expect(h.shown).toHaveLength(1); // hidden: notify even on the Inbox

    const throwing = harness();
    throwing.nf.grant();
    throwing.storage.setItem("huddle:notify", "true");
    throwing.notify.show = () => {
      throw new Error("blocked");
    };
    expect(() => throwing.live.notifyAsk({ seq: 5, topic: "ask", from: "a.b" })).not.toThrow();
  });
});
