import { describe, expect, it } from "vitest";
import {
  avatarColor,
  FIN,
  type Session,
  SSTM,
  STAT,
  STATM,
  sessionStatus,
  sessionWhy,
  type Task,
  type TaskStatus,
  taskState,
  who,
  whoL,
} from "../src/status.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const task = (status: TaskStatus, extra: Partial<Task> = {}): Task => ({ status, ...extra });
const find = (id: string): Task | null =>
  id === "t1" ? task("blocked") : id === "t2" ? task("todo", { unmet: ["t1"] }) : null;
const AV_COLOURS = ["c-blue", "c-teal", "c-sky", "c-lavender", "c-pink", "c-flamingo", "c-sapphire"];

describe("task states", () => {
  it("keeps the board's statuses and the two that finish a task", () => {
    expect(STAT).toEqual(["todo", "doing", "done", "blocked", "skipped"]);
    expect([...FIN]).toEqual(["done", "skipped"]);
  });

  it("gives every entry of STATM its word, icon and colour", () => {
    expect(STATM.todo).toEqual({ l: "To do", i: "circle", c: "c-idle" });
    expect(STATM.doing).toEqual({ l: "Doing", i: "half", c: "c-yellow" });
    expect(STATM.done).toEqual({ l: "Done", i: "checkc", c: "c-green" });
    expect(STATM.blocked).toEqual({ l: "Blocked", i: "ban", c: "c-red" });
    expect(STATM.skipped).toEqual({ l: "Skipped", i: "minusc", c: "c-idle" });
    expect(STATM.waiting).toEqual({ l: "Waiting", i: "hourglass", c: "c-peach" });
  });

  it("gives every entry of SSTM its word, icon and colour", () => {
    expect(SSTM.paused).toEqual({ l: "Paused", i: "pause", c: "c-mauve" });
    expect(SSTM.blocked).toEqual({ l: "Blocked", i: "ban", c: "c-red" });
    expect(SSTM.waiting).toEqual({ l: "Waiting", i: "hourglass", c: "c-peach" });
    expect(SSTM.working).toEqual({ l: "Working", i: "activity", c: "c-yellow" });
    expect(SSTM.idle).toEqual({ l: "Idle", i: "zzz", c: "c-idle" });
    expect(SSTM.left).toEqual({ l: "Left", i: "logout", c: "c-idle" });
  });

  it("shows a task's own status, and waiting only for an open task that waits on work", () => {
    expect(taskState(null)).toBe("todo");
    expect(taskState(undefined)).toBe("todo");
    expect(taskState(task("todo"))).toBe("todo");
    expect(taskState(task("doing"))).toBe("doing");
    expect(taskState(task("todo", { blocked_by: [], unmet: [] }))).toBe("todo");
    expect(taskState(task("todo", { blocked_by: ["t9"] }))).toBe("waiting");
    expect(taskState(task("doing", { unmet: ["t9"] }))).toBe("waiting");
    expect(taskState(task("blocked", { blocked_by: ["t9"] }))).toBe("blocked");
    expect(taskState(task("done", { unmet: ["t9"] }))).toBe("done");
    expect(taskState(task("skipped", { blocked_by: ["t9"] }))).toBe("skipped");
  });
});

describe("sessionStatus", () => {
  it("answers idle for no session and for a quiet one", () => {
    expect(sessionStatus(null, find)).toBe("idle");
    expect(sessionStatus(undefined, find)).toBe("idle");
    expect(sessionStatus({}, find)).toBe("idle");
    expect(sessionStatus({ state: "idle" }, find)).toBe("idle");
  });

  it("ranks left above a pause", () => {
    expect(sessionStatus({ state: "left", control: "pause" }, find)).toBe("left");
  });

  it("ranks paused above blocked, waiting and working", () => {
    expect(sessionStatus({ control: "pause", state: "working" }, find)).toBe("paused");
    expect(sessionStatus({ control: "pause", state: "blocked" }, find)).toBe("paused");
    expect(sessionStatus({ control: "pause", step: "t1" }, find)).toBe("paused");
  });

  it("ranks blocked above waiting and working, from the state or the step's task", () => {
    expect(sessionStatus({ state: "blocked" }, find)).toBe("blocked");
    expect(sessionStatus({ step: "t1" }, find)).toBe("blocked");
    expect(sessionStatus({ state: "blocked", step: "t2" }, find)).toBe("blocked");
    expect(sessionStatus({ state: "waiting", step: "t1" }, find)).toBe("blocked");
  });

  it("ranks waiting above working, from the state or the step's task", () => {
    expect(sessionStatus({ state: "waiting" }, find)).toBe("waiting");
    expect(sessionStatus({ step: "t2" }, find)).toBe("waiting");
    expect(sessionStatus({ state: "working", step: "t2" }, find)).toBe("waiting");
    expect(sessionStatus({ state: "working", step: "gone" }, find)).toBe("working");
  });

  it("reads a stale working session as idle", () => {
    expect(sessionStatus({ state: "working" }, find)).toBe("working");
    expect(sessionStatus({ state: "working", stale: true }, find)).toBe("idle");
  });
});

describe("sessionWhy", () => {
  it("tells who paused the session and when, and what a resume takes back", () => {
    const s: Session = { control: "pause", control_by: "owner", control_at: "2026-10-08T11:58:00Z" };
    expect(sessionWhy(s, find, NOW)).toBe(
      `Paused by you 2 min ago. Its changes are refused until you resume it.`,
    );
    expect(sessionWhy({ control: "pause", control_by: "greta" }, find, NOW)).toBe(
      "Paused by greta. Its changes are refused until you resume it.",
    );
    expect(sessionWhy({ control: "pause" }, find, NOW)).toBe(
      "Paused by someone. Its changes are refused until you resume it.",
    );
  });

  it("reports a stale session's last sign of life", () => {
    const s: Session = { state: "working", stale: true, last_seen: "2026-10-08T11:57:00Z" };
    expect(sessionWhy(s, find, NOW)).toBe("No sign of life since 3 min ago.");
    expect(sessionWhy({ state: "idle", stale: true }, find, NOW)).toBe("");
  });

  it("explains waiting and blocked, and stays quiet otherwise", () => {
    expect(sessionWhy({ state: "waiting" }, find, NOW)).toBe("Waiting for another task or a reply.");
    expect(sessionWhy({ step: "t2" }, find, NOW)).toBe("Waiting for another task or a reply.");
    expect(sessionWhy({ step: "t1" }, find, NOW)).toBe("Blocked: it cannot go on without help.");
    expect(sessionWhy({ state: "working" }, find, NOW)).toBe("");
    expect(sessionWhy(null, find, NOW)).toBe("");
  });
});

describe("avatars and names", () => {
  it("hashes a stable colour per name, from the part before the first dot", () => {
    expect(avatarColor("greta")).toBe(avatarColor("greta"));
    expect(avatarColor("greta.sub.agent")).toBe(avatarColor("greta"));
    expect(avatarColor("")).toBe(avatarColor(""));
    expect(AV_COLOURS).toContain(avatarColor("greta"));
    expect(AV_COLOURS).toContain(avatarColor(""));
    expect(AV_COLOURS).toContain(avatarColor("owner"));
  });

  it("spells the owner as You, and you mid-sentence", () => {
    expect(who("owner")).toBe("You");
    expect(who("greta")).toBe("greta");
    expect(whoL("owner")).toBe("you");
    expect(whoL("greta")).toBe("greta");
  });
});
