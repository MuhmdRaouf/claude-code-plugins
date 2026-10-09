import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { FeedEvent, PlanStep } from "../../src/store.ts";
import {
  bkey,
  canReply,
  EventRow,
  feedTint,
  groups,
  pass,
  Timeline,
  type TimelineProps,
  taskOf,
} from "../../src/team/Timeline.tsx";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const board = new Map<string, PlanStep>([
  ["t1", { id: "t1", title: "Ship it", status: "doing" }],
  ["t2", { id: "t2", title: "Park it", status: "done" }],
  ["t0", { id: "t0", title: "No status yet" }],
]);
const taskById = (id: string): PlanStep | null => board.get(id) ?? null;

/** One feed event: sent by alpha just now, with the fields the test names. */
const ev = (seq: number, topic: string, extra: Record<string, unknown> = {}): FeedEvent =>
  ({ seq, topic, from: "alpha", ts: "2026-10-08T11:59:00Z", ...extra }) as FeedEvent;

/** The Team feed with the given events, unfiltered and without replies by default. */
const feed = (events: FeedEvent[], over: Partial<TimelineProps> = {}) =>
  render(
    <Timeline
      events={events}
      replies={new Map()}
      now={NOW}
      filter={{ family: "all", session: "" }}
      taskById={taskById}
      {...over}
    />,
  );

/** The row of seq `n`, or a failure. */
const rowOf = (container: Element, n: number): HTMLElement => {
  const el = container.querySelector(`[data-seq="${n}"]`);
  if (!el) throw new Error(`no row ${n}`);
  return el as HTMLElement;
};

describe("pass", () => {
  const e = ev(1, "turn.pass", { from: "alpha", to: "beta" });
  it("keeps everything under the default filters", () => {
    expect(pass(e, { family: "all", session: "" })).toBe(true);
  });
  it("keeps a family's own topics", () => {
    expect(pass(ev(1, "task.status"), { family: "task", session: "" })).toBe(true);
    expect(pass(ev(1, "msg"), { family: "task", session: "" })).toBe(false);
    expect(pass(ev(1, "kb.added"), { family: "msg", session: "" })).toBe(false);
    expect(pass(ev(1, "ask"), { family: "msg", session: "" })).toBe(true);
    expect(pass(ev(1, "session.left"), { family: "session", session: "" })).toBe(true);
    expect(pass(ev(1, "session.left"), { family: "kb", session: "" })).toBe(false);
  });
  it("makes 'Pause and turn' keep the turn's events too", () => {
    const f = { family: "control", session: "" };
    expect(pass(ev(1, "control.pause"), f)).toBe(true);
    expect(pass(e, f)).toBe(true);
    expect(pass(ev(1, "task.status"), f)).toBe(false);
  });
  it("keeps what a session sent, received, or its subagents sent", () => {
    const f = { family: "all", session: "alpha" };
    expect(pass(ev(1, "msg", { from: "alpha" }), f)).toBe(true);
    expect(pass(ev(1, "msg", { from: "beta", to: "alpha" }), f)).toBe(true);
    expect(pass(ev(1, "msg", { from: "alpha.one" }), f)).toBe(true);
    expect(pass(ev(1, "msg", { from: "beta", to: "alpha.one" }), f)).toBe(true);
    expect(pass(ev(1, "msg", { from: "beta", to: "gamma" }), f)).toBe(false);
  });
  it("keeps its ground when an event carries no sender or addressee", () => {
    const f = { family: "all", session: "alpha" };
    expect(pass(ev(1, "msg", { from: "beta", to: undefined }), f)).toBe(false);
    expect(pass(ev(1, "msg", { from: undefined }), f)).toBe(false);
  });
});

describe("bkey", () => {
  it("keys the burstable updates by sender and family, and never the asks", () => {
    expect(bkey(ev(1, "task.status"))).toBe("alpha|task");
    expect(bkey(ev(1, "task.created", { to: "beta" }))).toBe("alpha|task");
    expect(bkey(ev(1, "kb.added"))).toBe("alpha|kb");
    expect(bkey(ev(1, "msg"))).toBe("");
    expect(bkey(ev(1, "task.status", { needs_reply: true }))).toBe("");
    expect(bkey(ev(1, "session.joined"))).toBe("");
  });
});

describe("groups", () => {
  it("folds consecutive events with the same key, leaves the rest alone", () => {
    const g = groups([
      ev(1, "task.status"),
      ev(2, "task.status"),
      ev(3, "msg"),
      ev(4, "task.status", { from: "beta" }),
      ev(5, "task.status"),
    ]);
    expect(g.map((x) => x.k)).toEqual(["alpha|task", "", "beta|task", "alpha|task"]);
    expect(g[0]?.evs.map((e) => e.seq)).toEqual([1, 2]);
    expect(g[1]?.evs.map((e) => e.seq)).toEqual([3]);
  });
});

describe("taskOf", () => {
  it("reads the id in the data, or the ref when the ref is a task", () => {
    expect(taskOf(ev(1, "note", { data: { task: "t1" } }), taskById)).toBe("t1");
    expect(taskOf(ev(1, "note", { ref: "t1" }), taskById)).toBe("t1");
    expect(taskOf(ev(1, "task.status", { ref: "tX" }), taskById)).toBe("tX");
    expect(taskOf(ev(1, "note", { ref: "kb:7" }), taskById)).toBeNull();
    expect(taskOf(ev(1, "note"), taskById)).toBeNull();
  });
});

describe("canReply", () => {
  const none = new Map<number, string[]>();
  it("is for events that address the owner and are still unanswered", () => {
    expect(canReply(ev(1, "ask", { to: "owner" }), none)).toBe(true);
    expect(canReply(ev(1, "kb.added", { needs_reply: true }), none)).toBe(true);
    expect(canReply(ev(1, "ask", { to: "beta" }), none)).toBe(false);
    expect(canReply(ev(1, "ask", { from: "owner", to: "beta" }), none)).toBe(false);
    expect(canReply(ev(1, "reply", { to: "owner" }), none)).toBe(false);
    expect(canReply(ev(1, "ask", { to: "owner" }), new Map([[1, ["owner"]]]))).toBe(false);
  });
});

describe("feedTint", () => {
  it("tints task rows by status, and every other family by its own colour", () => {
    expect(feedTint(ev(1, "task.status", { data: { status: "done" } }), taskById)).toEqual([
      "c-good",
      "c-green",
    ]);
    expect(feedTint(ev(1, "task.status", { data: { status: "skipped" } }), taskById)).toEqual([
      "c-good",
      "c-green",
    ]);
    expect(feedTint(ev(1, "task.status", { data: { status: "blocked" } }), taskById)).toEqual([
      "c-red",
      "c-red",
    ]);
    expect(feedTint(ev(1, "task.status", { ref: "t1" }), taskById)).toEqual(["c-yellow", "c-yellow"]);
    expect(feedTint(ev(1, "task.status"), taskById)).toEqual(["c-yellow", "c-yellow"]);
    expect(feedTint(ev(1, "control.pause"), taskById)).toEqual(["c-red", "c-red"]);
    expect(feedTint(ev(1, "control.resume"), taskById)).toEqual(["c-mauve", "c-mauve"]);
    expect(feedTint(ev(1, "turn.pass"), taskById)).toEqual(["c-mauve", "c-mauve"]);
    expect(feedTint(ev(1, "kb.added"), taskById)).toEqual(["c-lavender", "c-lavender"]);
    expect(feedTint(ev(1, "msg"), taskById)).toEqual(["c-blue", "c-blue"]);
    expect(feedTint(ev(1, "weird.topic"), taskById)).toEqual(["c-blue", "c-idle"]);
  });
});

describe("Timeline", () => {
  it("renders each family's row with its tint, its ink and its verb", () => {
    const { container } = feed([
      ev(1, "task.status", { data: { task: "t1", status: "done" }, msg: "t1 · wrapped up" }),
      ev(2, "task.status", { data: { task: "t1", status: "blocked" } }),
      ev(3, "task.status", { ref: "t1" }),
      ev(4, "task.status", { ref: "tX" }),
      ev(5, "kb.added", { ref: "kb:7", msg: "[note] Redis is up" }),
      ev(6, "msg"),
      ev(7, "turn.pass", { to: "beta" }),
      ev(8, "control.pause", { to: "beta" }),
      ev(9, "control.resume", { to: "beta" }),
      ev(10, "weird.topic", { msg: "something odd" }),
      ev(11, "session.joined", { from: "beta" }),
      ev(12, "reply", { from: "owner", to: "alpha" }),
      ev(13, "task.assigned", { ref: "t1", data: { owner: "beta" } }),
      ev(14, "task.status", { ref: "t1", data: { status: 7 } }),
      ev(15, "weird.topic", { from: undefined, msg: "from nobody" }),
    ]);
    const icon = (n: number): string | undefined =>
      rowOf(container, n).querySelector(".feed-icon")?.className;
    expect(icon(1)).toContain("c-good");
    expect(rowOf(container, 1).querySelector("b")?.className).toContain("c-green");
    expect(rowOf(container, 1).textContent).toContain("finished t1");
    expect(rowOf(container, 1).textContent).toContain("wrapped up");
    expect(rowOf(container, 1).querySelector(".prose-h")?.className).toContain("muted");
    expect(icon(2)).toContain("c-red");
    expect(rowOf(container, 2).textContent).toContain("is blocked on t1");
    expect(icon(3)).toContain("c-yellow");
    expect(rowOf(container, 3).textContent).toContain("moved t1");
    expect(icon(4)).toContain("c-yellow");
    expect(icon(5)).toContain("c-lavender");
    expect(rowOf(container, 5).textContent).toContain("remembered");
    expect(rowOf(container, 5).textContent).toContain("Redis is up");
    expect(icon(6)).toContain("c-blue");
    expect(rowOf(container, 6).textContent).toContain("told everyone");
    expect(icon(7)).toContain("c-mauve");
    expect(icon(8)).toContain("c-red");
    expect(rowOf(container, 8).textContent).toContain("paused beta");
    expect(icon(9)).toContain("c-mauve");
    expect(icon(10)).toContain("c-blue");
    expect(rowOf(container, 10).textContent).toContain("something odd");
    expect(icon(11)).toContain("c-blue");
    expect(rowOf(container, 12).className).toContain("mine");
    expect(rowOf(container, 12).textContent).toContain("You");
    expect(icon(13)).toContain("c-yellow");
    expect(rowOf(container, 13).querySelector(".prose-h")).toBeNull();
    expect(icon(14)).toContain("c-yellow");
    expect(rowOf(container, 15).querySelector("b")?.textContent).toBe("");
    expect(rowOf(container, 15).textContent).toContain("from nobody");
    expect(rowOf(container, 5).querySelector('[title="kb.added #5"]')).not.toBeNull();
    expect(container.querySelector(".feed-row time")).not.toBeNull();
  });

  it("marks the rows that wait for the owner's reply", () => {
    const { container } = feed([ev(1, "ask", { to: "owner", needs_reply: true }), ev(2, "msg")]);
    expect(rowOf(container, 1).className).toContain("is-ask");
    expect(rowOf(container, 2).className).not.toContain("is-ask");
  });

  it("tags the task an event is about, and opens it", () => {
    const onOpenTask = vi.fn();
    const { container } = feed(
      [
        ev(1, "ask", { to: "owner", ref: "t1", needs_reply: true }),
        ev(2, "msg", { ref: "t1" }),
        ev(3, "task.created", { ref: "t1" }),
        ev(4, "session.joined", { ref: "kb:7" }),
        ev(5, "ask", { to: "owner", ref: "t2", needs_reply: true }),
        ev(6, "ask", { to: "owner", ref: "t0", needs_reply: true }),
      ],
      { onOpenTask },
    );
    const tag = rowOf(container, 1).querySelector(".feed-row button.badge");
    expect(tag?.textContent).toContain("t1");
    expect(tag?.querySelector('[title="Doing"]')).not.toBeNull();
    if (tag) fireEvent.click(tag);
    expect(onOpenTask).toHaveBeenCalledWith("t1");
    expect(rowOf(container, 2).querySelector(".feed-row button.badge")).toBeNull();
    expect(rowOf(container, 3).querySelector(".feed-row button.badge")).toBeNull();
    expect(rowOf(container, 4).querySelector(".feed-row button.badge")).toBeNull();
    expect(rowOf(container, 5).querySelector('[title="Done"]')).not.toBeNull();
    expect(rowOf(container, 6).querySelector('[title="To do"]')).not.toBeNull();
  });

  it("turns a verb's task id into a link when the board knows the task", () => {
    const onOpenTask = vi.fn();
    const { container } = feed([ev(1, "task.created", { ref: "t1" }), ev(2, "task.created", { ref: "tX" })], {
      onOpenTask,
    });
    const linked = rowOf(container, 1).querySelector("span[title] button");
    expect(linked?.textContent).toBe("t1");
    if (linked) fireEvent.click(linked);
    expect(onOpenTask).toHaveBeenCalledWith("t1");
    const plain = rowOf(container, 2).querySelector("span[title] b");
    expect(plain?.textContent).toBe("tX");
    expect(rowOf(container, 2).querySelector("button")).toBeNull();
  });

  it("links a remembered note when the wiring gives it a href", () => {
    const { container, unmount } = feed([ev(1, "kb.added", { ref: "kb:7", msg: "[note] Redis is up" })], {
      knowledgeHref: (n: string) => `#/c/ch/knowledge/${n}`,
    });
    const a = rowOf(container, 1).querySelector(".prose-h a");
    expect(a?.getAttribute("href")).toBe("#/c/ch/knowledge/7");
    expect(a?.textContent).toBe("Redis is up");
    expect(rowOf(container, 1).querySelector(".prose-h")?.className).not.toContain("muted");
    unmount();
    const bare = feed([ev(1, "kb.added", { ref: "kb:7", msg: "[note] Redis is up" })]);
    expect(bare.container.querySelector(".prose-h a")).toBeNull();
    expect(bare.container.querySelector(".prose-h")?.className).not.toContain("muted");
  });

  it("shows an ask waiting, and who answered it", () => {
    const { container, unmount } = feed([ev(5, "ask", { to: "owner", needs_reply: true })]);
    const pill = rowOf(container, 5).querySelector(".badge");
    expect(pill?.className).toContain("badge-warning");
    expect(pill?.textContent).toBe("Waiting for you");
    unmount();
    const waiting = feed([ev(5, "ask", { to: "beta", needs_reply: true })]);
    expect(waiting.container.querySelector(".badge")?.textContent).toBe("Waiting for beta");
    unmount();
    const anyone = feed([ev(5, "kb.added", { needs_reply: true })]);
    expect(anyone.container.querySelector(".badge")?.textContent).toBe("Waiting for anyone");
    unmount();
    const answered = feed([ev(5, "ask", { to: "owner", needs_reply: true })], {
      replies: new Map([[5, ["worker", "owner"]]]),
    });
    const done = answered.container.querySelector(".badge");
    expect(done?.className).toContain("badge-success");
    expect(done?.textContent).toBe("Answered by worker, You");
  });

  it("offers the owner a Reply until the owner has answered", () => {
    const onReply = vi.fn();
    const { container, unmount } = feed([ev(5, "ask", { to: "owner", needs_reply: true })], {
      onReply,
    });
    const reply = rowOf(container, 5).querySelector("button.btn");
    expect(reply?.textContent).toContain("Reply");
    if (reply) fireEvent.click(reply);
    expect(onReply).toHaveBeenCalledWith(5);
    unmount();
    const answered = feed([ev(5, "ask", { to: "owner", needs_reply: true })], {
      onReply,
      replies: new Map<number, string[]>([[5, ["owner"]]]),
    });
    expect(answered.container.querySelector("button.btn")).toBeNull();
  });

  it("drops the Reply button on the owner's own rows and on compact rows", () => {
    const { container } = render(
      <EventRow
        event={ev(5, "ask", { from: "owner", to: "beta", needs_reply: true })}
        replies={new Map()}
        now={NOW}
        taskById={taskById}
      />,
    );
    expect(container.querySelector("button.btn")).toBeNull();
  });

  it("drops the Reply button on compact rows", () => {
    const { container } = render(
      <EventRow
        event={ev(5, "ask", { to: "owner", needs_reply: true })}
        replies={new Map()}
        now={NOW}
        taskById={taskById}
        compact
      />,
    );
    expect(container.querySelector(".badge")).not.toBeNull();
    expect(container.querySelector("button.btn")).toBeNull();
  });

  it("folds a run of updates from one sender into a burst that opens", () => {
    const { container } = feed([
      ev(1, "task.status", { ref: "t1", data: { status: "done" } }),
      ev(2, "task.status", { ref: "t2", data: { status: "done" } }),
      ev(3, "task.status", { ref: "t3", data: { status: "done" } }),
    ]);
    const burst = container.querySelector<HTMLDetailsElement>("details.feed-burst");
    expect(burst?.getAttribute("data-first")).toBe("1");
    expect(burst?.getAttribute("data-bkey")).toBe("alpha|task");
    expect(burst?.getAttribute("data-seqs")).toBe("1,2,3");
    const summary = burst?.querySelector("summary");
    expect(summary?.textContent).toContain("alpha");
    expect(summary?.textContent).toContain("finished 3 tasks");
    expect(summary?.querySelector('[title="task.status"]')).not.toBeNull();
    expect(burst?.querySelector(".chev")).not.toBeNull();
    expect(burst?.open).toBe(false);
    if (summary) fireEvent.click(summary);
    expect(burst?.open).toBe(true);
    expect(burst?.querySelectorAll(".feed-row")).toHaveLength(3);
    expect(burst?.querySelector('[data-seq="2"]')).not.toBeNull();
  });

  it("previews a burst's tasks, and marks a long run", () => {
    const many = [1, 2, 3, 4, 5].map((n) => ev(n, "task.status", { ref: `t${n}`, data: { status: "done" } }));
    const { container } = feed(many);
    const prev = container.querySelector("details summary .truncate");
    expect(prev?.textContent).toBe("t1, t2, t3, t4…");
  });

  it("previews a burst whose events name no task as empty", () => {
    const { container } = feed([
      ev(1, "task.status", { ref: undefined, data: { status: "done" } }),
      ev(2, "task.status", { ref: undefined, data: { status: "done" } }),
    ]);
    expect(container.querySelector("details summary .truncate")?.textContent).toBe("");
  });

  it("names nobody on a burst of events without a sender", () => {
    const { container } = feed([
      ev(1, "task.status", { from: undefined, ref: "t1", data: { status: "done" } }),
      ev(2, "task.status", { from: undefined, ref: "t2", data: { status: "done" } }),
    ]);
    const summary = container.querySelector("details summary");
    expect(summary?.querySelector(".avatar")?.textContent).toBe("");
    expect(summary?.querySelector("b")?.textContent).toBe("");
    expect(summary?.textContent).toContain("finished 2 tasks");
  });

  it("names each kind of burst: remembered, planned, updated", () => {
    const { container, unmount } = feed([
      ev(1, "kb.added", { ref: "kb:1", msg: "[note] first" }),
      ev(2, "kb.added", { ref: "kb:2", msg: "[note] second" }),
    ]);
    expect(container.querySelector("details summary")?.textContent).toContain("remembered 2 things");
    expect(container.querySelector("details summary .truncate")?.textContent).toBe("first, second");
    unmount();
    const planned = feed([ev(1, "task.created", { ref: "t1" }), ev(2, "task.created", { ref: "t2" })]);
    expect(planned.container.querySelector("details summary")?.textContent).toContain("planned 2 tasks");
    expect(planned.container.querySelector("details summary .truncate")?.textContent).toBe("t1, t2");
    unmount();
    const mixed = feed([
      ev(1, "task.created", { ref: "t1" }),
      ev(2, "task.status", { ref: "t2", data: { status: "done" } }),
    ]);
    expect(mixed.container.querySelector("details summary")?.textContent).toContain("updated 2 tasks");
  });

  it("keeps another sender's event and a non-consecutive run out of the burst", () => {
    const { container } = feed([
      ev(1, "task.status", { data: { status: "done" } }),
      ev(2, "task.status", { from: "beta", data: { status: "done" } }),
      ev(3, "task.status", { data: { status: "done" } }),
    ]);
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(container.querySelectorAll(".feed-row")).toHaveLength(3);
  });

  it("never folds an ask that waits for replies into a burst", () => {
    const { container } = feed([
      ev(1, "ask", { to: "owner", needs_reply: true }),
      ev(2, "ask", { to: "owner", needs_reply: true }),
    ]);
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(container.querySelectorAll(".feed-row")).toHaveLength(2);
  });

  it("shows the empty states", () => {
    const { container, unmount } = feed([]);
    expect(screen.getByText("No activity yet")).not.toBeNull();
    expect(screen.getByText("Events show up here the moment a session publishes them.")).not.toBeNull();
    expect(container.querySelector("[data-empty]")).not.toBeNull();
    unmount();
    const none = feed([ev(1, "kb.added")], { filter: { family: "task", session: "" } });
    expect(none.container.textContent).toContain("Nothing matches");
    expect(none.container.textContent).toContain("Pick another filter or Everyone.");
  });

  it("applies the filters to the events it shows", () => {
    const { container } = feed([ev(1, "kb.added"), ev(2, "task.status", { data: { status: "done" } })], {
      filter: { family: "task", session: "" },
    });
    expect(container.querySelectorAll(".feed-row")).toHaveLength(1);
    expect(container.querySelector('[data-seq="2"]')).not.toBeNull();
    expect(container.querySelector('[data-seq="1"]')).toBeNull();
  });

  it("offers 'Show older activity' when older pages exist and the wiring wants them", () => {
    const onOlder = vi.fn();
    const { container, unmount } = feed([ev(5, "msg"), ev(6, "msg")], { onOlder });
    const older = container.querySelector("#older");
    expect(older?.textContent).toContain("Show older activity");
    if (older) fireEvent.click(older);
    expect(onOlder).toHaveBeenCalledTimes(1);
    unmount();
    const firstPage = feed([ev(1, "msg"), ev(2, "msg")], { onOlder });
    expect(firstPage.container.querySelector("#older")).toBeNull();
    unmount();
    const unwired = feed([ev(5, "msg")]);
    expect(unwired.container.querySelector("#older")).toBeNull();
    unmount();
    const nothing = feed([], { onOlder });
    expect(nothing.container.querySelector("#older")).toBeNull();
  });

  it("shows the 'N new' jump only when events arrived below the fold", () => {
    const { container, unmount } = feed([ev(1, "msg")], { newCount: 3 });
    const pill = container.querySelector("#tlnew");
    expect(pill?.textContent).toContain("3 new");
    expect(pill?.getAttribute("aria-label")).toBe("3 new events: jump to the latest");
    if (pill) fireEvent.click(pill);
    unmount();
    const none = feed([ev(1, "msg")]);
    expect(none.container.querySelector("#tlnew")).toBeNull();
    unmount();
    const zero = feed([ev(1, "msg")], { newCount: 0 });
    expect(zero.container.querySelector("#tlnew")).toBeNull();
  });

  it("keeps the feed pinned to the bottom while it is already there", () => {
    const { container, rerender, unmount } = feed([ev(1, "msg")]);
    const log = container.querySelector("#tl") as HTMLElement;
    Object.defineProperty(log, "scrollHeight", { value: 500, configurable: true });
    expect(log.scrollTop).toBe(0);
    const props = {
      replies: new Map<number, string[]>(),
      now: NOW,
      filter: { family: "all", session: "" },
      taskById,
    };
    rerender(<Timeline events={[ev(1, "msg"), ev(2, "msg")]} {...props} />);
    expect(log.scrollTop).toBe(500);
    unmount();
    // a reader who scrolled back stays where they are when more events land
    const away = feed([ev(1, "msg")]);
    const log2 = away.container.querySelector("#tl") as HTMLElement;
    Object.defineProperty(log2, "scrollHeight", { value: 500, configurable: true });
    log2.scrollTop = 0;
    log2.dispatchEvent(new Event("scroll"));
    away.rerender(<Timeline events={[ev(1, "msg"), ev(2, "msg")]} {...props} />);
    expect(log2.scrollTop).toBe(0);
  });

  it("tells the page where the feed sits as the reader scrolls, and on the jump", () => {
    const onAtBottom = vi.fn();
    const { container } = feed([ev(1, "msg")], { onAtBottom, newCount: 2 });
    const log = container.querySelector("#tl") as HTMLElement;
    Object.defineProperty(log, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 100, configurable: true });
    log.scrollTop = 0;
    fireEvent.scroll(log);
    expect(onAtBottom).toHaveBeenLastCalledWith(false);
    log.scrollTop = 480;
    fireEvent.scroll(log);
    expect(onAtBottom).toHaveBeenLastCalledWith(true);
    // the jump pill says the reader is heading home, wherever scroll events reach
    fireEvent.click(container.querySelector("#tlnew") as HTMLElement);
    expect(onAtBottom).toHaveBeenLastCalledWith(true);
  });

  it("keeps the scrollable log's role and label", () => {
    const { container } = feed([ev(1, "msg")]);
    const log = container.querySelector("#tl");
    expect(log?.getAttribute("role")).toBe("log");
    expect(log?.getAttribute("aria-label")).toBe("Activity");
  });
});
