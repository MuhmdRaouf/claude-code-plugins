import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { eventText, familyOf, type TimelineEvent, Verb, verb } from "../src/timeline.tsx";

const ev = (topic: string, extra: Omit<Partial<TimelineEvent>, "topic"> = {}): TimelineEvent => ({
  topic,
  ...extra,
});

/** The words a rendered verb shows, with the emphasised task id marked up as legacy did. */
const phrase = (e: TimelineEvent): { text: string; bold: string | null; boldClass: string | null } => {
  const { container } = render(<Verb event={e} />);
  const b = container.querySelector("b");
  return {
    text: (container.textContent ?? "").trim(),
    bold: b?.textContent ?? null,
    boldClass: b?.getAttribute("class") ?? null,
  };
};

describe("familyOf", () => {
  it("sorts every topic into its family, unknown ones into other", () => {
    expect(familyOf("task.status")).toBe("task");
    expect(familyOf("turn.pass")).toBe("turn");
    expect(familyOf("control.pause")).toBe("control");
    expect(familyOf("ask")).toBe("msg");
    expect(familyOf("msg")).toBe("msg");
    expect(familyOf("reply")).toBe("msg");
    expect(familyOf("kb.added")).toBe("kb");
    expect(familyOf("session.joined")).toBe("session");
    expect(familyOf("brief")).toBe("other");
    expect(familyOf("note.added")).toBe("other");
  });
});

describe("verb", () => {
  it("speaks each task status, with the status's icon and colour", () => {
    expect(phrase(ev("task.status", { data: { status: "done", task: "Fix login" } }))).toEqual({
      text: "finished Fix login",
      bold: "Fix login",
      boldClass: "font-medium text-base-content",
    });
    expect(verb(ev("task.status", { data: { status: "doing", task: "Fix login" } }))).toMatchObject({
      i: "half",
      c: "c-yellow",
    });
    expect(verb(ev("task.status", { data: { status: "blocked", task: "Fix login" } }))).toMatchObject({
      i: "ban",
      c: "c-red",
    });
    expect(verb(ev("task.status", { data: { status: "skipped", task: "Fix login" } }))).toMatchObject({
      i: "minusc",
      c: "c-idle",
    });
    expect(verb(ev("task.status", { data: { status: "todo", task: "Fix login" } }))).toMatchObject({
      i: "circle",
      c: "c-idle",
    });
  });

  it("says moved for a status without a word, and works without a task id", () => {
    const moved = phrase(ev("task.status", { data: { status: "review" } }));
    expect(moved).toEqual({ text: "moved", bold: null, boldClass: null });
    expect(verb(ev("task.status", { data: { status: "review" } }))).toMatchObject({
      i: "circle",
      c: "c-idle",
    });
    expect(phrase(ev("task.status", { ref: "Fix login", data: { status: "done" } })).text).toBe(
      "finished Fix login",
    );
    expect(phrase(ev("task.status", {})).text).toBe("moved");
    expect(verb(ev("task.status", {}))).toMatchObject({ i: "circle", c: "c-idle" });
  });

  it("plans, assigns and unblocks tasks", () => {
    expect(phrase(ev("task.created", { data: { task: "Fix login" } })).text).toBe("planned Fix login");
    expect(phrase(ev("task.created", { data: { task: "Fix login" }, to: "greta" })).text).toBe(
      "planned Fix login for greta",
    );
    expect(phrase(ev("task.created", { data: { task: "Fix login" }, to: "owner" })).text).toBe(
      "planned Fix login for you",
    );
    expect(phrase(ev("task.assigned", { data: { task: "Fix login", owner: "owner" } })).text).toBe(
      "gave Fix login to you",
    );
    expect(phrase(ev("task.assigned", { data: { task: "Fix login", owner: "greta" } })).text).toBe(
      "gave Fix login to greta",
    );
    expect(phrase(ev("task.assigned", { data: { task: "Fix login" } })).text).toBe(
      "gave Fix login to nobody",
    );
    expect(phrase(ev("task.ready", { ref: "Fix login", to: "greta" })).text).toBe(
      "unblocked Fix login for greta",
    );
    expect(verb(ev("task.ready", { ref: "Fix login" }))).toMatchObject({ i: "check", c: "c-green" });
    expect(verb(ev("task.created", {}))).toMatchObject({ i: "plus", c: "c-idle" });
    expect(verb(ev("task.assigned", {}))).toMatchObject({ i: "users", c: "c-idle" });
  });

  it("addresses the owner as you and nobody as everyone", () => {
    expect(phrase(ev("ask", { to: "owner" })).text).toBe("asked you");
    expect(phrase(ev("ask", { to: "greta" })).text).toBe("asked greta");
    expect(phrase(ev("ask", {})).text).toBe("asked everyone");
    expect(verb(ev("ask", {}))).toMatchObject({ i: "ask", c: "c-mauve" });
  });

  it("approves, briefs and tells", () => {
    const approved = phrase(ev("msg", { data: { approved: true, task: "Fix login" } }));
    expect(approved).toEqual({
      text: "approved Fix login",
      bold: "Fix login",
      boldClass: "font-medium text-base-content",
    });
    expect(verb(ev("msg", { data: { approved: true } }))).toMatchObject({ i: "key", c: "c-green" });
    expect(phrase(ev("msg", { data: { brief: true } })).text).toBe("briefed everyone");
    expect(verb(ev("msg", { data: { brief: true } }))).toMatchObject({ i: "baton", c: "c-idle" });
    expect(phrase(ev("msg", { to: "greta" })).text).toBe("told greta");
    expect(verb(ev("msg", {}))).toMatchObject({ i: "msg", c: "c-idle" });
    expect(phrase(ev("reply", { to: "owner" })).text).toBe("answered you");
  });

  it("hands and takes the turn, pauses and resumes", () => {
    expect(phrase(ev("turn.pass", { to: "greta" })).text).toBe("handed the turn to greta");
    expect(phrase(ev("turn.take", {})).text).toBe("took the turn");
    expect(verb(ev("turn.pass", {})).i).toBe("turn");
    expect(phrase(ev("control.pause", { to: "greta" })).text).toBe("paused greta");
    expect(verb(ev("control.pause", {}))).toMatchObject({ i: "pause", c: "c-mauve" });
    expect(phrase(ev("control.resume", { to: "greta" })).text).toBe("resumed greta");
    expect(verb(ev("control.resume", {}))).toMatchObject({ i: "play", c: "c-idle" });
  });

  it("joins fresh, caught up or plainly, and leaves", () => {
    expect(phrase(ev("session.joined", { data: { context: "fresh" } })).text).toBe("started fresh");
    expect(phrase(ev("session.joined", { data: { context: "fresh", skipped: 0 } })).text).toBe(
      "started fresh (skipped 0)",
    );
    expect(phrase(ev("session.joined", { data: { context: "sync", skipped: 1 } })).text).toBe(
      "caught up on 1 event",
    );
    expect(phrase(ev("session.joined", { data: { context: "sync", skipped: 3 } })).text).toBe(
      "caught up on 3 events",
    );
    expect(phrase(ev("session.joined", { data: { context: "sync" } })).text).toBe("joined, up to date");
    expect(phrase(ev("session.joined", {})).text).toBe("joined");
    expect(verb(ev("session.joined", { data: { context: "fresh" } }))).toMatchObject({
      i: "sparkle",
      c: "c-idle",
    });
    expect(verb(ev("session.joined", { data: { context: "sync" } }))).toMatchObject({
      i: "undo",
      c: "c-idle",
    });
    expect(verb(ev("session.joined", {}))).toMatchObject({ i: "users", c: "c-idle" });
    expect(phrase(ev("session.left", {})).text).toBe("left");
    expect(verb(ev("session.left", {}))).toMatchObject({ i: "logout", c: "c-idle" });
  });

  it("remembers, briefs and posts what it cannot phrase", () => {
    expect(phrase(ev("kb.added", {})).text).toBe("remembered");
    expect(verb(ev("kb.added", {}))).toMatchObject({ i: "brain", c: "c-teal" });
    expect(phrase(ev("brief", { to: "greta" })).text).toBe("briefed greta");
    expect(verb(ev("brief", {}))).toMatchObject({ i: "note", c: "c-idle" });
    expect(phrase(ev("note.added", {})).text).toBe("posted note.added");
    expect(verb(ev("note.added", {}))).toMatchObject({ i: "activity", c: "c-idle" });
  });
});

describe("eventText", () => {
  it("keeps only what the status verb did not say", () => {
    expect(eventText(ev("task.status", { msg: "Fix login · all green" }))).toBe("all green");
    expect(eventText(ev("task.status", { msg: "Fix login" }))).toBe("");
    expect(eventText(ev("task.status", {}))).toBe("");
  });

  it("strips the task's name and the ready and assigned suffixes", () => {
    expect(
      eventText(ev("task.created", { ref: "Fix login", msg: "Fix login handed to greta → bob after carol" })),
    ).toBe("handed to greta");
    expect(eventText(ev("task.ready", { ref: "Fix login", msg: "Fix login handed to greta → bob" }))).toBe(
      "handed to greta",
    );
    expect(
      eventText(
        ev("task.created", { data: { task: "Fix login" }, msg: "Fix login: everything it waits on is done" }),
      ),
    ).toBe("Fix login");
    expect(
      eventText(
        ev("task.created", {
          data: { task: "Fix login" },
          msg: "Fix login done: everything it waits on is done",
        }),
      ),
    ).toBe("done");
    expect(eventText(ev("task.created", { ref: "Fix login", msg: "a plain note" }))).toBe("a plain note");
    expect(eventText(ev("task.created", { msg: "a plain note" }))).toBe("a plain note");
    expect(eventText(ev("task.assigned", { msg: "whatever" }))).toBe("");
  });

  it("drops the knowledge-base tag and the join and leave preamble", () => {
    expect(eventText(ev("kb.added", { msg: "[decision] Rotate the deploy keys" }))).toBe(
      "Rotate the deploy keys",
    );
    expect(eventText(ev("kb.added", { msg: "no tag here" }))).toBe("no tag here");
    expect(eventText(ev("session.joined", { from: "greta.sub", msg: "greta.sub joined: hello there" }))).toBe(
      "hello there",
    );
    expect(eventText(ev("session.joined", { from: "greta.sub", msg: "greta.sub returned" }))).toBe("");
    expect(eventText(ev("session.left", { from: "greta", msg: "greta left: bye" }))).toBe("bye");
    expect(eventText(ev("session.left", { from: "greta", msg: "someone else said left" }))).toBe(
      "someone else said left",
    );
    expect(eventText(ev("session.left", { msg: "no sender in the message" }))).toBe(
      "no sender in the message",
    );
  });

  it("keeps control and turn texts only when they carry more than the verb", () => {
    expect(eventText(ev("control.pause", { msg: "greta paused bob" }))).toBe("");
    expect(eventText(ev("control.resume", { msg: "greta resumed bob" }))).toBe("");
    expect(eventText(ev("control.pause", { msg: "greta paused bob for the release" }))).toBe(
      "greta paused bob for the release",
    );
    expect(eventText(ev("turn.pass", { msg: "greta hands the turn to bob" }))).toBe("");
    expect(eventText(ev("turn.take", { msg: "greta takes the turn" }))).toBe("");
    expect(eventText(ev("turn.pass", { msg: "the turn moved by hand" }))).toBe("the turn moved by hand");
    expect(eventText(ev("note.added", { msg: "anything at all" }))).toBe("anything at all");
    expect(eventText(ev("note.added", {}))).toBe("");
  });
});
