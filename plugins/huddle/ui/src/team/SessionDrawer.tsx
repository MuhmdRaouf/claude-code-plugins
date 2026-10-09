// SessionDrawer.tsx — the session drawer: the shared SlideOver the router's ?s=<name> opens from
// every session link (the roster rows, the Inbox cards, the Work map, the palette), mounted next
// to the task drawer over every destination. It shows the session's name, role and derived
// status, its current task, its cost when Radar runs, the events it sent, received or its
// subagents sent (newest first, live with the store), the composer fixed to it (Composer's own
// home), and pause/resume when the roster holds the session. The task drawer wins when the
// address names both a task and a session; the shell drops ?s= from the hash on close.

import { SlideOver } from "@muhmdraouf/ui/slide-over.tsx";
import type { ToastFn } from "@muhmdraouf/ui/toast.tsx";
import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { useHuddle } from "../app/context.tsx";
import type { ComposeSent } from "../compose/Composer.tsx";
import { Composer } from "../compose/Composer.tsx";
import { Icon } from "../icons.tsx";
import { Avatar, SessionPill } from "../kit.tsx";
import { sessionStatus, sessionWhy, type Task } from "../status.ts";
import type { Board, FeedEvent, PlanStep, RosterSession, SessionList } from "../store.ts";
import { usd } from "../store.ts";
import { EventRow, pass } from "./Timeline.tsx";

/** Looks a plan task up by id: the raw step, or null. */
export type StepLookup = (id: string) => PlanStep | null | undefined;

/** The status model's view of a step: a missing step is null, a missing status is "to do". */
const asTask = (s: PlanStep | null | undefined): Task | null =>
  s ? { status: s.status ?? "todo", blocked_by: s.blocked_by } : null;

/** The drawer's props: the open session's name (?s=), the channel's data, and the ways out. */
export type SessionDrawerProps = {
  /** The session the address names; null closes the drawer. */
  name: string | null | undefined;
  /** The open channel; without one nothing shows. */
  ch: string | null;
  api: Api;
  /** This paint's time, for everything relative. */
  now: number;
  /** The roster, for the session's row, its support of pause and the composer. */
  sessions: SessionList | null;
  /** The plan, for the composer's task pickers. */
  board: Board | null;
  /** Looks a plan task up by id, for the status and the feed's badges. */
  byId: StepLookup;
  /** The channel's timeline (newest last); the drawer shows the session's part of it. */
  timeline: readonly FeedEvent[] | null;
  /** Which names answered which ask, for the feed's ask pills. */
  replies: ReadonlyMap<number, string[]>;
  /** The session's estimated cost today, from Radar; without a figure no row shows. */
  costOf?: ((name: string) => number | undefined) | undefined;
  toast: ToastFn;
  /** Called once a composer send landed, so the shell refills what shows it. */
  onSent: ComposeSent;
  /** Opens a task the feed names. */
  onOpenTask: (id: string) => void;
  /** Closes the drawer: the shell drops ?s= from the address. */
  onClose: () => void;
};

/** The session of the roster the drawer names, or undefined when the roster lost it. */
export function drawerSession(
  sessions: SessionList | null | undefined,
  name: string | null | undefined,
): RosterSession | undefined {
  return name ? (sessions?.sessions ?? []).find((s) => s.name === name) : undefined;
}

/** The session's own events: what it sent, received, or its subagents sent, newest first. */
export function sessionEvents(timeline: readonly FeedEvent[] | null | undefined, name: string): FeedEvent[] {
  return (timeline ?? [])
    .filter((e) => pass(e, { family: "all", session: name }))
    .slice(-80)
    .reverse();
}

/** A plan task as the feed's badge row reads it: the id with its title. */
function TaskLine({
  step,
  own,
  onOpenTask,
}: {
  step: PlanStep | null | undefined;
  own: string | undefined;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  if (step)
    return (
      <button
        type="button"
        class="badge badge-ghost gap-1.5 hover:underline"
        onClick={() => onOpenTask(step.id)}
      >
        <span class="font-mono tnum">{step.id}</span>
        <span class="max-w-64 truncate">{step.title}</span>
      </button>
    );
  return <span>{own || "No task yet"}</span>;
}

/** One labelled fact of the drawer's head card. */
function Fact({ label, children }: { label: string; children: ComponentChildren }): JSX.Element {
  return (
    <>
      <span class="text-sm font-medium muted">{label}</span>
      <span class="min-w-0 text-sm">{children}</span>
    </>
  );
}

/** The drawer's facts card: the derived status, the current task, Radar's cost when it runs. */
function FactsCard({
  session,
  status,
  why,
  step,
  cost,
  onOpenTask,
}: {
  session: RosterSession | undefined;
  status: ReturnType<typeof sessionStatus>;
  why: string;
  step: PlanStep | null | undefined;
  cost: number | undefined;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  return (
    <div
      class="grid gap-x-4 gap-y-2 rounded-box border border-base-content/10 p-4 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center"
      data-sess-facts
    >
      <Fact label="Status">
        <span title={why}>{session ? status : "Unknown"}</span>
        {session ? null : <span class="muted"> · not in the roster right now</span>}
      </Fact>
      <Fact label="Now">
        <TaskLine step={step} own={session?.task} onOpenTask={onOpenTask} />
      </Fact>
      {cost != null ? (
        <Fact label="Cost today">
          <span class="tnum">{usd(cost)}</span> <span class="muted">from Radar</span>
        </Fact>
      ) : null}
    </div>
  );
}

/** A panel head: its icon and title, with an optional count at the right. */
function PanelHead({
  icon,
  title,
  n,
}: {
  icon: "activity" | "msg";
  title: string;
  n?: number | undefined;
}): JSX.Element {
  return (
    <div class="flex flex-wrap items-center gap-2 border-b border-base-content/8 px-4 py-2.5">
      <h3 class="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
        <span class="text-primary">
          <Icon name={icon} class="size-4.5" />
        </span>
        {title}
      </h3>
      {n ? <span class="badge badge-ghost badge-sm tnum">{n}</span> : null}
    </div>
  );
}

/** The drawer's events panel: the session's part of the timeline, newest first. */
function EventsPanel({
  name,
  evs,
  replies,
  byId,
  now,
  onOpenTask,
  knowledgeHref,
}: {
  name: string;
  evs: readonly FeedEvent[];
  replies: ReadonlyMap<number, string[]>;
  byId: StepLookup;
  now: number;
  onOpenTask: (id: string) => void;
  knowledgeHref: (n: string) => string;
}): JSX.Element {
  return (
    <section class="panel min-w-0" aria-label={`Recent activity of ${name}`} data-sess-events>
      <PanelHead icon="activity" title="Recent activity" n={evs.length || undefined} />
      <div class="max-h-72 overflow-y-auto p-2" role="log" aria-label={`Events of ${name}`}>
        {evs.length ? (
          evs.map((e) => (
            <EventRow
              key={e.seq}
              event={e}
              replies={replies}
              taskById={byId}
              now={now}
              compact
              onOpenTask={onOpenTask}
              knowledgeHref={knowledgeHref}
            />
          ))
        ) : (
          <p class="px-4 py-6 text-center text-sm muted">Nothing from this session yet.</p>
        )}
      </div>
    </section>
  );
}

/** The slide-over's head: the avatar, the name, the status pill, Radar's cost, the role. */
function DrawerHead({
  name,
  session,
  taskById,
  now,
  cost,
}: {
  name: string;
  session: RosterSession | undefined;
  taskById: (id: string) => Task | null;
  now: number;
  cost: number | undefined;
}): JSX.Element {
  return (
    <div class="flex min-w-0 flex-col gap-1.5">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Avatar name={name} />
        <h2 class="min-w-0 truncate text-xl font-semibold" data-sess-name>
          {name}
        </h2>
        {session ? <SessionPill session={session} taskById={taskById} now={now} /> : null}
        {cost != null ? (
          <span class="badge badge-ghost badge-sm tnum" title="Estimated cost today, from Radar">
            {usd(cost)} today
          </span>
        ) : null}
      </div>
      <p class="min-w-0 truncate text-sm muted">{session?.role || "A session of this channel"}</p>
    </div>
  );
}

/** The pause/resume button in the slide-over's actions slot; nothing for a session that left. */
function ControlButton({
  name,
  paused,
  busy,
  onControl,
}: {
  name: string;
  paused: boolean;
  busy: boolean;
  onControl: () => void;
}): JSX.Element | null {
  return (
    <button type="button" class="btn" data-scontrol disabled={busy} onClick={onControl}>
      <Icon name={paused ? "play" : "pause"} class="size-4.5" />
      {paused ? `Resume ${name}` : `Pause ${name}`}
    </button>
  );
}

/** The session drawer over ?s=<name>; nothing without a name or a channel. */
export function SessionDrawer(props: SessionDrawerProps): JSX.Element | null {
  const { name, ch, api, now, sessions, board, byId, timeline, replies, costOf, toast } = props;
  const { act } = useHuddle();
  const [busy, setBusy] = useState(false);
  if (!name || !ch) return null;
  const session = drawerSession(sessions, name);
  const taskById = (id: string) => asTask(byId(id));
  const cost = costOf?.(name);
  const paused = session?.control === "pause";
  const canControl = !!session && session.state !== "left";

  const control = (): void => {
    setBusy(true);
    act(paused ? "resume" : "pause", { target: name })
      .then((r) => {
        setBusy(false);
        if (r !== null) toast(paused ? `${name} resumed` : `${name} paused`);
      })
      .catch(() => setBusy(false));
  };

  return (
    <SlideOver
      open
      onClose={props.onClose}
      label={`Session ${name}`}
      width="w-[min(42rem,94vw)]"
      header={<DrawerHead name={name} session={session} taskById={taskById} now={now} cost={cost} />}
      actions={
        canControl ? <ControlButton name={name} paused={paused} busy={busy} onControl={control} /> : null
      }
    >
      <div id="sdrawer" class="flex min-w-0 flex-col gap-5">
        <FactsCard
          session={session}
          status={sessionStatus(session, taskById)}
          why={sessionWhy(session, taskById, now)}
          step={session?.step ? byId(session.step) : null}
          cost={cost}
          onOpenTask={props.onOpenTask}
        />
        <EventsPanel
          name={name}
          evs={sessionEvents(timeline, name)}
          replies={replies}
          byId={byId}
          now={now}
          onOpenTask={props.onOpenTask}
          knowledgeHref={(n: string) => api.channelHref(ch, `/knowledge/${n}`)}
        />
        <section class="panel min-w-0" aria-label={`Message ${name}`}>
          <PanelHead icon="msg" title={`Write to ${name}`} />
          <div class="p-4">
            <Composer
              ch={ch}
              place={`s:${name}`}
              sessions={sessions?.sessions ?? []}
              board={board}
              byId={byId}
              api={api}
              onSent={props.onSent}
              toast={toast}
              timeline={timeline}
              to={name}
            />
          </div>
        </section>
      </div>
    </SlideOver>
  );
}
