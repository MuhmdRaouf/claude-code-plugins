// Timeline.tsx — the Team page's activity feed: one row per event in human verbs, coloured by
// topic family, with the task it is about as a badge badge-ghost badge-sm, an ask's state and the owner's Reply button
// under it. Runs of task and knowledge updates from one sender fold into one burst row that
// opens into the events themselves. The filters arrive as a prop; `pass` is the predicate.
import { Inline } from "@muhmdraouf/ui/markdown.tsx";
import type { ComponentChild, ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../icons.tsx";
import { Avatar, StatusIcon, Time } from "../kit.tsx";
import { type Task, taskState, who } from "../status.ts";
import type { FeedEvent, PlanStep } from "../store.ts";
import type { EventData, TimelineEvent, TimelineFamily } from "../timeline.tsx";
import { eventText, familyOf, verb } from "../timeline.tsx";

/** Looks a task up by id: the rows read its status model, the verbs link the ids it knows. */
export type TaskById = (id: string) => PlanStep | null | undefined;

/** The feed's filters: the family buttons ("all", "msg", "task", "kb", "control", "session")
 *  and the session picker ("" for everyone, "owner" for you, or a session's name). */
export type TimelineFilter = { family: string; session: string };

/** The status model's view of a step: a missing step is null, a missing status is "to do". */
const asTask = (step: PlanStep | null | undefined): Task | null =>
  step ? { status: step.status ?? "todo", blocked_by: step.blocked_by } : null;

/** The event as the verbs and texts read it: only their fields, the data narrowed. */
const asVerbEvent = (e: FeedEvent): TimelineEvent => ({
  topic: e.topic,
  from: e.from,
  to: e.to,
  ref: e.ref,
  msg: e.msg,
  data: e.data as EventData | undefined,
});

/** A string field of an event's data, or undefined when it is missing or not a string. */
const dataStr = (e: FeedEvent, k: string): string | undefined => {
  const v = e.data?.[k];
  return typeof v === "string" ? v : undefined;
};

/** The families the "Pause and turn" filter keeps: pauses and every turn event. */
const CONTROLISH: readonly string[] = ["control", "turn"];

/** Does an event pass the feed's filters? A family keeps its own topic family — "control"
 *  keeps the turn's too; a session keeps what it sent, received, or its subagents sent. */
export function pass(e: FeedEvent, f: TimelineFilter): boolean {
  if (f.family !== "all") {
    const fam = familyOf(e.topic);
    if (f.family === "control" ? !CONTROLISH.includes(fam) : fam !== f.family) return false;
  }
  const s = f.session;
  if (
    s &&
    e.from !== s &&
    e.to !== s &&
    !(e.from ?? "").startsWith(`${s}.`) &&
    !(e.to ?? "").startsWith(`${s}.`)
  )
    return false;
  return true;
}

/** A burst's key: runs of task and knowledge updates from one sender fold together; an ask
 *  that waits for replies never joins one. */
export function bkey(e: FeedEvent): string {
  return /^task\.(status|ready|created|assigned)$|^kb\.added$/.test(e.topic) && !e.needs_reply
    ? `${e.from}|${familyOf(e.topic)}`
    : "";
}

/** May the owner reply to an event: it is not the owner's own, it addresses the owner (or waits
 *  for the owner specifically), and the owner has not answered it yet. */
export function canReply(e: FeedEvent, replies: ReadonlyMap<number, string[]>): boolean {
  return (
    e.from !== "owner" &&
    e.topic !== "reply" &&
    (e.to === "owner" || (e.to == null && !!e.needs_reply)) &&
    !(replies.get(e.seq) ?? []).includes("owner")
  );
}

/** The task an event is about: the id its data names, or its ref when the ref is a task. */
export function taskOf(e: FeedEvent, taskById: TaskById): string | null {
  const named = dataStr(e, "task");
  if (named) return named;
  const ref = e.ref;
  return ref && (taskById(ref) || familyOf(e.topic) === "task") ? ref : null;
}

/** The tint of a task row by its status: done and skipped green, blocked red, otherwise yellow. */
const taskTint = (st: string): readonly [string, string] =>
  st === "done" || st === "skipped"
    ? ["c-good", "c-green"]
    : st === "blocked"
      ? ["c-red", "c-red"]
      : ["c-yellow", "c-yellow"];

/** A non-task family's tint: turn mauve, knowledge violet, messages blue. */
const FAMILY_TINT: Partial<Record<TimelineFamily, readonly [string, string]>> = {
  turn: ["c-mauve", "c-mauve"],
  kb: ["c-lavender", "c-lavender"],
  msg: ["c-blue", "c-blue"],
};

/** The feed row's tint: an feed-icon variant and the ink its text carries, by family — task
 *  rows take the task's status, a pause red, the turn mauve, knowledge violet, messages blue. */
export function feedTint(e: FeedEvent, taskById: TaskById): readonly [string, string] {
  const f = familyOf(e.topic);
  if (f === "task") {
    const t = taskOf(e, taskById);
    const st = dataStr(e, "status") ?? taskState(t ? asTask(taskById(t)) : null);
    return taskTint(st);
  }
  if (f === "control") return e.topic === "control.pause" ? ["c-red", "c-red"] : ["c-mauve", "c-mauve"];
  return FAMILY_TINT[f] ?? ["c-blue", "c-idle"];
}

/** An ask's state pill: who has answered it, or who it still waits for. */
export function AskState({
  event,
  replies,
}: {
  event: FeedEvent;
  replies: ReadonlyMap<number, string[]>;
}): JSX.Element {
  const by = replies.get(event.seq) ?? [];
  return by.length ? (
    <span class="badge badge-sm badge-success badge-soft">
      <Icon name="check" class="size-3" />
      Answered by {by.map(who).join(", ")}
    </span>
  ) : (
    <span class="badge badge-sm badge-warning badge-soft">
      <Icon name="hourglass" class="size-3" />
      Waiting for {event.to === "owner" ? "you" : event.to || "anyone"}
    </span>
  );
}

/** A task id emphasised in a verb phrase, as the verbs build it. */
type BoldTask = { type: unknown; props: { class?: unknown; children?: unknown } };

const isBoldTask = (c: unknown): c is BoldTask =>
  typeof c === "object" &&
  c !== null &&
  (c as BoldTask).type === "b" &&
  typeof (c as BoldTask).props === "object" &&
  (c as BoldTask).props !== null;

/** The verb phrase with its task id as a button when the task exists; a task the board does
 *  not know stays emphasised text, exactly as the legacy replace left it. */
function linkTask(
  children: ComponentChildren,
  taskById: TaskById,
  onOpenTask: ((id: string) => void) | undefined,
): ComponentChildren {
  const swap = (c: ComponentChild): ComponentChild => {
    if (!isBoldTask(c)) return c;
    const id = c.props.children as string | undefined;
    if (!id || c.props.class !== "font-medium text-base-content" || !taskById(id)) return c;
    return (
      <button
        type="button"
        class="font-medium text-base-content underline-offset-2 hover:underline"
        onClick={() => onOpenTask?.(id)}
      >
        {id}
      </button>
    );
  };
  return Array.isArray(children) ? children.map(swap) : swap(children);
}

/** A row's footer: the task it is about, the ask's state, and the owner's Reply button. */
function EventFoot({
  event,
  task,
  replies,
  taskById,
  compact,
  onReply,
  onOpenTask,
}: {
  event: FeedEvent;
  task: string | null;
  replies: ReadonlyMap<number, string[]>;
  taskById: TaskById;
  compact: boolean;
  onReply: ((seq: number) => void) | undefined;
  onOpenTask: ((id: string) => void) | undefined;
}): JSX.Element | null {
  const foot: ComponentChildren[] = [];
  if (task && !/task\./.test(event.topic) && event.topic !== "msg")
    foot.push(
      <button
        type="button"
        class="badge badge-ghost badge-sm hover:underline"
        onClick={() => onOpenTask?.(task)}
      >
        <StatusIcon status={taskState(asTask(taskById(task)))} class="size-3" />
        {task}
      </button>,
    );
  if (event.needs_reply)
    foot.push(
      <span>
        <AskState event={event} replies={replies} />
      </span>,
    );
  if (canReply(event, replies) && !compact)
    foot.push(
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => onReply?.(event.seq)}>
        <Icon name="undo" class="size-4.5" />
        Reply
      </button>,
    );
  if (!foot.length) return null;
  return <div class="mt-1 flex flex-wrap items-center gap-1.5">{foot}</div>;
}

/** One row of the feed's props: what it reads, and where its clicks go. */
export type EventRowProps = {
  event: FeedEvent;
  replies: ReadonlyMap<number, string[]>;
  taskById: TaskById;
  now: number;
  /** The drawer's compact rows drop the Reply button. */
  compact?: boolean | undefined;
  onReply?: ((seq: number) => void) | undefined;
  onOpenTask?: ((id: string) => void) | undefined;
  /** Where a remembered note's link leads, as the page wiring builds it. */
  knowledgeHref?: ((n: string) => string) | undefined;
};

/** One row of the feed: the actor and its verb, the text under it, the task badge badge-ghost badge-sm, the ask's
 *  state with its Reply button, and the time at the right. */
export function EventRow({
  event,
  replies,
  taskById,
  now,
  compact = false,
  onReply,
  onOpenTask,
  knowledgeHref,
}: EventRowProps): JSX.Element {
  const view = asVerbEvent(event);
  const v = verb(view);
  const txt = eventText(view);
  const task = taskOf(event, taskById);
  const kb = /^kb:(\d+)$/.exec(event.ref ?? "")?.[1];
  const [hue, ink] = feedTint(event, taskById);
  return (
    <div
      class={`feed-row ${event.from === "owner" ? "mine" : ""} ${event.needs_reply ? "is-ask" : ""}`}
      data-seq={event.seq}
      data-bkey={bkey(event)}
    >
      <span class={`feed-icon ${hue}`} aria-hidden="true">
        <Icon name={v.i} class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-1.5 text-sm">
          <b class={`font-semibold ${ink} ink`}>{who(event.from ?? "")}</b>
          <span class="muted" title={`${event.topic} #${event.seq}`}>
            {linkTask(v.v, taskById, onOpenTask)}
          </span>
        </div>
        {txt ? (
          <div class={`prose-h md mt-0.5 ${event.topic === "kb.added" && kb ? "" : "muted"}`}>
            {event.topic === "kb.added" && kb && knowledgeHref ? (
              <a class="hover:underline" href={knowledgeHref(kb)}>
                <Inline text={txt} />
              </a>
            ) : (
              <Inline text={txt} />
            )}
          </div>
        ) : null}
        <EventFoot
          event={event}
          task={task}
          replies={replies}
          taskById={taskById}
          compact={compact}
          onReply={onReply}
          onOpenTask={onOpenTask}
        />
      </div>
      <span class="ml-auto shrink-0 pl-2 text-xs text-base-content/50 tnum">
        <Time ts={event.ts} now={now} />
      </span>
    </div>
  );
}

/** A run of events that burst together, plus its key ("" where a row stands alone). */
export type EventGroup = { k: string; evs: [FeedEvent, ...FeedEvent[]] };

/** The feed as runs: consecutive events with the same burst key fold into one group. */
export function groups(list: readonly FeedEvent[]): EventGroup[] {
  const out: EventGroup[] = [];
  for (const e of list) {
    const k = bkey(e);
    const g = out.at(-1);
    if (k && g && g.k === k) g.evs.push(e);
    else out.push({ k, evs: [e] });
  }
  return out;
}

/** A burst: a run of task or knowledge updates from one sender, folded into one row that opens
 *  into the events themselves. It keeps the details element open by itself across redraws. */
function Burst({
  evs,
  replies,
  taskById,
  now,
  onReply,
  onOpenTask,
  knowledgeHref,
}: {
  evs: readonly [FeedEvent, ...FeedEvent[]];
} & Omit<EventRowProps, "event" | "compact">): JSX.Element {
  const a = evs[0];
  const fam = familyOf(a.topic);
  const what =
    fam === "kb"
      ? `remembered ${evs.length} things`
      : evs.every((e) => e.topic === "task.created")
        ? `planned ${evs.length} tasks`
        : evs.every((e) => e.topic === "task.status" && dataStr(e, "status") === "done")
          ? `finished ${evs.length} tasks`
          : `updated ${evs.length} tasks`;
  const prev =
    evs
      .slice(0, 4)
      .map((e) => (fam === "kb" ? eventText(asVerbEvent(e)).slice(0, 40) : `${taskOf(e, taskById) ?? ""}`))
      .filter(Boolean)
      .join(", ") + (evs.length > 4 ? "…" : "");
  return (
    <details
      class="feed-burst"
      data-first={a.seq}
      data-bkey={bkey(a)}
      data-seqs={evs.map((e) => e.seq).join(",")}
    >
      <summary>
        <Avatar name={a.from ?? ""} small />
        <span class="shrink-0 text-sm">
          <b class="font-semibold text-base-content">{who(a.from ?? "")}</b>{" "}
          <span class="muted" title={[...new Set(evs.map((e) => e.topic))].join(", ")}>
            {what}
          </span>
        </span>
        <span class="min-w-0 flex-1 truncate text-base-content/50">{prev}</span>
        <span class="ml-auto shrink-0 pl-2 text-xs text-base-content/50 tnum">
          <Time ts={evs.at(-1)?.ts} now={now} />
        </span>
        <Icon name="right" class="chev size-3.5 transition-transform" />
      </summary>
      <div class="border-t hairline bg-base-200/40 pl-6">
        {evs.map((e) => (
          <EventRow
            key={e.seq}
            event={e}
            replies={replies}
            taskById={taskById}
            now={now}
            onReply={onReply}
            onOpenTask={onOpenTask}
            knowledgeHref={knowledgeHref}
          />
        ))}
      </div>
    </details>
  );
}

/** The feed's props: the channel's timeline, the replies per ask, the filters, and where the
 *  clicks go. */
export type TimelineProps = {
  /** The timeline, newest last (the store's; the same list `pass` filters). */
  events: readonly FeedEvent[];
  /** Which names answered which ask: ask seq → the names that replied. */
  replies: ReadonlyMap<number, string[]>;
  now: number;
  filter: TimelineFilter;
  taskById: TaskById;
  onReply?: ((seq: number) => void) | undefined;
  onOpenTask?: ((id: string) => void) | undefined;
  /** Loads the page before the timeline's first event; without it no button shows. */
  onOlder?: (() => void) | undefined;
  /** How many filtered events arrived below the fold; the feed shows an "N new" jump. */
  newCount?: number | undefined;
  /** Where the feed sits as the reader scrolls: at its bottom, or reading back. The page
   *  counts what arrives below the fold and clears the jump when the reader comes home. */
  onAtBottom?: ((at: boolean) => void) | undefined;
  knowledgeHref?: ((n: string) => string) | undefined;
};

/** Is the element within a line of its bottom? */
const atEnd = (el: HTMLElement): boolean => el.scrollTop + el.clientHeight >= el.scrollHeight - 24;

/** The Team feed: the events that pass the filters, bursts folded, the empty state, the
 *  "Show older activity" button at the top and the "N new" jump at the bottom. */
export function Timeline({
  events,
  replies,
  now,
  filter,
  taskById,
  onReply,
  onOpenTask,
  onOlder,
  newCount,
  onAtBottom,
  knowledgeHref,
}: TimelineProps): JSX.Element {
  const feed = useRef<HTMLDivElement | null>(null);
  // where the feed sat at its last scroll: a fresh page of events must not drag the reader
  // down unless they were already reading at the bottom
  const atBottom = useRef(true);
  const list = events.filter((e) => pass(e, filter));
  const showOlder = !!onOlder && (events[0]?.seq ?? 0) > 1;
  const everything = filter.family === "all" && !filter.session;
  const rowProps = { replies, taskById, now, onReply, onOpenTask, knowledgeHref };
  // primitives, not the array: the store appends into the same timeline array in place
  const last = events.at(-1)?.seq ?? 0;
  const count = events.length;
  useEffect(() => {
    const el = feed.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last, count]);
  return (
    <div class="relative">
      <div
        ref={feed}
        class="max-h-[calc(100dvh-300px)] min-h-48 overflow-y-auto"
        id="tl"
        role="log"
        aria-label="Activity"
        tabindex={0}
        onScroll={(e) => {
          atBottom.current = atEnd(e.currentTarget);
          onAtBottom?.(atBottom.current);
        }}
      >
        {showOlder ? (
          <div class="p-2 text-center">
            <button type="button" class="btn btn-ghost btn-sm" id="older" onClick={onOlder}>
              Show older activity
            </button>
          </div>
        ) : null}
        {list.length ? (
          groups(list).map((g) =>
            g.evs.length > 1 ? (
              <Burst key={`b${g.evs[0].seq}`} evs={g.evs} {...rowProps} />
            ) : (
              <EventRow key={`e${g.evs[0].seq}`} event={g.evs[0]} {...rowProps} />
            ),
          )
        ) : (
          <div class="flex flex-col items-center gap-2 px-6 py-12 text-center" data-empty>
            <span class="text-base-content/40">
              <Icon name="activity" class="size-7" />
            </span>
            <b class="text-base">{everything ? "No activity yet" : "Nothing matches"}</b>
            <span class="max-w-sm text-sm muted">
              {everything
                ? "Events show up here the moment a session publishes them."
                : "Pick another filter or Everyone."}
            </span>
          </div>
        )}
      </div>
      {newCount ? (
        <button
          type="button"
          id="tlnew"
          class="btn btn-primary btn-sm absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-2xl"
          aria-label={`${newCount} new events: jump to the latest`}
          onClick={() => {
            // the count clears on the way home even where the smooth scroll fires no events
            atBottom.current = true;
            onAtBottom?.(true);
            feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <Icon name="arrowdown" class="size-3.5" />
          {newCount} new
        </button>
      ) : null}
    </div>
  );
}
