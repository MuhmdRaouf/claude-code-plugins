import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import {
  Composer,
  type ComposerProps,
  composeTitle,
  effect,
  findReply,
  missingField,
  msgPlaceholder,
  recipientNames,
  sendIcon,
  sendLabel,
  toLabelOf,
} from "../../src/compose/Composer.tsx";
import { type ComposeOptions, createDrafts, type Draft } from "../../src/compose/drafts.ts";
import type { Storage } from "../../src/storage.ts";
import type { Board, FeedEvent, RosterSession, Timers } from "../../src/store.ts";

// ── fakes ────────────────────────────────────────────────────────────────────
const SESSIONS: RosterSession[] = [
  { name: "scan.agent", state: "working" },
  { name: "fix.agent", state: "idle" },
  { name: "gone.agent", state: "left" },
];

const BOARD: Board = {
  steps: [
    { id: "t1", title: "First", status: "todo" },
    { id: "t2", title: "Second", status: "doing", blocked_by: ["t1"] },
    { id: "t3", title: "Done one", status: "done" },
  ],
};

const byId = (id: string): (typeof BOARD.steps)[number] | null =>
  BOARD.steps.find((s) => s.id === id) ?? null;

const TIMELINE: FeedEvent[] = [
  { seq: 7, topic: "ask", from: "scan.agent", msg: "should I redeploy", ts: "2026-10-09T10:00:00Z" },
  { seq: 3, topic: "msg", from: "fix.agent", msg: "x".repeat(400), ts: "2026-10-09T09:00:00Z" },
];

const NOW = Date.parse("2026-10-09T10:00:10Z");

const memStorage = () => {
  const m = new Map<string, string>();
  const storage: Storage = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
  return { storage, m };
};

const manualTimers = () => {
  const jobs = new Map<number, () => void>();
  let seq = 0;
  const timers: Timers = {
    after: (fn) => {
      jobs.set(++seq, fn);
      return seq;
    },
    cancel: (h) => void jobs.delete(h as number),
    interval: () => 0,
    stop: () => {},
  };
  return {
    timers,
    run: () => {
      for (const fn of [...jobs.values()]) fn();
    },
  };
};

type OpMock = ReturnType<typeof vi.fn>;

/** The happy op: the server answered with a created task. */
const okOp = (): OpMock => vi.fn(async () => ({ result: { task: { id: "t9" } } }));

const fakeApi = (op: OpMock): Api =>
  ({ op: op as unknown as Api["op"], api: vi.fn(), channelPath: vi.fn(), channelHref: vi.fn() }) as Api;

/** Renders the composer over fakes; `over` replaces any prop. */
function setup(over: Partial<ComposerProps> = {}) {
  const store = memStorage();
  const t = manualTimers();
  const drafts = createDrafts(store.storage, t.timers);
  const op = okOp();
  const toast = vi.fn();
  const onSent = vi.fn();
  const props: ComposerProps = {
    ch: "lab",
    place: "dlg",
    sessions: SESSIONS,
    board: BOARD,
    byId,
    api: fakeApi(op),
    onSent,
    toast,
    drafts,
    ...over,
  };
  const view = render(<Composer {...props} />);
  return { ...view, op, toast, onSent, drafts, run: t.run, store };
}

// ── queries ──────────────────────────────────────────────────────────────────
const msgBox = (): HTMLTextAreaElement => screen.getByLabelText(/Message|Details/) as HTMLTextAreaElement;
const titleBox = (): HTMLInputElement => screen.getByLabelText(/Title/) as HTMLInputElement;
const toMenu = (): HTMLSelectElement => screen.getByLabelText("To") as HTMLSelectElement;
const sendBtn = (): HTMLButtonElement => document.getElementById("dlg-send") as HTMLButtonElement;
const fx = (): HTMLElement => document.getElementById("dlg-fx") as HTMLElement;
const terr = (): HTMLElement => document.getElementById("dlg-terr") as HTMLElement;
const type = (text: string): void => {
  fireEvent.input(msgBox(), { target: { value: text } });
};

// ── the pure wording helpers ─────────────────────────────────────────────────
describe("composer wording helpers", () => {
  const line = (d: Partial<Draft>): { text: string; bolds: string[] } => {
    const { container } = render(
      <span>
        {effect({
          to: "",
          mode: "msg",
          msg: "",
          title: "",
          after: [],
          about: [],
          phase: null,
          reply: null,
          ...d,
        })}
      </span>,
    );
    return {
      text: container.textContent ?? "",
      bolds: [...container.querySelectorAll("b")].map((b) => b.textContent ?? ""),
    };
  };

  it("effect: a message is read at the next inbox check", () => {
    expect(line({}).text).toBe("Every session reads it at the next check of the inbox.");
    expect(line({}).bolds).toStrictEqual([]);
    expect(line({ to: "scan.agent" }).text).toBe("scan.agent reads it at the next check of the inbox.");
    expect(line({ to: "scan.agent" }).bolds).toStrictEqual(["scan.agent"]);
    expect(line({ to: "owner" }).bolds).toStrictEqual(["You"]);
  });

  it("effect: an ask must be answered and wakes the reader until it is", () => {
    expect(line({ mode: "ask" }).text).toBe(
      "Every session must answer: it waits in their inbox and wakes them until they reply.",
    );
    expect(line({ mode: "ask", to: "fix.agent" }).text).toBe(
      "fix.agent must answer: it waits in their inbox and wakes them until they reply.",
    );
    expect(line({ mode: "ask", to: "owner" }).bolds).toStrictEqual(["You"]);
  });

  it("effect: a task tells who owns it and what it waits on", () => {
    expect(line({ mode: "task" }).text).toBe("Creates a task that nobody owns yet.");
    expect(line({ mode: "task", to: "scan.agent" }).text).toBe("Creates a task for scan.agent.");
    expect(line({ mode: "task", to: "scan.agent" }).bolds).toStrictEqual(["scan.agent"]);
    expect(line({ mode: "task", after: ["t1", "t2"] }).text).toBe(
      "Creates a task that nobody owns yet. It waits on t1, t2, and its owner is woken when they are done.",
    );
    expect(line({ mode: "task", to: "scan.agent", after: ["t1"] }).text).toBe(
      "Creates a task for scan.agent. It waits on t1, and scan.agent is woken when they are done.",
    );
    expect(line({ mode: "task", to: "scan.agent", after: ["t1"] }).bolds).toStrictEqual([
      "scan.agent",
      "t1",
      "scan.agent",
    ]);
  });

  it("composeTitle speaks each kind, and the reply names its author", () => {
    expect(composeTitle("msg", null)).toBe("Send a message");
    expect(composeTitle("ask", null)).toBe("Ask a question");
    expect(composeTitle("task", null)).toBe("New task");
    expect(composeTitle("msg", TIMELINE[0] ?? null)).toBe("Reply to scan.agent");
  });

  it("msgPlaceholder asks for the right thing per kind and reply", () => {
    const d: Draft = {
      to: "",
      mode: "msg",
      msg: "",
      title: "",
      after: [],
      about: [],
      phase: null,
      reply: null,
    };
    expect(msgPlaceholder(d, null)).toBe("Tell everyone what to do, decide or check");
    expect(msgPlaceholder({ ...d, to: "scan.agent" }, null)).toBe(
      "Tell scan.agent what to do, decide or check",
    );
    expect(msgPlaceholder({ ...d, to: "owner" }, null)).toBe("Tell You what to do, decide or check");
    expect(msgPlaceholder({ ...d, mode: "ask" }, null)).toBe("Ask everyone something they must answer");
    expect(msgPlaceholder({ ...d, mode: "task" }, null)).toBe("What done means, where to look");
    expect(msgPlaceholder(d, TIMELINE[0] ?? null)).toBe("Answer scan.agent");
  });

  it("sendLabel and sendIcon follow the kind, the recipient and the reply", () => {
    const d: Draft = {
      to: "",
      mode: "msg",
      msg: "",
      title: "",
      after: [],
      about: [],
      phase: null,
      reply: null,
    };
    expect(sendLabel(d, null)).toBe("Send to everyone");
    expect(sendLabel({ ...d, to: "scan.agent" }, null)).toBe("Send to scan.agent");
    expect(sendLabel({ ...d, mode: "ask" }, null)).toBe("Ask everyone");
    expect(sendLabel({ ...d, mode: "task" }, null)).toBe("Create task");
    expect(sendLabel({ ...d, mode: "task", reply: 7 }, TIMELINE[0] ?? null)).toBe("Send reply");
    expect(sendIcon(d, null)).toBe("send");
    expect(sendIcon({ ...d, mode: "task" }, null)).toBe("plus");
    expect(sendIcon({ ...d, mode: "task", reply: 7 }, TIMELINE[0] ?? null)).toBe("send");
  });

  it("toLabelOf names the owner You", () => {
    const d: Draft = {
      to: "",
      mode: "msg",
      msg: "",
      title: "",
      after: [],
      about: [],
      phase: null,
      reply: null,
    };
    expect(toLabelOf(d)).toBe("everyone");
    expect(toLabelOf({ ...d, to: "owner" })).toBe("You");
  });

  it("missingField asks for the message, or the title of a task", () => {
    const d: Draft = {
      to: "",
      mode: "msg",
      msg: "",
      title: "",
      after: [],
      about: [],
      phase: null,
      reply: null,
    };
    expect(missingField(d, "")).toBe("msg");
    expect(missingField(d, "words")).toBeNull();
    expect(missingField({ ...d, reply: 7 }, "")).toBe("msg");
    expect(missingField({ ...d, reply: 7 }, "words")).toBeNull();
    expect(missingField({ ...d, mode: "task" }, "")).toBe("title");
    expect(missingField({ ...d, mode: "task", title: "  " }, "")).toBe("title");
    expect(missingField({ ...d, mode: "task", title: "Named" }, "")).toBeNull();
    expect(missingField({ ...d, mode: "task", title: "Named" }, "details")).toBeNull();
  });

  it("recipientNames offers the roster minus who left, plus an unknown recipient once", () => {
    expect(recipientNames(SESSIONS, "")).toStrictEqual(["scan.agent", "fix.agent"]);
    expect(recipientNames(SESSIONS, "fix.agent")).toStrictEqual(["scan.agent", "fix.agent"]);
    expect(recipientNames(SESSIONS, "gone.agent")).toStrictEqual(["scan.agent", "fix.agent", "gone.agent"]);
  });

  it("findReply finds the event a reply answers, or nothing", () => {
    expect(findReply(TIMELINE, 7)?.from).toBe("scan.agent");
    expect(findReply(TIMELINE, 99)).toBeNull();
    expect(findReply(TIMELINE, null)).toBeNull();
    expect(findReply(null, 7)).toBeNull();
    expect(findReply(undefined, 7)).toBeNull();
  });
});

// ── what the composer shows ──────────────────────────────────────────────────
describe("Composer render", () => {
  it("opens on everyone with a plain message", () => {
    setup();
    expect(toMenu().value).toBe("");
    expect([...toMenu().options].map((o) => o.textContent)).toStrictEqual([
      "Everyone",
      "scan.agent",
      "fix.agent",
    ]);
    expect(screen.getByRole("button", { name: "Message" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Question" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Task" }).getAttribute("aria-pressed")).toBe("false");
    expect(msgBox().placeholder).toBe("Tell everyone what to do, decide or check");
    expect(sendBtn().textContent).toContain("Send to everyone");
    expect(sendBtn().querySelector("svg")).toBeTruthy();
    expect(sendBtn().disabled).toBe(false);
    expect(fx().textContent).toBe("Every session reads it at the next check of the inbox.");
    expect(fx().classList.contains("muted")).toBe(true);
    expect(screen.getByText("About a task")).toBeTruthy();
    expect(screen.queryByLabelText(/Title/)).toBeNull();
    expect(terr()).toBeNull();
  });

  it("a fixed recipient hides the To menu and words everything for them", () => {
    setup({ to: "scan.agent", now: NOW });
    expect(screen.queryByLabelText("To")).toBeNull();
    expect(msgBox().placeholder).toBe("Tell scan.agent what to do, decide or check");
    expect(sendBtn().textContent).toContain("Send to scan.agent");
    expect(fx().querySelector("b")?.textContent).toBe("scan.agent");
  });

  it("task mode adds the title, its error, the waits-on picker and the task wording", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    expect(titleBox().placeholder).toBe("What should everyone finish?");
    expect(titleBox().getAttribute("aria-describedby")).toBe("dlg-terr");
    expect(msgBox().placeholder).toBe("What done means, where to look");
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.queryByText("About a task")).toBeNull();
    expect(screen.getByLabelText("Tasks it waits on")).toBeTruthy();
    expect(screen.getByText("Waits on")).toBeTruthy();
    expect(sendBtn().textContent).toContain("Create task");
    expect(terr().hidden).toBe(true);
    expect(fx().textContent).toBe("Creates a task that nobody owns yet.");
  });

  it("ask mode words the box as a question that must be answered", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Question" }));
    expect(msgBox().placeholder).toBe("Ask everyone something they must answer");
    expect(sendBtn().textContent).toContain("Ask everyone");
    expect(screen.getByText("About a task")).toBeTruthy();
    expect(screen.queryByLabelText(/Title/)).toBeNull();
    expect(fx().textContent).toBe(
      "Every session must answer: it waits in their inbox and wakes them until they reply.",
    );
  });

  it("picking a recipient re-words the box, the button and the effect line", () => {
    setup();
    fireEvent.change(toMenu(), { target: { value: "scan.agent" } });
    expect(toMenu().value).toBe("scan.agent");
    expect(msgBox().placeholder).toBe("Tell scan.agent what to do, decide or check");
    expect(sendBtn().textContent).toContain("Send to scan.agent");
    expect(fx().querySelector("b")?.textContent).toBe("scan.agent");
    fireEvent.change(toMenu(), { target: { value: "" } });
    expect(fx().textContent).toBe("Every session reads it at the next check of the inbox.");
  });

  it("in a dialog it shows four message rows and a Cancel button, outside it three and none", () => {
    const onCancel = vi.fn();
    setup({ dialog: true, onCancel });
    expect(msgBox().getAttribute("rows")).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("outside a dialog the message box keeps three rows", () => {
    setup();
    expect(msgBox().getAttribute("rows")).toBe("3");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("names the composer's ids after its place", () => {
    setup({ place: "s:scan.agent" });
    expect(document.getElementById("s_scan_agent-send")).toBeTruthy();
    expect(document.getElementById("s_scan_agent-fx")).toBeTruthy();
  });
});

// ── drafts ───────────────────────────────────────────────────────────────────
describe("Composer drafts", () => {
  it("keeps the message in the draft and lands it in storage after the debounce", () => {
    const { run, store, drafts } = setup();
    type("hello there");
    expect(drafts.draft("lab", "dlg").msg).toBe("hello there");
    expect(store.m.has("huddle:draft:lab:dlg")).toBe(false);
    run();
    expect(JSON.parse(store.m.get("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "hello there" });
  });

  it("restores a saved draft for its channel and place", () => {
    const store = memStorage();
    store.m.set(
      "huddle:draft:lab:dlg",
      JSON.stringify({ msg: "from last time", mode: "ask", to: "fix.agent" }),
    );
    const drafts = createDrafts(store.storage, manualTimers().timers);
    setup({ drafts });
    expect(msgBox().value).toBe("from last time");
    expect(toMenu().value).toBe("fix.agent");
    expect(screen.getByRole("button", { name: "Question" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Message" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("a draft belongs to one place: another place starts empty", () => {
    const store = memStorage();
    store.m.set("huddle:draft:lab:dlg", JSON.stringify({ msg: "dialog words" }));
    const drafts = createDrafts(store.storage, manualTimers().timers);
    setup({ drafts, place: "s:scan.agent" });
    expect(msgBox().value).toBe("");
    expect(drafts.draft("lab", "s:scan.agent").msg).toBe("");
  });

  it("writes a still-pending draft when the composer goes away", async () => {
    const { unmount, run, store } = setup();
    type("last words");
    expect(store.m.has("huddle:draft:lab:dlg")).toBe(false);
    unmount();
    // unmount cleanups run one tick out
    await new Promise((r) => setTimeout(r, 5));
    expect(store.m.has("huddle:draft:lab:dlg")).toBe(true);
    expect(JSON.parse(store.m.get("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "last words" });
    run(); // the pending save was flushed, not left behind
    expect(JSON.parse(store.m.get("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({ msg: "last words" });
  });

  it("persists through the page's own draft store when none is injected", () => {
    const store = memStorage();
    const t = manualTimers();
    render(
      <Composer
        ch="lab"
        place="dlg"
        sessions={SESSIONS}
        board={BOARD}
        byId={byId}
        api={fakeApi(okOp())}
        onSent={() => {}}
        toast={() => {}}
        storage={store.storage}
        timers={t.timers}
      />,
    );
    type("through the fallback");
    t.run();
    expect(JSON.parse(store.m.get("huddle:draft:lab:dlg") ?? "{}")).toMatchObject({
      msg: "through the fallback",
    });
  });
});

// ── sending ──────────────────────────────────────────────────────────────────
describe("Composer sends", () => {
  it("sends a message to everyone and clears the draft", async () => {
    const { op, toast, onSent } = setup();
    type("check the board");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "send", { msg: "check the board" });
    expect(toast).toHaveBeenCalledWith("Sent to everyone");
    expect(onSent).toHaveBeenCalledWith("send");
    expect(msgBox().value).toBe("");
    expect(screen.getByRole("button", { name: "Message" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("treats an op answer without a result wrapper as success", async () => {
    const op = vi.fn(async () => ({}));
    const { toast, onSent } = setup({ api: fakeApi(op) });
    type("plain answer");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Sent to everyone");
    expect(onSent).toHaveBeenCalledWith("send");
    expect(msgBox().value).toBe("");
  });

  it("sends a message to the chosen session", async () => {
    const { op, toast } = setup();
    fireEvent.change(toMenu(), { target: { value: "scan.agent" } });
    type("look at this");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "send", { to: "scan.agent", msg: "look at this" });
    expect(toast).toHaveBeenCalledWith("Sent to scan.agent");
  });

  it("sends a question with ask set, and words the toast as an ask", async () => {
    const { op, toast } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Question" }));
    fireEvent.change(toMenu(), { target: { value: "fix.agent" } });
    type("is the build green?");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "send", {
      to: "fix.agent",
      msg: "is the build green?",
      ask: true,
    });
    expect(toast).toHaveBeenCalledWith("Asked fix.agent");
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("Sent to"), expect.anything());
  });

  it("asks everyone when no recipient is chosen", async () => {
    const { toast } = setup({ initial: { mode: "ask" } });
    type("anyone?");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Asked everyone"));
  });

  it("links the task the message is about", async () => {
    const { op } = setup();
    type("see this one");
    fireEvent.focus(screen.getByLabelText("Task it is about"));
    fireEvent.mouseDown(document.getElementById("dlg-about-o0") as Element);
    expect(screen.getByRole("button", { name: "Remove t1" })).toBeTruthy();
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "send", { msg: "see this one", task: "t1" });
  });

  it("creates a task with its owner, waits-on and details, and toasts the creation", async () => {
    const { op, toast, onSent } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    fireEvent.change(toMenu(), { target: { value: "scan.agent" } });
    fireEvent.input(titleBox(), { target: { value: "Fix the flake" } });
    type("green run twice");
    fireEvent.focus(screen.getByLabelText("Tasks it waits on"));
    fireEvent.mouseDown(document.getElementById("dlg-after-o0") as Element);
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "task_create", {
      title: "Fix the flake",
      owner: "scan.agent",
      after: ["t1"],
      what: "green run twice",
    });
    expect(toast).toHaveBeenCalledWith("Created t9 for scan.agent. It starts after t1.");
    expect(onSent).toHaveBeenCalledWith("task_create");
    expect(titleBox().value).toBe("");
    expect(fx().textContent).toBe("Creates a task for scan.agent.");
  });

  it("creates an unowned task without details when none are given", async () => {
    const { op, toast } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    fireEvent.input(titleBox(), { target: { value: "Sweep" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "task_create", { title: "Sweep", after: [] });
    expect(toast).toHaveBeenCalledWith("Created t9.");
  });

  it("carries the phase the caller pinned onto the new task", async () => {
    const { op } = setup({ initial: { mode: "task", phase: 2 } });
    fireEvent.input(titleBox(), { target: { value: "Phased" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "task_create", { title: "Phased", phase: 2, after: [] });
  });

  it("sends a reply to the ask it answers", async () => {
    const { op, toast, onSent } = setup({ initial: { reply: 7 }, timeline: TIMELINE, now: NOW });
    expect(screen.queryByLabelText("To")).toBeNull();
    expect(document.querySelector(".text-sm b")?.textContent).toBe("scan.agent");
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-09T10:00:00Z");
    expect(screen.getByText(/Cancel reply/)).toBeTruthy();
    expect(msgBox().placeholder).toBe("Answer scan.agent");
    expect(fx().textContent).toBe("scan.agent gets it as the answer, and the question closes.");
    expect(sendBtn().textContent).toContain("Send reply");
    type("on it");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(op).toHaveBeenCalled());
    expect(op).toHaveBeenCalledWith("lab", "reply", { seq: 7, msg: "on it" });
    expect(toast).toHaveBeenCalledWith("Reply sent");
    expect(onSent).toHaveBeenCalledWith("reply");
    expect(msgBox().value).toBe("");
  });

  it("cancels a reply back into a plain composer", () => {
    const { op, drafts } = setup({ initial: { reply: 7 }, timeline: TIMELINE });
    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(screen.getByLabelText("To")).toBeTruthy();
    expect(sendBtn().textContent).toContain("Send to everyone");
    expect(drafts.draft("lab", "dlg").reply).toBeNull();
    expect(fx().textContent).toBe("Every session reads it at the next check of the inbox.");
    type("plain again");
    fireEvent.click(sendBtn());
    expect(op).toHaveBeenCalled();
  });

  it("drops a reply the timeline no longer carries", async () => {
    const { drafts } = setup({ initial: { reply: 99 }, timeline: TIMELINE });
    await waitFor(() => expect(drafts.draft("lab", "dlg").reply).toBeNull());
    expect(screen.queryByText(/Cancel reply/)).toBeNull();
    expect(screen.getByLabelText("To")).toBeTruthy();
  });

  it("keeps composing the reply while the timeline has not loaded", () => {
    const { op, drafts } = setup({ initial: { reply: 7 } });
    // without the timeline the reply's event is unknown, so the body reads as a plain composer
    expect(sendBtn().textContent).toContain("Send to everyone");
    expect(drafts.draft("lab", "dlg").reply).toBe(7);
    type("still a reply");
    fireEvent.click(sendBtn());
    expect(op).toHaveBeenCalledWith("lab", "reply", { seq: 7, msg: "still a reply" });
  });

  it("closes the dialog through onCancel after a send", async () => {
    const onCancel = vi.fn();
    const { onSent } = setup({ dialog: true, onCancel });
    type("done");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onSent).toHaveBeenCalledWith("send");
  });

  it("disables the send while the op is in flight and re-enables it after", async () => {
    let release: (v: unknown) => void = () => {};
    const op = vi.fn(
      (_ch: string, _name: string, _args?: Record<string, unknown>) =>
        new Promise((res) => {
          release = res;
        }),
    );
    setup({ api: fakeApi(op) });
    type("slow one");
    fireEvent.click(sendBtn());
    expect(sendBtn().disabled).toBe(true);
    release({ result: true });
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    expect(op).toHaveBeenCalledTimes(1);
  });
});

// ── validation and failures ──────────────────────────────────────────────────
describe("Composer validation and failures", () => {
  it("refuses an empty message without an op and focuses the box", () => {
    const { op, toast, onSent } = setup();
    fireEvent.click(sendBtn());
    expect(op).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(msgBox());
  });

  it("refuses a task without a title: focus, aria-invalid and the error line", () => {
    const { op } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    fireEvent.click(sendBtn());
    expect(op).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(titleBox());
    expect(titleBox().getAttribute("aria-invalid")).toBe("true");
    expect(terr().hidden).toBe(false);
    expect(terr().textContent).toContain("A task needs a title.");
    fireEvent.input(titleBox(), { target: { value: "Now named" } });
    expect(titleBox().getAttribute("aria-invalid")).toBeNull();
    expect(terr().hidden).toBe(true);
  });

  it("refuses an empty reply and focuses the box", () => {
    const { op } = setup({ initial: { reply: 7 }, timeline: TIMELINE });
    fireEvent.click(sendBtn());
    expect(op).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(msgBox());
  });

  it("toasts the server's refusal, keeps the draft and re-enables the send", async () => {
    const op = vi.fn(async () => {
      throw Object.assign(new Error("waits on t2"), { status: 409 });
    });
    const { toast, onSent } = setup({ api: fakeApi(op) });
    type("still here");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("waits on t2", { bad: true }));
    expect(onSent).not.toHaveBeenCalled();
    expect(msgBox().value).toBe("still here");
    expect(sendBtn().disabled).toBe(false);
  });

  it("explains an op this server does not know", async () => {
    const op = vi.fn(async () => {
      throw Object.assign(new Error("no operation: task_create"), { status: 404 });
    });
    const { toast } = setup({ api: fakeApi(op), initial: { mode: "task" } });
    fireEvent.input(titleBox(), { target: { value: "Named" } });
    fireEvent.click(sendBtn());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining("does not support “task_create” yet"), {
        bad: true,
      }),
    );
  });

  it("toasts whatever the op threw, even when it is not an Error", async () => {
    const op = vi.fn(async () => {
      throw "upstream is down";
    });
    const { toast } = setup({ api: fakeApi(op) });
    type("words");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("upstream is down", { bad: true }));
  });
});

// ── keyboard and host wiring ─────────────────────────────────────────────────
describe("Composer keyboard and wiring", () => {
  it("⌘Enter sends from the message box, plain Enter does not", async () => {
    const { op } = setup();
    type("quick one");
    fireEvent.keyDown(msgBox(), { key: "Enter" });
    expect(op).not.toHaveBeenCalled();
    fireEvent.keyDown(msgBox(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(op).toHaveBeenCalledWith("lab", "send", { msg: "quick one" }));
  });

  it("Ctrl+Enter sends too", async () => {
    const { op } = setup();
    type("ctrl one");
    fireEvent.keyDown(msgBox(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(op).toHaveBeenCalledWith("lab", "send", { msg: "ctrl one" }));
  });

  it("tells the host about the draft after every repaint it makes", () => {
    let latest: Draft | undefined;
    const onDraft = vi.fn((d: Draft) => {
      latest = d;
    });
    setup({ onDraft });
    expect(onDraft).toHaveBeenCalled();
    const before = onDraft.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    expect(onDraft.mock.calls.length).toBeGreaterThan(before);
    expect(latest?.mode).toBe("task");
  });

  it("applies the caller's options when they change while mounted", () => {
    function Harness(): JSX.Element {
      const [opts, setOpts] = useState<ComposeOptions | undefined>({ mode: "msg" });
      return (
        <>
          <Composer
            ch="lab"
            place="dlg"
            sessions={SESSIONS}
            board={BOARD}
            byId={byId}
            api={fakeApi(okOp())}
            onSent={() => {}}
            toast={() => {}}
            initial={opts}
          />
          <button type="button" onClick={() => setOpts({ mode: "task", to: "fix.agent" })}>
            to task
          </button>
        </>
      );
    }
    render(<Harness />);
    expect(screen.queryByLabelText(/Title/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "to task" }));
    expect(screen.getByLabelText(/Title/)).toBeTruthy();
    expect(titleBox().placeholder).toBe("What should fix.agent finish?");
    expect(sendBtn().textContent).toContain("Create task");
  });

  it("preselects the recipient and the about task from the options", () => {
    setup({ initial: { to: "fix.agent", about: "t2" } });
    expect(toMenu().value).toBe("fix.agent");
    expect(screen.getByRole("button", { name: "Remove t2" })).toBeTruthy();
    expect(fx().querySelector("b")?.textContent).toBe("fix.agent");
  });

  it("restores waits-on chips from the draft and shows them in the effect line", () => {
    setup({ initial: { mode: "task", after: ["t1", "t2"] } });
    expect(screen.getByRole("button", { name: "Remove t1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove t2" })).toBeTruthy();
    expect(fx().textContent).toBe(
      "Creates a task that nobody owns yet. It waits on t1, t2, and its owner is woken when they are done.",
    );
  });

  it("removing a waits-on chip repaints the effect line", () => {
    setup({ initial: { mode: "task", after: ["t1"] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove t1" }));
    expect(fx().textContent).toBe("Creates a task that nobody owns yet.");
    expect(screen.queryByRole("button", { name: "Remove t1" })).toBeNull();
  });

  it("shows a chip for a task the board no longer knows as missing", () => {
    const chip = (): HTMLElement =>
      screen.getByRole("button", { name: "Remove zz" }).closest(".badge") as HTMLElement;
    setup({ initial: { mode: "task", after: ["zz"] } });
    expect(chip().getAttribute("title")).toBe("No such task");
    expect(chip().textContent).toContain("missing");
    expect(fx().textContent).toBe(
      "Creates a task that nobody owns yet. It waits on zz, and its owner is woken when they are done.",
    );
  });

  it("ranks an empty board: the pickers open on nothing", () => {
    setup({ board: null, initial: { mode: "task" } });
    fireEvent.focus(screen.getByLabelText("Tasks it waits on"));
    expect(document.getElementById("dlg-after-menu")?.textContent).toContain("No open tasks.");
  });

  it("accepts a board step without a title or status", () => {
    const lean: Board = { steps: [{ id: "t9" }] };
    setup({
      board: lean,
      byId: (id) => lean.steps.find((s) => s.id === id) ?? null,
      initial: { mode: "task", after: ["t9"] },
    });
    const chip = screen.getByRole("button", { name: "Remove t9" }).closest(".badge") as HTMLElement;
    expect(chip.textContent).toContain("t9");
    expect(fx().textContent).toContain("It waits on t9");
  });

  it("stamps a reply's event with the relative time it was given", () => {
    setup({ initial: { reply: 7 }, timeline: TIMELINE, now: NOW });
    expect(document.querySelector("time")?.textContent).toBe("just now");
  });

  it("still quotes a reply whose event has no words and no time was given", () => {
    const mute: FeedEvent[] = [{ seq: 8, topic: "ask", from: "fix.agent" }];
    setup({ initial: { reply: 8 }, timeline: mute });
    expect(screen.getByText(/Cancel reply/)).toBeTruthy();
    expect(document.querySelector(".line-clamp-2")?.textContent).toBe("");
  });

  it("truncates the replied-to message at 300 characters", () => {
    setup({ initial: { reply: 3 }, timeline: TIMELINE });
    const quote = document.querySelector(".line-clamp-2");
    expect((quote?.textContent ?? "").length).toBe(300);
  });
});
