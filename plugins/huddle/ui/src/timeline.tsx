// timeline.tsx — the timeline in human verbs: one phrase per event topic, with the icon and colour
// the feed shows beside it, and the text that follows the verb minus what the verb already says.
// The raw topic stays available for a tooltip.
import type { ComponentChildren, JSX } from "preact";
import type { IconName } from "./icons.tsx";
import { statMeta } from "./status.ts";

/** The family a topic belongs to; the timeline's filters group by it. */
export type TimelineFamily = "task" | "turn" | "control" | "msg" | "kb" | "session" | "other";

/** The family a topic belongs to; an unknown topic is "other". */
export function familyOf(topic: string): TimelineFamily {
  if (/^task\./.test(topic)) return "task";
  if (/^turn\./.test(topic)) return "turn";
  if (/^control\./.test(topic)) return "control";
  if (topic === "ask" || topic === "msg" || topic === "reply") return "msg";
  if (/^kb\./.test(topic)) return "kb";
  if (/^session\./.test(topic)) return "session";
  return "other";
}

/** Only the fields of an event's data the verbs and texts read. */
export type EventData = {
  task?: string | undefined;
  status?: string | undefined;
  owner?: string | undefined;
  approved?: boolean | undefined;
  brief?: boolean | undefined;
  context?: string | undefined;
  skipped?: number | null | undefined;
};

/** One timeline event: a topic, who sent it, and the fields the verbs and texts read. */
export type TimelineEvent = {
  topic: string;
  from?: string | undefined;
  to?: string | undefined;
  ref?: string | undefined;
  msg?: string | undefined;
  data?: EventData | undefined;
};

/** What an event says: the verb phrase with its markup, the icon and the colour for the feed. */
export type Verb = { v: ComponentChildren; i: IconName; c: string };

/** A task id shown emphasised, or nothing when the event carries no id. */
const tq = (id: string | undefined): ComponentChildren =>
  id ? <b class="font-medium text-base-content">{id}</b> : "";

const STATUS_WORDS: Record<string, string> = {
  done: "finished",
  doing: "started",
  blocked: "is blocked on",
  skipped: "skipped",
  todo: "reopened",
};

/** A task.status event: the past-tense word, or "moved" for a status without a word of its own. */
function statusVerb(d: EventData, task: string | undefined): Verb {
  const m = d.status ? statMeta(d.status) : undefined;
  const word = d.status ? STATUS_WORDS[d.status] : undefined;
  return { v: [word ? `${word} ` : "moved ", tq(task)], i: m?.i ?? "circle", c: m?.c ?? "c-idle" };
}

/** A msg event: an approval, a brief handed over, or a plain tell. */
function msgVerb(d: EventData, task: string | undefined, to: string): Verb {
  if (d.approved) return { v: ["approved ", tq(task)], i: "key", c: "c-green" };
  if (d.brief) return { v: `briefed ${to}`, i: "baton", c: "c-idle" };
  return { v: `told ${to}`, i: "msg", c: "c-idle" };
}

/** A session.joined event: a fresh start, a catch-up with the skipped count, or a plain join. */
function joinedVerb(d: EventData): Verb {
  if (d.context === "fresh") {
    return {
      v: d.skipped != null ? `started fresh (skipped ${d.skipped})` : "started fresh",
      i: "sparkle",
      c: "c-idle",
    };
  }
  if (d.context === "sync") {
    return {
      v: d.skipped ? `caught up on ${d.skipped} event${d.skipped === 1 ? "" : "s"}` : "joined, up to date",
      i: "undo",
      c: "c-idle",
    };
  }
  return { v: "joined", i: "users", c: "c-idle" };
}

/** Who an event addresses: the owner is "you", an unaddressed event speaks to everyone. */
function addressee(event: TimelineEvent): string {
  if (!event.to) return "everyone";
  return event.to === "owner" ? "you" : event.to;
}

/** The verb phrase of one event: what the feed shows after the actor's name. */
export function verb(event: TimelineEvent): Verb {
  const d = event.data ?? {};
  const task = d.task || event.ref;
  const to = addressee(event);
  switch (event.topic) {
    case "task.status":
      return statusVerb(d, task);
    case "task.created":
      return { v: ["planned ", tq(task), event.to ? ` for ${to}` : ""], i: "plus", c: "c-idle" };
    case "task.assigned":
      return {
        v: ["gave ", tq(task), " to ", d.owner ? (d.owner === "owner" ? "you" : d.owner) : "nobody"],
        i: "users",
        c: "c-idle",
      };
    case "task.ready":
      return { v: ["unblocked ", tq(task), event.to ? ` for ${to}` : ""], i: "check", c: "c-green" };
    case "kb.added":
      return { v: "remembered", i: "brain", c: "c-teal" };
    case "ask":
      return { v: `asked ${to}`, i: "ask", c: "c-mauve" };
    case "msg":
      return msgVerb(d, task, to);
    case "reply":
      return { v: `answered ${to}`, i: "undo", c: "c-idle" };
    case "turn.pass":
      return { v: `handed the turn to ${to}`, i: "turn", c: "c-idle" };
    case "turn.take":
      return { v: "took the turn", i: "turn", c: "c-idle" };
    case "control.pause":
      return { v: `paused ${to}`, i: "pause", c: "c-mauve" };
    case "control.resume":
      return { v: `resumed ${to}`, i: "play", c: "c-idle" };
    case "session.joined":
      return joinedVerb(d);
    case "session.left":
      return { v: "left", i: "logout", c: "c-idle" };
    case "brief":
      return { v: `briefed ${to}`, i: "note", c: "c-idle" };
    default:
      return { v: `posted ${event.topic}`, i: "activity", c: "c-idle" };
  }
}

/** An event's verb phrase as markup: the words, with the task id emphasised when there is one. */
export function Verb({ event }: { event: TimelineEvent }): JSX.Element {
  return <>{verb(event).v}</>;
}

/** A created or ready task's text: the message without the task's name and the stock suffixes. */
function taskText(event: TimelineEvent, m: string): string {
  const t = event.data?.task || event.ref;
  const x = t && m.startsWith(`${t} `) ? m.slice(t.length + 1) : m;
  return x.replace(/: everything it waits on is done$/, "").replace(/ → [\w.-]+( after .*)?$/, "");
}

/** A joined or left event's text: the message without the sender's preamble. */
function sessionText(event: TimelineEvent, m: string): string {
  const sender = (event.from ?? "").replace(/\./g, "\\.");
  return m.replace(new RegExp(`^${sender} (joined|returned|left):? ?`), "");
}

/** The text that follows the verb, minus what the verb already says. */
export function eventText(event: TimelineEvent): string {
  const m = String(event.msg ?? "");
  switch (event.topic) {
    case "task.status":
      return m.includes(" · ") ? m.slice(m.indexOf(" · ") + 3) : "";
    case "task.created":
    case "task.ready":
      return taskText(event, m);
    case "task.assigned":
      return "";
    case "kb.added":
      return m.replace(/^\[\w+\]\s*/, "");
    case "session.joined":
    case "session.left":
      return sessionText(event, m);
    case "control.pause":
    case "control.resume":
      return /^\S+ (pause|resume)d \S+$/.test(m) ? "" : m;
    case "turn.pass":
    case "turn.take":
      return /hands the turn to|takes the turn$/.test(m) ? "" : m;
    default:
      return m;
  }
}
