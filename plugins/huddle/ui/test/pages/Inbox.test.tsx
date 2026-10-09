// Inbox.test.tsx — the Inbox page: every card renders, every action calls the same op or endpoint
// with the same args the legacy code sent, handled cards leave with the focus moved on, and the
// refusals come back as bad toasts.
import { act, fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import {
  ALERT_KIND,
  alertKind,
  extrasNeeds,
  extrasNeedsText,
  Inbox,
  type InboxProps,
  inboxCountOf,
  QUICK,
  reassignOwners,
  summaryOf,
} from "../../src/pages/Inbox.tsx";
import type {
  Approval,
  Attention,
  Board,
  Extras,
  FeedEvent,
  HuddleState,
  HuddleStore,
  PlanStep,
  RadarAlert,
  RosterSession,
} from "../../src/store.ts";

const CH = "lab";
const NOW = 1_800_000_000_000;

/** A stamp so long ago the relative time reads in minutes. */
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

const STEP = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({
  id,
  title: `Task ${id}`,
  status: "doing",
  owner: "greta",
  ...over,
});

const ATT: Attention = {
  asks: [{ seq: 11, from: "greta", msg: "Ship the fix now?", ts: ago(20), task: "t1" }],
  gates: [{ id: "t2", title: "Run the migration", gate: "ask-first", owner: "greta" }],
  paused: [{ name: "greta", by: "owner", at: ago(40) }],
  blocked: [{ id: "t3", title: "Clean up", owner: "greta", note: "needs a review", waits_on: ["t1"] }],
};

const SESSIONS: RosterSession[] = [
  { name: "greta", state: "working" },
  { name: "orch", state: "idle" },
  { name: "kid", state: "idle", parent: "orch" },
  { name: "gone", state: "left" },
];

const ALERT: RadarAlert = {
  id: 3,
  kind: "stuck",
  session: "greta",
  detail: "No progress for 20 minutes",
  since: ago(25),
  cost: 1.5,
};

const EXTRAS: Extras = {
  ch: CH,
  approvals: [{ seq: 7, from: "greta", labels: ["git push"], ts: ago(15) }],
  obs: { available: true, alerts: [ALERT], cost: { greta: 1.5 }, total: 1.5, range: "24h" },
};

function makeState(over: Partial<HuddleState> = {}): HuddleState {
  return {
    ch: CH,
    info: null,
    board: null,
    byId: new Map<string, PlanStep>([
      ["t1", STEP("t1", { title: "Fix login" })],
      ["t3", STEP("t3", { title: "Clean up", status: "blocked" })],
    ]),
    sessions: { sessions: SESSIONS },
    timeline: null,
    attention: ATT,
    channels: null,
    replies: new Map<number, string[]>(),
    extras: EXTRAS,
    live: "live",
    ...over,
  };
}

/** The page over fakes: api, store and shell callbacks all recorded; `onReload` stages what a
 *  store loadAttention brings back (the test then repaints with the mutated state). */
function setup(stateIn?: HuddleState) {
  const state = stateIn ?? makeState();
  const api: Api = {
    api: vi.fn(async () => ({ approvals: [] })),
    op: vi.fn(async () => ({})),
    channelPath: (ch, p) => `/api/c/${encodeURIComponent(ch)}${p}`,
    channelHref: (ch, p) => `#/c/${ch}${p}`,
  };
  let reload: (() => void) | null = null;
  const store: HuddleStore = {
    getState: () => state,
    subscribe: () => () => {},
    changed: () => {},
    setChannel: () => {},
    loadChannels: async () => {},
    setChannels: () => {},
    loadInfo: async () => {},
    loadBoard: vi.fn(async () => null as Board | null),
    loadSessions: vi.fn(async () => {}),
    loadAttention: vi.fn(async () => {
      if (reload) reload();
    }),
    loadTimeline: async () => {},
    olderTimeline: async () => 0,
    inboxCount: () => 0,
    attChanged: vi.fn(),
    sessChanged: vi.fn(),
    boardChanged: vi.fn(),
    setLive: () => {},
    recordEvent: (_e: FeedEvent) => true,
    applyPresence: () => {},
    loadExtras: vi.fn(async () => {}),
    needs: () => 0,
    needsText: () => "",
    costOf: () => undefined,
    dispose: () => {},
  };
  const toast = vi.fn();
  const compose = vi.fn();
  const openTask = vi.fn();
  const openSession = vi.fn();
  const props: InboxProps = {
    state,
    api,
    ch: CH,
    now: NOW,
    toast,
    onCompose: compose,
    onOpenTask: openTask,
    onOpenSession: openSession,
    store,
  };
  const view = render(<Inbox {...props} />);
  return {
    view,
    state,
    api,
    store,
    toast,
    compose,
    openTask,
    openSession,
    repaint: () => view.rerender(<Inbox {...props} />),
    onReload(f: (() => void) | null): void {
      reload = f;
    },
    props,
  };
}

/** Fires an event and flushes every microtask and timer the handler sets off. */
const flush = async (f: () => void): Promise<void> => {
  await act(async () => {
    f();
    await new Promise((r) => setTimeout(r, 0));
  });
};
const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el).toBeTruthy();
  await flush(() => fireEvent.click(el as Element));
};
const press = async (el: Element, key: string, over: Record<string, unknown> = {}): Promise<void> =>
  flush(() => fireEvent.keyDown(el, { key, ...over }));
const type = (el: Element, value: string): void => {
  fireEvent.input(el, { target: { value } });
};

describe("Inbox header", () => {
  it("fills itself on the way in and lays out every section that needs the owner", () => {
    const h = setup();
    expect(screen.getByText("Questions for you")).toBeTruthy();
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(h.store.loadAttention).toHaveBeenCalled();
  });

  it("says nothing needs you when the counts are zero", () => {
    setup(makeState({ attention: {}, extras: { ch: CH, approvals: [], obs: null } }));
    expect(screen.getByText("All clear")).toBeTruthy();
  });

  it("shows the loading skeleton until attention arrives", () => {
    setup(makeState({ attention: null }));
    expect(screen.getByLabelText("Loading")).toBeTruthy();
  });
});

describe("Inbox empty state", () => {
  it("draws the all-clear card with its two ways out", () => {
    setup(makeState({ attention: {}, extras: { ch: CH, approvals: [], obs: null } }));
    const clear = screen.getByText("All clear");
    expect(clear.getAttribute("id")).toBe("ib-clear");
    expect(screen.getByText("No questions, approvals, paused sessions or blocked tasks.")).toBeTruthy();
    const links = [...screen.getAllByRole("link")].map((a) => a.getAttribute("href"));
    expect(links).toContain("#/c/lab/team");
    expect(links).toContain("#/c/lab/work");
    expect(screen.getByText("See the team")).toBeTruthy();
    expect(screen.getByText("Plan work")).toBeTruthy();
  });
});

describe("asks", () => {
  it("renders a question card: who asks, the message, the task chip, quick replies and a reply box", () => {
    setup();
    const meta = screen.getByText(/asks you ·/);
    expect(meta.textContent).toBe("asks you · 20 min ago");
    expect(meta.parentElement?.querySelector("b")?.textContent).toBe("greta");
    expect(screen.getByText("Ship the fix now?")).toBeTruthy();
    const card = meta.closest("[data-item]") as HTMLElement;
    const about = card.querySelector(".text-xs span:last-child");
    expect(about?.textContent).toBe("about t1Fix login");
    const chip = about?.querySelector("a");
    expect(chip?.getAttribute("href")).toBe("#/c/lab/inbox?t=t1");
    expect(chip?.textContent).toBe("t1Fix login");
    expect(screen.getByRole("group", { name: "Quick replies" })).toBeTruthy();
    for (const q of QUICK) expect(screen.getByRole("button", { name: q })).toBeTruthy();
    expect(
      (
        screen.getByPlaceholderText(
          "Write a reply (Enter sends, Shift+Enter adds a line)",
        ) as HTMLTextAreaElement
      ).id,
    ).toBe("ar-11");
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });

  it("sends a quick reply as the reply op, says so and reloads attention", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "No, stop" }));
    expect(h.api.op).toHaveBeenCalledWith(CH, "reply", { seq: 11, msg: "No, stop" });
    expect(h.toast).toHaveBeenCalledWith("Reply sent", {});
    expect(h.store.loadAttention).toHaveBeenCalled();
  });

  it("sends a typed reply from the box, on the button and on Enter, but not on Shift+Enter", async () => {
    const h = setup();
    const ta = screen.getByPlaceholderText(
      "Write a reply (Enter sends, Shift+Enter adds a line)",
    ) as HTMLTextAreaElement;
    type(ta, "  Give me a minute  ");
    await click(screen.getByRole("button", { name: "Reply" }));
    expect(h.api.op).toHaveBeenCalledWith(CH, "reply", { seq: 11, msg: "Give me a minute" });
    type(ta, "Or two");
    await press(ta, "Enter");
    expect(h.api.op).toHaveBeenCalledWith(CH, "reply", { seq: 11, msg: "Or two" });
    type(ta, "line one");
    await press(ta, "Enter", { shiftKey: true });
    expect(h.api.op).toHaveBeenCalledTimes(2);
  });

  it("answers an empty reply with the caret, not a call", async () => {
    const h = setup();
    const ta = screen.getByPlaceholderText(
      "Write a reply (Enter sends, Shift+Enter adds a line)",
    ) as HTMLTextAreaElement;
    type(ta, "   ");
    await click(screen.getByRole("button", { name: "Reply" }));
    expect(h.api.op).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(ta);
  });

  it("bad toasts a refused reply and hands the buttons back", async () => {
    const h = setup(makeState());
    h.api.op = vi.fn(async () => {
      throw new Error("the session is paused");
    });
    h.repaint();
    const chip = screen.getByRole("button", { name: "Yes, go ahead" }) as HTMLButtonElement;
    await click(chip);
    expect(h.toast).toHaveBeenCalledWith("the session is paused", { bad: true });
    expect(chip.disabled).toBe(false);
    expect(screen.getByText("Ship the fix now?")).toBeTruthy();
  });

  it("explains a server without the op", async () => {
    const h = setup();
    h.api.op = vi.fn(async () => {
      throw Object.assign(new Error("no operation named reply"), { status: 404 });
    });
    h.repaint();
    await click(screen.getByRole("button", { name: "Yes, go ahead" }));
    expect(h.toast).toHaveBeenCalledWith(
      "This Huddle server does not support “reply” yet. Update the server.",
      { bad: true },
    );
  });
});

describe("gates", () => {
  it("renders an approval card: the gated task, why it waits, Approve and the note variant", () => {
    setup();
    const link = screen.getByText("Run the migration");
    expect(link.closest("a")?.getAttribute("href")).toBe("#/c/lab/inbox?t=t2");
    expect(screen.getByText("greta waits for your go-ahead before it starts (ask first).")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve with a note" })).toBeTruthy();
  });

  it("sends an owner with its waits when the gate is not ask-first and the owner is the channel owner", () => {
    setup(
      makeState({
        attention: { gates: [{ id: "t9", owner: "owner" }] },
        extras: null,
      }),
    );
    expect(screen.getByText("It waits for your go-ahead before it starts.")).toBeTruthy();
  });

  it("approves plainly: op, toast, board and attention reload", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Approve" }));
    expect(h.api.op).toHaveBeenCalledWith(CH, "approve", { id: "t2", msg: "" });
    expect(h.toast).toHaveBeenCalledWith("Approved t2", {});
    expect(h.store.boardChanged).toHaveBeenCalled();
    expect(h.store.loadAttention).toHaveBeenCalled();
  });

  it("approves with a note: the field opens focused, Enter sends it", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Approve with a note" }));
    const input = screen.getByPlaceholderText("Note for greta") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(screen.getByLabelText("Note for greta")).toBeTruthy();
    type(input, "lgtm, but watch the index");
    await press(input, "Enter");
    expect(h.api.op).toHaveBeenCalledWith(CH, "approve", { id: "t2", msg: "lgtm, but watch the index" });
  });

  it("sends the note from the note row's Approve button too", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Approve with a note" }));
    const input = screen.getByPlaceholderText("Note for greta");
    type(input, "after t1 lands");
    const approves = screen.getAllByRole("button", { name: "Approve" });
    await click(approves[approves.length - 1]);
    expect(h.api.op).toHaveBeenCalledWith(CH, "approve", { id: "t2", msg: "after t1 lands" });
  });

  it("asks on behalf of the session when the gate names no owner", async () => {
    setup(makeState({ attention: { gates: [{ id: "t8" }] }, extras: null, byId: new Map() }));
    expect(screen.getByText("It waits for your go-ahead before it starts.")).toBeTruthy();
    await click(screen.getByRole("button", { name: "Approve with a note" }));
    expect(screen.getByPlaceholderText("Note for the session")).toBeTruthy();
  });

  it("cancels the note and puts the caret on the button that reopens it", async () => {
    setup();
    await click(screen.getByRole("button", { name: "Approve with a note" }));
    await click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Note for greta")).toBeNull();
    expect(document.activeElement?.textContent).toBe("Approve with a note");
    await click(screen.getByRole("button", { name: "Approve with a note" }));
    const input = screen.getByPlaceholderText("Note for greta");
    await press(input, "Escape");
    expect(screen.queryByPlaceholderText("Note for greta")).toBeNull();
  });

  it("bad toasts a refused approval and keeps the button", async () => {
    const h = setup();
    h.api.op = vi.fn(async () => {
      throw new Error("waited on t1");
    });
    h.repaint();
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    await click(approve);
    expect(h.toast).toHaveBeenCalledWith("waited on t1", { bad: true });
    expect(approve.disabled).toBe(false);
  });
});

describe("paused sessions", () => {
  it("renders a paused card: who paused it, when, Message and Resume", () => {
    setup();
    expect(screen.getByText("greta is paused")).toBeTruthy();
    expect(screen.getByText(/^Paused by you/)).toBeTruthy();
    expect(screen.getByText(/Its changes are refused until you resume it\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume greta" })).toBeTruthy();
  });

  it("opens the composer for the paused session", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Message" }));
    expect(h.compose).toHaveBeenCalledWith({ to: "greta", mode: "msg" });
  });

  it("resumes through the resume op and reloads sessions and attention", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Resume greta" }));
    expect(h.api.op).toHaveBeenCalledWith(CH, "resume", { target: "greta" });
    expect(h.toast).toHaveBeenCalledWith("greta resumed", { undo: expect.any(Function) });
    expect(h.store.loadSessions).toHaveBeenCalled();
    expect(h.store.loadAttention).toHaveBeenCalled();
  });

  it("pauses again from the resume toast's undo", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Resume greta" }));
    const undo = h.toast.mock.calls.find(([t]) => t === "greta resumed")?.[1]?.undo as () => void;
    await flush(undo);
    expect(h.api.op).toHaveBeenCalledWith(CH, "pause", { target: "greta" });
    expect(h.toast).toHaveBeenCalledWith("greta paused again", {});
  });

  it("opens a session by props from its title", async () => {
    const h = setup();
    await click(screen.getByText("greta is paused"));
    expect(h.openSession).toHaveBeenCalledWith("greta");
  });
});

describe("blocked tasks", () => {
  it("renders a blocked card: owner, note, waits on, unblock, reassign, open task", () => {
    setup();
    expect(screen.getByText(/Owned by greta/).textContent).toBe("Owned by greta. “needs a review”");
    expect(screen.getByText(/“needs a review”/)).toBeTruthy();
    expect(screen.getByText("Waits on")).toBeTruthy();
    const waits = screen.getByText("Waits on").parentElement;
    expect(waits?.querySelector("a")?.getAttribute("href")).toBe("#/c/lab/inbox?t=t1");
    expect(waits?.textContent).toContain("Fix login");
    expect(screen.getByRole("button", { name: "Unblock" })).toBeTruthy();
    const combo = screen.getByRole("combobox", { name: "Give t3 to" }) as HTMLSelectElement;
    const options = [...combo.options].map((o) => o.textContent);
    expect(options).toEqual(["Give it to…", "Me", "orch"]);
    expect(screen.getByText("Open task")).toBeTruthy();
  });

  it("renders Yours and no note line for an owner-held task without one", () => {
    setup(
      makeState({ attention: { blocked: [{ id: "t5", owner: "owner" }] }, extras: null, byId: new Map() }),
    );
    expect(screen.getByText("Yours")).toBeTruthy();
    expect(screen.queryByText(/^“/)).toBeNull();
  });

  it("calls an unowned task nobody's and a paused card with no pauser someone's", () => {
    setup(
      makeState({
        attention: {
          blocked: [{ id: "t6" }],
          paused: [{ name: "kid", at: ago(10) }],
        },
        byId: new Map(),
      }),
    );
    expect(screen.getByText(/Nobody owns it/)).toBeTruthy();
    expect(screen.getByText(/Paused by someone/).textContent).toBe(
      "Paused by someone 10 min ago. Its changes are refused until you resume it.",
    );
  });

  it("unblocks through the task_status op the way setTaskStatus does, then refills board and attention", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Unblock" }));
    expect(h.api.op).toHaveBeenCalledWith(CH, "task_status", {
      id: "t3",
      status: "todo",
      note: "unblocked by the owner",
    });
    expect(h.toast).toHaveBeenCalledWith("t3 is to do", { undo: expect.any(Function) });
    expect(h.store.loadBoard).toHaveBeenCalled();
    expect(h.store.attChanged).toHaveBeenCalled();
    expect(h.store.loadAttention).toHaveBeenCalled();
  });

  it("undoes the unblock back to the previous status", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Unblock" }));
    const undo = h.toast.mock.calls.find(([t]) => t === "t3 is to do")?.[1]?.undo as () => void;
    await flush(undo);
    expect(h.api.op).toHaveBeenCalledWith(CH, "task_status", {
      id: "t3",
      status: "blocked",
      note: "undo: back to blocked",
    });
    expect(h.toast).toHaveBeenCalledWith("t3 is blocked", { undo: expect.any(Function) });
  });

  it("will not unblock a task whose status it does not know", async () => {
    const h = setup(makeState({ byId: new Map() }));
    await click(screen.getByRole("button", { name: "Unblock" }));
    expect(h.api.op).not.toHaveBeenCalled();
  });

  it("will not unblock a task that already sits in To do", async () => {
    const h = setup(makeState({ byId: new Map([["t3", STEP("t3", { status: "todo" })]]) }));
    await click(screen.getByRole("button", { name: "Unblock" }));
    expect(h.api.op).not.toHaveBeenCalled();
  });

  it("keeps the blocked card when the unblock is refused", async () => {
    const h = setup();
    h.api.op = vi.fn(async () => {
      throw new Error("waits on t1");
    });
    h.repaint();
    await click(screen.getByRole("button", { name: "Unblock" }));
    expect(h.toast).toHaveBeenCalledWith("waits on t1", { bad: true });
    expect(h.store.loadBoard).not.toHaveBeenCalled();
    expect(h.store.attChanged).not.toHaveBeenCalled();
    expect(screen.getByText(/Owned by greta/)).toBeTruthy();
  });

  it("reassigns a blocked task and offers the undo", async () => {
    const h = setup();
    const combo = screen.getByRole("combobox", { name: "Give t3 to" }) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(combo, { target: { value: "orch" } });
    });
    expect(h.api.op).toHaveBeenCalledWith(CH, "task_update", { id: "t3", owner: "orch" });
    expect(h.toast).toHaveBeenCalledWith("t3 now belongs to orch", { undo: expect.any(Function) });
    expect(h.store.boardChanged).toHaveBeenCalled();
    expect(h.store.attChanged).toHaveBeenCalled();
    const undo = h.toast.mock.calls.find(([t]) => t === "t3 now belongs to orch")?.[1]?.undo as () => void;
    await flush(undo);
    expect(h.api.op).toHaveBeenCalledWith(CH, "task_update", { id: "t3", owner: "greta" });
    expect(h.toast).toHaveBeenCalledWith("t3 is back with greta", {});
  });

  it("says nobody in the undo when the task had no owner", async () => {
    const h = setup(makeState({ byId: new Map([["t3", STEP("t3", { owner: null })]]) }));
    const combo = screen.getByRole("combobox", { name: "Give t3 to" }) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(combo, { target: { value: "owner" } });
    });
    expect(h.toast).toHaveBeenCalledWith("t3 now belongs to you", { undo: expect.any(Function) });
    const undo = h.toast.mock.calls.find(([t]) => t === "t3 now belongs to you")?.[1]?.undo as () => void;
    await flush(undo);
    expect(h.toast).toHaveBeenCalledWith("t3 is back with nobody", {});
  });

  it("ignores the select returning to its placeholder", async () => {
    const h = setup();
    const combo = screen.getByRole("combobox", { name: "Give t3 to" }) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(combo, { target: { value: "" } });
    });
    expect(h.api.op).not.toHaveBeenCalled();
  });

  it("keeps the board alone when the reassignment is refused", async () => {
    const h = setup();
    h.api.op = vi.fn(async () => {
      throw new Error("paused");
    });
    h.repaint();
    const combo = screen.getByRole("combobox", { name: "Give t3 to" }) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(combo, { target: { value: "orch" } });
    });
    await flush(() => {});
    expect(h.toast).toHaveBeenCalledWith("paused", { bad: true });
    expect(h.store.boardChanged).not.toHaveBeenCalled();
    expect(h.store.attChanged).not.toHaveBeenCalled();
  });

  it("opens the task drawer by props", async () => {
    const h = setup();
    await click(screen.getByText("Open task"));
    expect(h.openTask).toHaveBeenCalledWith("t3");
  });
});

describe("extras: approval requests", () => {
  it("renders the section with the request, its session links and Dismiss", () => {
    setup();
    expect(screen.getByText("Asked for your permission")).toBeTruthy();
    expect(document.body.textContent).toContain("greta wants to run a command your rules name: git push");
    expect(screen.getByText("git push")).toBeTruthy();
    expect(screen.getByText(/answer there/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open session" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("names a command when the request carries no labels", () => {
    setup(makeState({ extras: { ch: CH, approvals: [{ seq: 9, from: "greta" }], obs: null } }));
    expect(screen.getByText("a command")).toBeTruthy();
  });

  it("dismisses one request through the same endpoint and reloads the extras", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Dismiss" }));
    expect(h.api.api).toHaveBeenCalledWith("/api/c/lab/x/approvals/dismiss?as=owner", { body: { seq: 7 } });
    expect(h.store.loadExtras).toHaveBeenCalled();
  });

  it("bad toasts a refused dismissal and hands the button back", async () => {
    const h = setup();
    h.api.api = vi.fn(async () => {
      throw new Error("gone");
    });
    h.repaint();
    const dismiss = screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement;
    await click(dismiss);
    expect(h.toast).toHaveBeenCalledWith("gone", { bad: true });
    expect(dismiss.disabled).toBe(false);
  });

  it("offers Dismiss all from two requests on, and sends all: true with a toast", async () => {
    const h = setup(
      makeState({
        extras: {
          ch: CH,
          approvals: [
            { seq: 7, from: "greta" },
            { seq: 8, from: "paule" },
          ],
          obs: null,
        },
      }),
    );
    expect(screen.getByText("Asked for your permission")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
    const all = screen.getByRole("button", { name: "Dismiss all" });
    await click(all);
    expect(h.api.api).toHaveBeenCalledWith("/api/c/lab/x/approvals/dismiss?as=owner", {
      body: { all: true },
    });
    expect(h.toast).toHaveBeenCalledWith("Dismissed");
  });

  it("bad toasts a refused dismiss-all, however it failed, and hands the button back", async () => {
    const h = setup(
      makeState({
        extras: {
          ch: CH,
          approvals: [
            { seq: 7, from: "greta" },
            { seq: 8, from: "paule" },
          ],
          obs: null,
        },
      }),
    );
    h.api.api = vi.fn(() => Promise.reject("plain refusal")) as typeof h.api.api;
    h.repaint();
    const all = screen.getByRole("button", { name: "Dismiss all" }) as HTMLButtonElement;
    await click(all);
    expect(h.toast).toHaveBeenCalledWith("plain refusal", { bad: true });
    expect(all.disabled).toBe(false);
  });

  it("offers no Dismiss all for a single request", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Dismiss all" })).toBeNull();
  });

  it("leaves the extras out when they belong to another channel", () => {
    setup(makeState({ extras: { ...EXTRAS, ch: "other" } }));
    expect(screen.queryByText("Asked for your permission")).toBeNull();
    expect(screen.queryByText("Alerts from Radar")).toBeNull();
  });
});

describe("extras: Radar alerts", () => {
  it("renders an alert: session, kind, detail, since and cost, with Open session and Pause", () => {
    setup();
    expect(screen.getByText("Alerts from Radar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause greta" })).toBeTruthy();
    expect(screen.getByText(/: Stuck/).textContent).toBe("greta: Stuck");
    const detail = screen.getByText(/No progress for 20 minutes/);
    expect(detail.textContent).toBe("No progress for 20 minutes · since 25 min ago · $1.50 so far");
    const pause = screen.getByRole("button", { name: "Pause greta" });
    expect(pause.getAttribute("data-xwhy")).toBe("Stuck");
  });

  it("marks a subagent and a budget alert", () => {
    setup(
      makeState({
        extras: {
          ch: CH,
          approvals: [],
          obs: {
            available: true,
            alerts: [{ id: 4, kind: "budget", session: "kid", agent: true, detail: "Over budget" }],
          },
        },
      }),
    );
    expect(screen.getByText("(a subagent)")).toBeTruthy();
    expect(screen.getByText(": Budget")).toBeTruthy();
    expect(document.querySelector(".c-red")).toBeTruthy();
  });

  it("shows a raw kind as it is and skips missing since and cost, without a roster to check", () => {
    setup(
      makeState({
        sessions: null,
        extras: {
          ch: CH,
          approvals: [],
          obs: { available: true, alerts: [{ id: 5, kind: "weird", session: "orch" }] },
        },
      }),
    );
    expect(screen.getByText(": weird")).toBeTruthy();
    expect(screen.queryByText(/since/)).toBeNull();
    expect(screen.queryByText(/so far/)).toBeNull();
    expect(screen.getByRole("button", { name: "Pause orch" })).toBeTruthy();
  });

  it("opens the alert's session by props from its name and its Open session link", async () => {
    const h = setup();
    await click(screen.getByText(/: Stuck/).querySelector("a"));
    expect(h.openSession).toHaveBeenCalledWith("greta");
    const links = [...screen.getAllByRole("link", { name: "Open session" })];
    await click(links[links.length - 1]);
    expect(h.openSession).toHaveBeenCalledWith("greta");
  });

  it("pauses through the pause op with the Radar why, then reloads sessions and attention", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Pause greta" }));
    expect(h.api.op).toHaveBeenCalledWith(CH, "pause", { target: "greta", why: "Radar: Stuck" });
    expect(h.toast).toHaveBeenCalledWith("greta paused", { undo: expect.any(Function) });
    expect(h.store.loadSessions).toHaveBeenCalled();
    expect(h.store.loadAttention).toHaveBeenCalled();
  });

  it("resumes again from the pause toast's undo", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Pause greta" }));
    const undo = h.toast.mock.calls.find(([t]) => t === "greta paused")?.[1]?.undo as () => void;
    await flush(undo);
    expect(h.api.op).toHaveBeenCalledWith(CH, "resume", { target: "greta" });
    expect(h.toast).toHaveBeenCalledWith("greta resumed", {});
  });

  it("bad toasts a refused pause and hands the button back", async () => {
    const h = setup();
    h.api.op = vi.fn(async () => {
      throw new Error("not now");
    });
    h.repaint();
    const pause = screen.getByRole("button", { name: "Pause greta" }) as HTMLButtonElement;
    await click(pause);
    expect(h.toast).toHaveBeenCalledWith("not now", { bad: true });
    expect(pause.disabled).toBe(false);
  });

  it("shows the Paused pill instead of the pause button when the session already sits paused", () => {
    setup(
      makeState({
        sessions: { sessions: [{ name: "greta", state: "idle", control: "pause" }] },
      }),
    );
    expect(document.querySelector(".badge-warning")?.textContent).toBe("Paused");
    expect(screen.queryByRole("button", { name: "Pause greta" })).toBeNull();
  });
});

describe("handled", () => {
  it("hides the handled card at once, then it leaves the list and focus moves to the card in its place", async () => {
    const h = setup(
      makeState({
        attention: {
          asks: [
            { seq: 11, from: "greta", msg: "first?" },
            { seq: 12, from: "paule", msg: "second?" },
          ],
        },
        extras: null,
      }),
    );
    // the reload is held back, so the hide is visible on its own before the list changes
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.store.loadAttention = vi.fn(async () => {
      await gate;
      h.state.attention = { asks: [{ seq: 12, from: "paule", msg: "second?" }] };
      h.repaint();
    });
    const first = screen.getByText("first?").closest("[data-item]") as HTMLElement;
    await click(first.querySelector("button"));
    expect(first.getAttribute("hidden")).not.toBeNull(); // hidden before the reload lands
    expect(screen.getByText("first?")).toBeTruthy();
    release();
    await flush(() => {});
    expect(screen.queryByText("first?")).toBeNull();
    expect(screen.getByText("second?")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Yes, go ahead");
    expect((document.activeElement as HTMLElement).closest("[data-item]")?.getAttribute("data-item")).toBe(
      "a12",
    );
  });

  it("moves focus to All clear when the list empties", async () => {
    const h = setup(
      makeState({ attention: { asks: [{ seq: 11, from: "greta", msg: "only?" }] }, extras: null }),
    );
    h.onReload(() => {
      h.state.attention = {};
      h.repaint();
    });
    await click(screen.getByRole("button", { name: "Yes, go ahead" }));
    expect(screen.getByText("All clear")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("All clear");
  });

  it("keeps the card when the action failed", async () => {
    const h = setup();
    h.api.op = vi.fn(async () => {
      throw new Error("no");
    });
    h.repaint();
    await click(screen.getByRole("button", { name: "Resume greta" }));
    expect(screen.getByText("greta is paused")).toBeTruthy();
  });

  it("starts a new channel clean", async () => {
    const h = setup();
    await click(screen.getByRole("button", { name: "Approve with a note" }));
    expect(screen.getByPlaceholderText("Note for greta")).toBeTruthy();
    const other = makeState({ ch: "other" });
    h.view.rerender(<Inbox {...h.props} state={other} ch="other" />);
    expect(screen.queryByPlaceholderText("Note for greta")).toBeNull();
  });
});

describe("pure helpers", () => {
  it("maps Radar's kinds and falls back to the raw kind", () => {
    expect(alertKind("stuck")).toBe("Stuck");
    expect(alertKind("retry_storm")).toBe("Retry storm");
    expect(alertKind("context")).toBe("Context filling up");
    expect(alertKind("weird")).toBe("weird");
    expect(ALERT_KIND.loop).toBe("Looping");
    expect(ALERT_KIND.budget).toBe("Budget");
  });

  it("counts and speaks the extras' needs only for the open channel", () => {
    expect(extrasNeeds(EXTRAS, CH)).toBe(2);
    expect(extrasNeeds(null, CH)).toBe(0);
    expect(extrasNeeds(EXTRAS, "other")).toBe(0);
    expect(extrasNeedsText(EXTRAS, CH)).toBe("1 permission request · 1 Radar alert");
    expect(extrasNeedsText({ ch: CH, approvals: [], obs: null }, CH)).toBe("");
    expect(
      extrasNeedsText(
        {
          ch: CH,
          approvals: [
            { seq: 1, from: "a" },
            { seq: 2, from: "b" },
          ],
          obs: null,
        },
        CH,
      ),
    ).toBe("2 permission requests");
  });

  it("counts the whole Inbox", () => {
    expect(inboxCountOf(makeState(), CH)).toBe(6);
    expect(inboxCountOf(makeState({ attention: null, extras: null }), CH)).toBe(0);
  });

  it("summarises with plurals", () => {
    expect(summaryOf(makeState(), CH)).toBe(
      "1 question · 1 approval · 1 paused · 1 blocked · 1 permission request · 1 Radar alert",
    );
    expect(
      summaryOf(
        makeState({
          attention: {
            asks: [
              { seq: 1, from: "a" },
              { seq: 2, from: "b" },
            ],
            gates: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
          },
          extras: null,
        }),
        CH,
      ),
    ).toBe("2 questions · 3 approvals");
  });

  it("offers the reassign list: the sessions that stayed, minus the current owner", () => {
    expect(reassignOwners(SESSIONS, "greta")).toEqual(["orch"]);
    expect(reassignOwners(SESSIONS, null)).toEqual(["greta", "orch"]);
    expect(reassignOwners(null, null)).toEqual([]);
  });
});

describe("shell hand-offs", () => {
  it("opens tasks by props from their links", async () => {
    const h = setup();
    await click(screen.getAllByText("t3")[0]);
    expect(h.openTask).toHaveBeenCalledWith("t3");
    await click(screen.getByText("Run the migration"));
    expect(h.openTask).toHaveBeenCalledWith("t2");
  });

  it("opens sessions by props from an approval's links", async () => {
    const h = setup();
    const cards = [...document.querySelectorAll("[data-item]")];
    const approval = cards.find((c) => c.getAttribute("data-item") === "x7") as HTMLElement;
    await click(approval.querySelectorAll("a")[0]);
    expect(h.openSession).toHaveBeenCalledWith("greta");
    const open = approval.querySelector('a[href="#/c/lab/inbox?s=greta"].btn');
    await click(open);
    expect(h.openSession).toHaveBeenCalledWith("greta");
  });
});

describe("an approval as the only thing", () => {
  it("leaves the badge count and sections consistent", () => {
    const ap: Approval = { seq: 7, from: "greta" };
    setup(makeState({ attention: {}, extras: { ch: CH, approvals: [ap], obs: null } }));
    expect(screen.getByText("Asked for your permission")).toBeTruthy();
    expect(screen.queryByText("Questions for you")).toBeNull();
  });
});
