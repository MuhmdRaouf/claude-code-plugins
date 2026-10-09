// Today.tsx — the digest page (extras.js todayView): what each session got done since a window,
// what is blocked now and which questions still wait for an answer, with the estimated cost per
// session when Radar runs. The digest loads from the `digest` op; "Copy as text" refetches it as
// the plain text an agent would see and hands it to the clipboard.

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { useHuddle } from "../app/context.tsx";
import { IntroActions } from "../app/intro.tsx";
import { Icon } from "../icons.tsx";
import { Avatar, Empty, SessionPill, Skeleton, Stat, Time } from "../kit.tsx";
import type { TaskLookup } from "../status.ts";
import { who } from "../status.ts";
import { readPref, type Storage, writePref } from "../storage.ts";
import type { PlanStep, RosterSession } from "../store.ts";
import { usd } from "../store.ts";

/** The windows the "Since" segment offers: the key the op takes and the word the button shows. */
const WINS: readonly (readonly [string, string])[] = [
  ["24h", "24 hours"],
  ["3d", "3 days"],
  ["7d", "7 days"],
];

/** One task a session finished (or skipped) in the window. */
export type DigestDone = { id: string; title?: string | null; status?: string; note?: string };

/** One knowledge entry a session shared in the window. */
export type DigestKnowledge = { id: number; kind?: string | null; title?: string | null };

/** One note a session wrote on a task in the window. */
export type DigestNote = {
  task?: string | null;
  title?: string | null;
  kind?: string | null;
  body?: string | null;
};

/** One approval request a session made in the window. */
export type DigestApproval = { seq: number; labels?: string[] };

/** The digest's per-session row: what that session did, plus its live state and cost. */
export type DigestSession = {
  name: string;
  state?: string | null;
  role?: string | null;
  done: DigestDone[];
  notes: DigestNote[];
  knowledge: DigestKnowledge[];
  approvals: DigestApproval[];
  asked: number;
  events: number;
  cost?: number | null;
};

/** A task that is blocked right now. */
export type DigestBlocked = {
  id: string;
  title?: string | null;
  owner?: string | null;
  note?: string;
  waits_on?: string[] | null;
};

/** A question that still waits for an answer. */
export type DigestQuestion = {
  seq: number;
  from: string;
  to?: string | null;
  msg?: string | null;
  at?: string | null;
};

/** The window's counts. */
export type DigestTotals = {
  done: number;
  notes: number;
  knowledge: number;
  events: number;
  blocked: number;
  questions: number;
};

/** Radar's estimated cost for the window; `available` is false when Radar does not run. */
export type DigestCost = { available: boolean; total?: number | null; range: string };

/** The digest the `digest` op returns (its `result`), for one window. */
export type Digest = {
  since: string;
  totals: DigestTotals;
  sessions: DigestSession[];
  blocked: DigestBlocked[];
  questions: DigestQuestion[];
  cost: DigestCost;
};

/** Looks a task up by id for the links and the pills (the store's board index). */
type ById = (id: string) => PlanStep | null | undefined;

/** The task link of a digest row: its id, then the title the board knows, then nothing. */
function TaskLink({
  id,
  title,
  byId,
  href,
}: {
  id: string;
  title?: string | null | undefined;
  byId: ById;
  href: string;
}) {
  return (
    <a class="inline-flex min-w-0 max-w-full items-center gap-1.5 hover:underline" href={href}>
      <span class="badge badge-ghost badge-sm font-mono">{id}</span>
      <span class="truncate">{title || byId(id)?.title || ""}</span>
    </a>
  );
}

/** One titled group of a session card, or nothing when it has no rows. */
function List({ title, rows }: { title: string; rows: JSX.Element[] }): JSX.Element | null {
  if (!rows.length) return null;
  return (
    <div class="flex flex-col gap-1.5">
      <h4 class="text-xs font-medium text-base-content/50">{title}</h4>
      <ul class="flex flex-col gap-1.5 text-sm">{rows}</ul>
    </div>
  );
}

/** The work page of a channel for one task id. */
const taskHref = (api: Api, ch: string, id: string): string =>
  api.channelHref(ch, `/work?t=${encodeURIComponent(id)}`);

/** What the session finished (or skipped) in the window. */
function FinishedList({
  s,
  byId,
  ch,
  api,
}: {
  s: DigestSession;
  byId: ById;
  ch: string;
  api: Api;
}): JSX.Element | null {
  const rows = s.done.map((d) => (
    <li key={d.id} class="flex min-w-0 items-start gap-2">
      <span class="mt-0.5 text-success">
        <Icon name={d.status === "skipped" ? "minusc" : "checkc"} class="size-4" />
      </span>
      <span class="min-w-0 flex-1">
        <TaskLink id={d.id} title={d.title} byId={byId} href={taskHref(api, ch, d.id)} />
        {d.note ? (
          <span class="block truncate text-xs muted" title={d.note}>
            {d.note}
          </span>
        ) : null}
      </span>
    </li>
  ));
  return <List title="Finished" rows={rows} />;
}

/** What the session shared as knowledge. */
function SharedList({ s, ch, api }: { s: DigestSession; ch: string; api: Api }): JSX.Element | null {
  const rows = s.knowledge.map((k) => (
    <li key={k.id} class="flex min-w-0 items-center gap-2">
      <span class="text-base-content/50">
        <Icon name="book" class="size-4" />
      </span>
      <a class="truncate hover:underline" href={api.channelHref(ch, `/knowledge/${k.id}`)}>
        {k.title || `#${k.id}`}
      </a>
      <span class="badge badge-ghost badge-sm c-lavender">{k.kind || ""}</span>
    </li>
  ));
  return <List title="Knowledge shared" rows={rows} />;
}

/** The notes the session wrote: the first six, then a count of the rest. */
function NoteList({
  s,
  byId,
  ch,
  api,
}: {
  s: DigestSession;
  byId: ById;
  ch: string;
  api: Api;
}): JSX.Element | null {
  const rows = s.notes.slice(0, 6).map((n, i) => (
    <li key={i} class="flex min-w-0 items-start gap-2">
      <span class="mt-0.5 text-base-content/50">
        <Icon name="note" class="size-4" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="text-xs muted">{n.kind} on </span>
        {n.task ? (
          <TaskLink id={n.task} title={n.title} byId={byId} href={taskHref(api, ch, n.task)} />
        ) : null}
        <span class="block truncate text-xs muted">{n.body}</span>
      </span>
    </li>
  ));
  if (s.notes.length > 6)
    rows.push(
      <li key="more" class="text-xs muted">
        and {s.notes.length - 6} more
      </li>,
    );
  return <List title="Notes" rows={rows} />;
}

/** The permission the session asked for: how often, and which labels. */
function ApprovalList({ s }: { s: DigestSession }): JSX.Element | null {
  const rows =
    s.approvals.length > 0
      ? [
          <li key="asked" class="flex items-center gap-2">
            <span class="text-base-content/50">
              <Icon name="key" class="size-4" />
            </span>
            {`${s.approvals.length}× · ${[...new Set(s.approvals.flatMap((a) => a.labels ?? []))].join(", ")}`}
          </li>,
        ]
      : [];
  return <List title="Asked for permission" rows={rows} />;
}

/** A session's card: its name and live pill, then what it finished, shared, noted and asked. */
function SessionCard({
  s,
  roster,
  byId,
  ch,
  api,
  now,
}: {
  s: DigestSession;
  roster: RosterSession[];
  byId: ById;
  ch: string;
  api: Api;
  now: number;
}) {
  const live = roster.find((x) => x.name === s.name);
  const taskById: TaskLookup = (id) => {
    const t = byId(id);
    return t?.status ? { status: t.status, blocked_by: t.blocked_by } : null;
  };
  const sections = [
    <FinishedList key="f" s={s} byId={byId} ch={ch} api={api} />,
    <SharedList key="k" s={s} ch={ch} api={api} />,
    <NoteList key="n" s={s} byId={byId} ch={ch} api={api} />,
    <ApprovalList key="a" s={s} />,
  ];
  const empty = !s.done.length && !s.knowledge.length && !s.notes.length && !s.approvals.length;
  return (
    <Panel
      label={s.name === "owner" ? "You" : s.name}
      icon={<Avatar name={s.name} />}
      title={
        s.name === "owner" ? (
          "You"
        ) : (
          <a class="hover:underline" href={api.channelHref(ch, `/team?s=${encodeURIComponent(s.name)}`)}>
            {s.name}
          </a>
        )
      }
      meta={<SessionMeta s={s} />}
      actions={
        <>
          {s.cost != null ? (
            <span class="badge badge-ghost badge-sm c-info" title="Estimated cost, from Radar">
              {usd(s.cost)}
            </span>
          ) : null}
          {live ? <SessionPill session={live} taskById={taskById} now={now} small={true} /> : null}
        </>
      }
    >
      <div class="flex flex-1 flex-col gap-4">
        {empty ? <p class="text-sm muted">Nothing finished or shared in this window.</p> : sections}
      </div>
    </Panel>
  );
}

/** The "Blocked now" card: each blocked task, its owner, its note and what it waits on. */
function BlockedCard({ d, byId, ch, api }: { d: Digest; byId: ById; ch: string; api: Api }) {
  return (
    <Panel
      title="Blocked now"
      label="Blocked now"
      meta={<span class="tabular-nums">{d.blocked.length}</span>}
      flush={true}
    >
      {d.blocked.length ? (
        <ul class="flex flex-col divide-y divide-base-content/10">
          {d.blocked.map((b) => (
            <li key={b.id} class="flex flex-col gap-1 px-5 py-3 text-sm">
              <TaskLink
                id={b.id}
                title={b.title}
                byId={byId}
                href={api.channelHref(ch, `/work?t=${encodeURIComponent(b.id)}`)}
              />
              <span class="text-xs muted">
                {b.owner ? who(b.owner) : "Nobody owns it"}
                {b.note ? ` · “${b.note}”` : ""}
                {b.waits_on?.length ? ` · waits on ${b.waits_on.join(", ")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div class="p-5">
          <Empty text="Nothing is blocked" />
        </div>
      )}
    </Panel>
  );
}

/** The "Open questions" card: who asked whom, when, and the question itself. */
function QuestionsCard({ d, ch, api, now }: { d: Digest; ch: string; api: Api; now: number }) {
  const answerable = d.questions.some((q) => !q.to || q.to === "owner");
  return (
    <Panel
      title="Open questions"
      label="Open questions"
      actions={
        answerable ? (
          <a class="btn btn-ghost btn-sm" href={api.channelHref(ch, "/inbox")}>
            Answer in Inbox
          </a>
        ) : null
      }
      flush={true}
    >
      {d.questions.length ? (
        <ul class="flex flex-col divide-y divide-base-content/10">
          {d.questions.map((q) => (
            <li key={q.seq} class="flex items-start gap-3 px-5 py-3 text-sm">
              <Avatar name={q.from} small={true} />
              <div class="min-w-0 flex-1">
                <div class="text-xs muted">
                  <b class="text-base-content">{q.from}</b> → {q.to ? who(q.to) : "everyone"} ·{" "}
                  <Time ts={q.at} now={now} />
                </div>
                <p class="line-clamp-2">{q.msg}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div class="p-5">
          <Empty text="No open questions" />
        </div>
      )}
    </Panel>
  );
}

/** The digest itself: the stat cards, the per-session cards, and the blocked and question cards. */
function DigestView({ d, ch, now }: { d: Digest; ch: string; now: number }) {
  const { state, api } = useHuddle();
  const byId: ById = (id) => state.byId.get(id);
  const T = d.totals;
  const c = d.cost;
  return (
    <div class="flex flex-col gap-5">
      <div
        class={`grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 xl:grid-cols-4${c.available ? " xl:grid-cols-5" : ""}`}
      >
        <Stat
          icon="checkc"
          tint="c-good"
          label="Tasks finished"
          value={T.done}
          sub={`${T.events} events since ${new Date(d.since).toLocaleString([], {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}`}
        />
        <Stat
          icon="book"
          tint="c-info"
          label="Knowledge added"
          value={T.knowledge}
          sub={`${T.notes} note${T.notes === 1 ? "" : "s"} on tasks`}
        />
        <Stat
          icon="ban"
          tint="c-red"
          label="Blocked now"
          value={T.blocked}
          sub={T.blocked ? "Need a hand" : "Nothing stuck"}
        />
        <Stat
          icon="ask"
          tint="c-mauve"
          label="Open questions"
          value={T.questions}
          sub={T.questions ? "Waiting for an answer" : "All answered"}
        />
        {c.available ? <CostStat total={c.total ?? null} range={c.range} /> : null}
      </div>
      {d.sessions.length ? (
        <section aria-labelledby="dgs-h" class="flex flex-col gap-3">
          <h2 class="text-sm font-semibold px-1" id="dgs-h">
            By session
          </h2>
          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {d.sessions.map((s) => (
              <SessionCard
                key={s.name}
                s={s}
                roster={state.sessions?.sessions ?? []}
                byId={byId}
                ch={ch}
                api={api}
                now={now}
              />
            ))}
          </div>
        </section>
      ) : (
        <Empty
          text="No activity in this window"
          hint="Sessions show up here once they join and work."
          icon="users"
        />
      )}
      <div class="grid gap-4 lg:grid-cols-2">
        <BlockedCard d={d} byId={byId} ch={ch} api={api} />
        <QuestionsCard d={d} ch={ch} api={api} now={now} />
      </div>
    </div>
  );
}

/** Radar's estimated-cost stat: its mark is a dollar sign, not an icon. */
function CostStat({ total, range }: { total: number | null; range: string }) {
  return (
    <div class="stat panel px-4 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-sm font-medium muted min-w-0 flex-1 truncate">Estimated cost</span>
        <span class="tinted ink inline-flex size-7 shrink-0 items-center justify-center rounded-lg c-blue">
          <span class="text-xs font-bold">$</span>
        </span>
      </div>
      <p class="text-[28px] leading-tight font-semibold text-base-content tnum">{usd(total || 0)}</p>
      <p class="text-xs muted">{`This ${range}, from Radar`}</p>
    </div>
  );
}

/** The "Since" segment: the window the digest covers, one pressed button per choice. */
function SinceSegment({ win, pick }: { win: string; pick: (k: string) => void }): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the legacy segment's markup, kept word for word
    <div class="join join-sm" role="group" aria-label="Since">
      {WINS.map(([k, l]) => (
        <button
          type="button"
          key={k}
          class={`btn join-item btn-sm${k === win ? " btn-primary" : ""}`}
          data-dgwin={k}
          aria-pressed={k === win}
          onClick={() => pick(k)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** The line under a card's name: its role, then how much it did and asked. */
function SessionMeta({ s }: { s: DigestSession }): JSX.Element {
  return (
    <p class="truncate text-xs muted">
      {s.role || (s.state === "left" ? "left the channel" : "")}
      {s.events ? `${s.role ? " · " : ""}${s.events} event${s.events === 1 ? "" : "s"}` : ""}
      {s.asked ? ` · ${s.asked} open question${s.asked === 1 ? "" : "s"}` : ""}
    </p>
  );
}

/** The Today page: the "Since" segment, the "Copy as text" button and the digest body. */
export function Today({ prefs = localStorage }: { prefs?: Storage | undefined } = {}): JSX.Element | null {
  const { state, api, now, copy } = useHuddle();
  const ch = state.ch;
  const [win, setWin] = useState<string>(() => readPref(prefs, ch ? `dgwin:${ch}` : "dgwin", "24h"));
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  // a new channel starts from the window this browser kept for it (Overview's ovwin reset)
  useEffect(() => {
    setWin(readPref(prefs, ch ? `dgwin:${ch}` : "dgwin", "24h"));
  }, [prefs, ch]);
  useEffect(() => {
    if (!ch) return undefined;
    let alive = true;
    api
      .op(ch, "digest", { since: win, json: true })
      .then((r) => {
        if (!alive) return;
        setError("");
        setLoaded(true);
        setDigest((r as { result?: Digest | null }).result ?? null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoaded(true);
        setDigest(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [api, ch, win]);
  if (!ch) return null;
  const pick = (k: string): void => {
    writePref(prefs, `dgwin:${ch}`, k);
    setWin(k);
  };
  const copyDigest = (): void => {
    api
      .op(ch, "digest", { since: win })
      .then((t) => {
        const text = (t as { text?: string | null }).text;
        if (text) copy(text, "Copied the digest");
      })
      .catch(() => {});
  };
  return (
    <div class="flex min-w-0 flex-col gap-5" id="dgwrap">
      <IntroActions>
        <SinceSegment win={win} pick={pick} />
        <button type="button" class="btn" id="dgcopy" onClick={copyDigest}>
          <Icon name="copy" class="size-4" /> Copy as text
        </button>
      </IntroActions>
      <div id="dgbody">
        {error ? (
          <div class="alert alert-error alert-soft" role="alert">
            <Icon name="alert" class="size-5 shrink-0" />
            <span>
              <b class="font-semibold">The digest did not load</b> <span class="muted">{error}</span>
            </span>
          </div>
        ) : !loaded ? (
          <Skeleton />
        ) : digest ? (
          <DigestView d={digest} ch={ch} now={now} />
        ) : (
          <Empty text="Nothing to show" icon="clock" />
        )}
      </div>
    </div>
  );
}
