// status.ts — the status model: task states, one derived status per session, the reason under each
// pill, avatar colours and the owner's name in its two forms. Pure functions; the current time and
// the task lookup arrive as arguments, so the same call always answers the same.
import { type Stamp, timeAgo } from "@muhmdraouf/ui/time.ts";
import type { IconName } from "./icons.tsx";

/** A task's stored status. */
export type TaskStatus = "todo" | "doing" | "done" | "blocked" | "skipped";

/** What a task shows: its status, or "waiting" when it is open and waits on unfinished work. */
export type TaskState = TaskStatus | "waiting";

/** The statuses a board moves a task through. */
export const STAT: readonly TaskStatus[] = ["todo", "doing", "done", "blocked", "skipped"];

/** Statuses that end a task: nothing waits on them any more. */
export const FIN: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "skipped"]);

/** One row of a status table: the word, its icon, its colour. */
export type StatMeta = { l: string; i: IconName; c: string };

/** Task status → word, icon and colour; "waiting" is a derived state and shares the table. */
export const STATM: Record<TaskState, StatMeta> = {
  todo: { l: "To do", i: "circle", c: "c-idle" },
  doing: { l: "Doing", i: "half", c: "c-yellow" },
  done: { l: "Done", i: "checkc", c: "c-green" },
  blocked: { l: "Blocked", i: "ban", c: "c-red" },
  skipped: { l: "Skipped", i: "minusc", c: "c-idle" },
  waiting: { l: "Waiting", i: "hourglass", c: "c-peach" },
};

/** Session status → word, icon and colour. */
export const SSTM: Record<SessionStatus, StatMeta> = {
  paused: { l: "Paused", i: "pause", c: "c-mauve" },
  blocked: { l: "Blocked", i: "ban", c: "c-red" },
  waiting: { l: "Waiting", i: "hourglass", c: "c-peach" },
  working: { l: "Working", i: "activity", c: "c-yellow" },
  idle: { l: "Idle", i: "zzz", c: "c-idle" },
  left: { l: "Left", i: "logout", c: "c-idle" },
};

/** The display row of a status word, or undefined for a word neither table knows. */
export const statMeta = (status: string): StatMeta | undefined => STATM[status as TaskState];

/** The display row of a session status word, or undefined for a word the table does not know. */
export const sessionMeta = (status: string): StatMeta | undefined => SSTM[status as SessionStatus];

/** Only the fields of a task the status model reads. */
export type Task = {
  status: TaskStatus;
  blocked_by?: readonly string[] | undefined;
  unmet?: readonly string[] | undefined;
};

/** Looks a task up by id; a miss is null or undefined. */
export type TaskLookup = (id: string) => Task | null | undefined;

/** What a task shows: its status, except an open task whose dependencies are unfinished is "waiting". */
export function taskState(task: Task | null | undefined): TaskState {
  if (!task) return "todo";
  const waits = (task.blocked_by?.length ?? 0) > 0 || (task.unmet?.length ?? 0) > 0;
  return !FIN.has(task.status) && task.status !== "blocked" && waits ? "waiting" : task.status;
}

/** A session's raw state, as the server reports it. */
export type SessionState = "working" | "blocked" | "waiting" | "idle" | "left";

/** One derived status per session, in this priority: Paused › Blocked › Waiting › Working › Idle › Left. */
export type SessionStatus = SessionState | "paused";

/** Only the fields of a session the status model reads. */
export type Session = {
  state?: SessionState | undefined;
  control?: string | undefined;
  control_by?: string | undefined;
  control_at?: Stamp | undefined;
  step?: string | null | undefined;
  stale?: boolean | undefined;
  last_seen?: Stamp | undefined;
};

/** A session's one derived status. A paused session is never also "working"; a stale working one is idle. */
export function sessionStatus(session: Session | null | undefined, taskById: TaskLookup): SessionStatus {
  if (!session) return "idle";
  if (session.state === "left") return "left";
  if (session.control === "pause") return "paused";
  const task = session.step ? taskById(session.step) : null;
  if (session.state === "blocked" || task?.status === "blocked") return "blocked";
  if (session.state === "waiting" || (task && taskState(task) === "waiting")) return "waiting";
  if (session.state === "working" && !session.stale) return "working";
  return "idle";
}

/** Why a session sits in its status: a sentence for the pill's title, empty when there is nothing to say. */
export function sessionWhy(session: Session | null | undefined, taskById: TaskLookup, now: number): string {
  const k = sessionStatus(session, taskById);
  if (k === "paused") {
    const by = session?.control_by === "owner" ? "you" : session?.control_by || "someone";
    const at = session?.control_at ? ` ${timeAgo(session.control_at, now)}` : "";
    return `Paused by ${by}${at}. Its changes are refused until you resume it.`;
  }
  if (k === "idle" && session?.stale && session.state !== "idle")
    return `No sign of life since ${timeAgo(session.last_seen, now)}.`;
  if (k === "waiting") return "Waiting for another task or a reply.";
  if (k === "blocked") return "Blocked: it cannot go on without help.";
  return "";
}

const AVC: readonly string[] = [
  "c-blue",
  "c-teal",
  "c-sky",
  "c-lavender",
  "c-pink",
  "c-flamingo",
  "c-sapphire",
];

/** A stable colour per name, hashed from the part before the first dot; the owner is mauve instead. */
export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of String(name).split(".")[0] ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVC[h % AVC.length] ?? "c-blue";
}

/** The owner's name where a sentence starts it: "You". */
export const who = (name: string): string => (name === "owner" ? "You" : name);

/** The owner's name mid-sentence: "you". */
export const whoL = (name: string): string => (name === "owner" ? "you" : name);
