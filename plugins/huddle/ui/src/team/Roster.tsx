// Roster.tsx — the Team page's roster: the turn banner, one row per session with what it is
// doing right now (its step's id and title, its own words, or its role), its unread and open-ask
// counts and its cost, subagents nested under their parent, the empty state before anyone joins,
// and the sessions that left at the end.

import type { ComponentChildren } from "preact";
import { Fragment, type JSX } from "preact";
import { Icon } from "../icons.tsx";
import { Avatar, SessionPill } from "../kit.tsx";
import { SSTM, sessionStatus, type Task } from "../status.ts";
import type { PlanStep, RosterSession } from "../store.ts";
import { usd } from "../store.ts";

/** Looks a task up by id: the doing line reads its id and title, the pill its status model. */
export type RosterTaskById = (id: string) => PlanStep | null | undefined;

/** The status model's view of a step: a missing step is null, a missing status is "to do". */
const asTask = (step: PlanStep | null | undefined): Task | null =>
  step ? { status: step.status ?? "todo", blocked_by: step.blocked_by } : null;

/** The roster's props: the sessions as GET /sessions returned them, and how to open one. */
export type RosterProps = {
  sessions: readonly RosterSession[];
  taskById: RosterTaskById;
  now: number;
  /** The name of the session that plans and assigns the work, when the channel has one. */
  orchestrator?: string | null | undefined;
  /** A session's estimated cost today, from Radar; without a figure its row shows no chip. */
  costOf?: ((name: string) => number | undefined) | undefined;
  /** Opens a session: a click, or Enter or Space, on its row. */
  onOpen: (name: string) => void;
  /** The turn as the banner shows it: a holder's name, or null when the channel starts with the
   *  turn and nobody holds it yet; leave it out for a channel without turn-taking. */
  turnHolder?: string | null | undefined;
  /** The session whose drawer is open; its row is highlighted. */
  activeName?: string | null | undefined;
  /** Where "Connect a session" leads in the empty roster; the page wiring knows the channel. */
  connectHref?: string | undefined;
};

/** How many roster sessions are still in the channel: the count beside the "Sessions" label. */
export function onlineCount(sessions: readonly RosterSession[]): number {
  return sessions.filter((s) => s.state !== "left").length;
}

/** What a session is doing: its step's id and title, its own words, or its role. */
function doing(session: RosterSession, taskById: RosterTaskById): ComponentChildren {
  const step = session.step ? taskById(session.step) : null;
  if (step)
    return (
      <>
        <span class="badge badge-ghost badge-sm font-mono tnum">{step.id}</span>
        <span class="truncate">{step.title}</span>
      </>
    );
  const own = /^(joined|resumed|left)$/.test(String(session.task ?? "").trim())
    ? ""
    : String(session.task ?? "").trim();
  if (own) return <span class="truncate">{own}</span>;
  return <span class="truncate text-base-content/50">{session.role || "No task yet"}</span>;
}

/** The orchestrator chip on a session whose name is the channel's orchestrator. */
function orchMark(name: string, orchestrator: string | null | undefined): JSX.Element | null {
  if (name !== orchestrator) return null;
  return (
    <span
      class="badge badge-ghost badge-sm c-lavender ink gap-1"
      title="Orchestrator: plans and assigns the work"
    >
      <Icon name="baton" class="size-3.5" />
      orchestrator
    </span>
  );
}

/** One count of a row: the number over its word. */
function Count({ n, label, title }: { n: number; label: string; title: string }): JSX.Element {
  return (
    <span class="flex items-baseline gap-1 text-xs muted" title={title}>
      <span class="font-semibold text-base-content tabular-nums">{n}</span>
      {label}
    </span>
  );
}

/** A session's estimated cost today, from Radar: a count-like stat. */
function CostChip({ cost }: { cost: number }): JSX.Element {
  return (
    <span class="flex items-baseline gap-1 text-xs muted" title="Estimated cost today, from Radar">
      <span class="font-semibold text-base-content tabular-nums">{usd(cost)}</span>today
    </span>
  );
}

/** A row's counts: unread and open asks, plus the cost chip for top-level sessions. The
 *  whole line hides when everything in it is zero. */
function RowCounts({
  session,
  kid,
  costOf,
}: {
  session: RosterSession;
  kid: boolean;
  costOf: ((name: string) => number | undefined) | undefined;
}): JSX.Element | null {
  const shown: JSX.Element[] = [];
  if (session.unread)
    shown.push(
      <Count n={session.unread} label="unread" title={`${session.unread} events it has not read yet`} />,
    );
  if (session.open)
    shown.push(<Count n={session.open} label="asks" title={`${session.open} open questions for it`} />);
  const figure = kid ? undefined : costOf?.(session.name);
  if (figure != null) shown.push(<CostChip cost={figure} />);
  if (!shown.length) return null;
  return <span class="mt-1.5 flex items-center gap-4">{shown}</span>;
}

/** One roster row: the avatar, the name with its marks, what it is doing, its counts, its pill.
 *  A button, so click and Enter and Space all open the session. */
function RosterRow({
  session,
  kid,
  taskById,
  now,
  orchestrator,
  costOf,
  active,
  onOpen,
}: {
  session: RosterSession;
  kid: boolean;
  taskById: RosterTaskById;
  now: number;
  orchestrator: string | null | undefined;
  costOf: ((name: string) => number | undefined) | undefined;
  active: boolean;
  onOpen: (name: string) => void;
}): JSX.Element {
  const status = sessionStatus(session, (id) => asTask(taskById(id)));
  const label = `${session.name}, ${SSTM[status].l}${session.name === orchestrator ? ", orchestrator" : ""}${session.holds_turn ? ", holds the turn" : ""}`;
  return (
    <li class="list-row">
      <button
        type="button"
        class={`flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-base-200/70 ${kid ? "gap-2.5" : ""}${active ? " bg-primary/10" : ""}`}
        aria-label={label}
        aria-pressed={active}
        onClick={() => onOpen(session.name)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(session.name);
          }
        }}
      >
        <Avatar name={session.name} small={kid} />
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <b class="truncate text-[0.9375rem] font-semibold">
              {kid ? session.name.split(".").slice(1).join(".") : session.name}
            </b>
            {orchMark(session.name, orchestrator)}
            {session.holds_turn ? (
              <span class="text-base-content/50" title="Holds the turn">
                <Icon name="turn" class="size-4" />
              </span>
            ) : null}
          </span>
          <span class="mt-1 flex min-w-0 items-center gap-1.5 text-sm muted">{doing(session, taskById)}</span>
          <RowCounts session={session} kid={kid} costOf={costOf} />
        </span>
        <SessionPill session={session} taskById={(id) => asTask(taskById(id))} now={now} small={kid} />
      </button>
    </li>
  );
}

/** The turn banner: who holds the turn, or that nobody does when the channel starts with one. */
function TurnBanner({ holder }: { holder: string | null }): JSX.Element {
  return (
    <p class="flex items-center gap-2 border-b border-base-content/8 px-4 py-3 text-sm muted">
      <Icon name="turn" class="size-4 text-base-content/50" />
      {holder ? (
        <span>
          <b class="text-base-content">{holder}</b> holds the turn: only it acts.
        </span>
      ) : (
        "Nobody holds the turn."
      )}
    </p>
  );
}

/** The empty roster: nobody has joined yet, and the way to connect the first session. */
function RosterEmpty({ connectHref }: { connectHref: string | undefined }): JSX.Element {
  return (
    <div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span class="text-base-content/40">
        <Icon name="users" class="size-7" />
      </span>
      <b class="text-base">Nobody has joined yet</b>
      <span class="text-sm">Connect a session to this channel in Settings.</span>
      <span class="max-w-sm text-sm muted">It shows up here the moment it joins.</span>
      {connectHref ? (
        <a class="btn btn-sm mt-2" href={connectHref}>
          <Icon name="plug" class="size-4" />
          Connect a session
        </a>
      ) : null}
    </div>
  );
}

/** The sessions that left, folded into one "N left" row. */
function RosterLeft({
  off,
  row,
}: {
  off: readonly RosterSession[];
  row: (s: RosterSession, kid: boolean) => JSX.Element;
}): JSX.Element | null {
  if (!off.length) return null;
  return (
    <details class="collapse collapse-arrow border-t border-base-content/8 rounded-none">
      <summary class="collapse-title min-h-10 py-2 text-sm muted">
        <span class="flex items-center gap-1">{off.length} left</span>
      </summary>
      <div class="collapse-content p-2 opacity-80">
        <ul class="list">{off.map((s) => row(s, false))}</ul>
      </div>
    </details>
  );
}

/** The Team roster: the turn banner, the sessions that are in with their subagents nested under
 *  them, the empty state before anyone joins, and the sessions that left at the end. */
export function Roster({
  sessions,
  taskById,
  now,
  orchestrator,
  costOf,
  onOpen,
  turnHolder,
  activeName,
  connectHref,
}: RosterProps): JSX.Element {
  const names = new Set(sessions.map((s) => s.name));
  const tops = sessions.filter((s) => !s.parent || !names.has(s.parent));
  const kids = (n: string): RosterSession[] => sessions.filter((s) => s.parent === n && s.state !== "left");
  const on = tops.filter((s) => s.state !== "left");
  const off = tops.filter((s) => s.state === "left");
  const row = (s: RosterSession, kid: boolean): JSX.Element => (
    <RosterRow
      key={s.name}
      session={s}
      kid={kid}
      taskById={taskById}
      now={now}
      orchestrator={orchestrator}
      costOf={costOf}
      active={activeName === s.name}
      onOpen={onOpen}
    />
  );
  return (
    <>
      {turnHolder !== undefined ? <TurnBanner holder={turnHolder} /> : null}
      {on.length ? (
        <ul class="list p-2">
          {on.map((s) => (
            <Fragment key={s.name}>
              {row(s, false)}
              {kids(s.name).length ? (
                <li class="list-row">
                  <ul
                    class="ml-6 flex flex-col border-l border-base-content/10 py-0.5 pl-2"
                    aria-label={`Subagents of ${s.name}`}
                  >
                    {kids(s.name).map((k) => row(k, true))}
                  </ul>
                </li>
              ) : null}
            </Fragment>
          ))}
        </ul>
      ) : (
        <div class="p-2">
          <RosterEmpty connectHref={connectHref} />
        </div>
      )}
      <RosterLeft off={off} row={row} />
    </>
  );
}
