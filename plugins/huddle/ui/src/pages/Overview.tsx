// Overview.tsx — the channel at a glance: what needs the owner, the plan's progress ring and its
// per-state breakdown, the stat cards (sessions, questions, knowledge, events), Radar's estimated
// cost, the files two sessions are both editing, and the activity chart over the timeline the
// channel already loaded, binned per minute in one of three windows. Port of app.js
// ovVals/ovSub/ovTexts/ovRows/ovNeeds/ovTopHTML/ovSeries/overviewView and conflicts.js.

import { AreaChart } from "@muhmdraouf/ui/area-chart.tsx";
import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { useHuddle } from "../app/context.tsx";
import { IntroActions } from "../app/intro.tsx";
import { Icon } from "../icons.tsx";
import { Avatar, Empty, Stat, Time } from "../kit.tsx";
import { Ring } from "../progress.tsx";
import { FIN, type Task, type TaskState, taskState } from "../status.ts";
import { readPref, type Storage, writePref } from "../storage.ts";
import {
  type FeedEvent,
  type HuddleState,
  type HuddleStore,
  type PlanStep,
  type Radar,
  usd,
} from "../store.ts";
import { extrasNeedsText, inboxCountOf } from "./Inbox.tsx";

/** The activity windows the segment offers: the key, the word (app.js OVV keys). */
export const OV_WINS: readonly (readonly [Win, string])[] = [
  ["15m", "15 min"],
  ["1h", "1 hour"],
  ["24h", "24 hours"],
];

/** One activity window. */
export type Win = "15m" | "1h" | "24h";

/** Window → [its span in minutes, its bin count] (app.js OVV). */
const OV_BINS: Record<Win, readonly [number, number]> = {
  "15m": [15, 15],
  "1h": [60, 12],
  "24h": [1440, 24],
};

/** The status model's view of a board step: a missing status reads as "to do". */
const asTask = (s: PlanStep): Task => ({
  status: s.status ?? "todo",
  ...(s.blocked_by ? { blocked_by: s.blocked_by } : {}),
});

/** The numbers the Overview shows, all read from one state snapshot (app.js ovVals). */
export type OverviewValues = {
  done: number;
  total: number;
  phases: number;
  pct: number;
  live: number;
  tops: number;
  doing: number;
  waiting: number;
  blocked: number;
  todo: number;
  asks: number;
  kb: number;
  ev: number;
};

/** The Overview's numbers over one state snapshot (app.js ovVals). */
export function ovVals(state: HuddleState): OverviewValues {
  const steps = state.board?.steps ?? [];
  const fin = steps.filter((s) => FIN.has(s.status ?? "todo")).length;
  const ss = (state.sessions?.sessions ?? []).filter((s) => s.state !== "left");
  const c = (k: TaskState): number => steps.filter((s) => taskState(asTask(s)) === k).length;
  return {
    done: fin,
    total: steps.length,
    phases: state.board?.phases?.length ?? 0,
    pct: steps.length ? Math.round((fin / steps.length) * 100) : 0,
    live: ss.length,
    tops: ss.filter((s) => !s.parent).length,
    doing: c("doing"),
    waiting: c("waiting"),
    blocked: c("blocked"),
    todo: c("todo"),
    asks: state.attention?.asks?.length ?? 0,
    kb: state.info?.stats?.knowledge ?? 0,
    ev: Math.max(state.info?.stats?.last ?? 0, state.timeline?.at(-1)?.seq ?? 0),
  };
}

/** The plan progress's sub line: the share and the phases, or the empty plan's words (ovSub). */
export function ovSub(v: OverviewValues): string {
  if (!v.total) return "Nothing planned yet";
  return `${v.pct}% of the plan${v.phases ? ` across ${v.phases} phase${v.phases === 1 ? "" : "s"}` : ""}`;
}

/** The sub lines of the sessions and questions stats (app.js ovTexts, without the unused sub). */
export function ovTexts(v: OverviewValues): { livesub: string; asksub: string } {
  return {
    livesub: v.live
      ? `${v.tops} top-level, ${v.live - v.tops} subagent${v.live - v.tops === 1 ? "" : "s"}`
      : "Nobody online",
    asksub: v.asks ? "Waiting in your Inbox" : "All answered",
  };
}

/** One row of the plan's breakdown: its state, its words, its count and its share. */
export type OverviewRow = {
  k: TaskState;
  l: string;
  tint: string;
  cap: string;
  n: number;
  /** The share of all tasks, as a percentage with one decimal. */
  pct: number;
};

/** The plan's breakdown beside the ring: one row per state that is not done (app.js ovRows). */
export function ovRows(v: OverviewValues): OverviewRow[] {
  return (
    [
      ["doing", "Doing", "c-yellow", "in progress"],
      ["waiting", "Waiting on others", "c-peach", "on dependencies"],
      ["blocked", "Blocked", "c-red", "need a hand"],
      ["todo", "To do", "c-idle", "ready to start"],
    ] as const
  ).map(([k, l, tint, cap]) => ({
    k,
    l,
    tint,
    cap,
    n: v[k],
    pct: v.total ? Math.round((v[k] / v.total) * 1000) / 10 : 0,
  }));
}

/** The parts of the needs banner: "2 questions", "1 approval", the extras' needs. */
export function needsParts(state: HuddleState, ch: string): string[] {
  const a = state.attention;
  const parts = (
    [
      [a?.asks, "question"],
      [a?.gates, "approval"],
      [a?.paused, "paused session"],
      [a?.blocked, "blocked task"],
    ] as const
  )
    .filter(([l]) => (l?.length ?? 0) > 0)
    .map(([l, w]) => `${l?.length} ${w}${(l?.length ?? 0) > 1 ? "s" : ""}`);
  const x = extrasNeedsText(state.extras, ch);
  if (x) parts.push(...x.split(" · "));
  return parts;
}

/** The activity series: events per minute over one window, binned from the timeline (ovSeries). */
export function ovSeries(
  timeline: readonly FeedEvent[] | null | undefined,
  win: Win,
  now: number,
): {
  series: readonly { values: readonly number[] }[];
  axis: readonly string[];
  tipOf: (i: number) => readonly string[];
} {
  const [mins, n] = OV_BINS[win];
  const bm = mins / n;
  const per = new Array<number>(n).fill(0);
  for (const e of timeline ?? []) {
    const t = e.ts ? Date.parse(e.ts) : Number.NaN;
    if (!Number.isFinite(t)) continue;
    const i = Math.floor((now - t) / 60000 / bm);
    if (i >= 0 && i < n) per[n - 1 - i] = (per[n - 1 - i] ?? 0) + 1;
  }
  const fmt = (v: number): string => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  const lab = (i: number): string => {
    const d = new Date(now - (n - i) * bm * 60000);
    return (
      (win === "24h" ? `${d.toLocaleDateString([], { weekday: "short" })} ` : "") +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  };
  const mid = n >> 1;
  return {
    series: [{ values: per.map((c) => c / bm) }],
    axis: [lab(0), lab(mid), lab(n - 1)],
    tipOf: (i: number): readonly string[] => {
      const c = per[i] ?? 0;
      return [lab(i), `${c} event${c === 1 ? "" : "s"} in the bin · ${fmt(c / bm)}/min`];
    },
  };
}

/** One conflicted file as GET /conflicts returns it. */
export type ConflictFile = {
  path: string;
  repo?: string;
  repo_name?: string;
  sessions: { name: string; at?: string }[];
};

/** The conflicts read: its window and the files two live sessions both edited. */
export type Conflicts = { window_min?: number; conflicts?: ConflictFile[] };

/** The needs banner: N things need you, with the breakdown and the way to the Inbox (ovNeeds). */
function NeedsBanner({ state, ch, inboxHref }: { state: HuddleState; ch: string; inboxHref: string }) {
  const n = inboxCountOf(state, ch);
  if (!n) return null;
  const parts = needsParts(state, ch);
  return (
    <section
      class="alert c-mauve sm:alert-horizontal"
      style="border-color:color-mix(in srgb,var(--hue-mauve) 32%,transparent);background:color-mix(in srgb,var(--hue-mauve) 8%,transparent)"
      aria-labelledby="ov-needs"
      data-needs
    >
      <span class="tinted ink inline-flex size-7 shrink-0 items-center justify-center rounded-lg">
        <Icon name="inbox" />
      </span>
      <div class="min-w-0">
        <h2 class="text-sm font-semibold" id="ov-needs">
          {n} thing{n > 1 ? "s" : ""} need{n === 1 ? "s" : ""} you
        </h2>
        <p class="text-sm muted">{parts.length > 0 ? parts.join(", ") : "The channel waits on you."}</p>
      </div>
      <a class="btn btn-primary" href={inboxHref}>
        Open Inbox
      </a>
    </section>
  );
}

/** The plan progress: the ring, the done count and the per-state breakdown (ovTopHTML's hero). */
function PlanProgress({ v }: { v: OverviewValues }) {
  return (
    <Panel label="Plan progress">
      <div class="flex flex-col gap-6 md:flex-row md:items-center md:gap-8">
        <div class="flex items-center gap-5">
          <Ring pct={v.pct} />
          <div>
            <h2 class="text-sm font-medium muted" id="ov-plan">
              Plan progress
            </h2>
            <p class="flex items-baseline gap-1.5">
              <span class="text-[28px] font-semibold text-base-content tnum" data-ov="done">
                {v.done}
              </span>
              <span class="text-lg muted tnum">
                of <span data-ov="total">{v.total}</span> tasks done
              </span>
            </p>
            <p class="text-sm muted" data-ovtxt="sub">
              {ovSub(v)}
            </p>
          </div>
        </div>
        <div class="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 md:border-l hairline md:pl-8" data-ovrows>
          {ovRows(v).map((r) => (
            <div key={r.k} class={r.tint}>
              <div class="flex items-center justify-between gap-3 text-sm">
                <span class="muted">{r.l}</span>
                <span class="font-medium tnum">{r.n}</span>
              </div>
              <div class="segbar mt-1.5" role="img" aria-label={`${r.l}: ${r.n} of ${v.total}`}>
                <i class={`segbar-seg ${r.tint}`} style={`width:${r.pct}%`} />
              </div>
              <p class="mt-1 text-xs muted">{r.cap}</p>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/** Radar's estimated cost per session, when Radar runs for this channel (extras.js overviewHTML). */
function CostCard({ obs, ch, api }: { obs: Radar; ch: string; api: Api }): JSX.Element {
  const rows = Object.entries(obs.cost ?? {}).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const top = rows[0]?.[1] ?? 0;
  return (
    <Panel
      title="Estimated cost today"
      label="Estimated cost today"
      actions={<span class="text-[22px] font-semibold text-base-content tnum">{usd(obs.total ?? 0)}</span>}
    >
      <div class="flex flex-col gap-3">
        {rows.length > 0 ? (
          rows.map(([n, c]) => (
            <div key={n} class="flex items-center gap-3 text-sm">
              <Avatar name={n} small={true} />
              <a
                class="w-32 truncate font-medium hover:underline"
                href={api.channelHref(ch, `/team?s=${encodeURIComponent(n)}`)}
              >
                {n}
              </a>
              <span class="segbar flex-1" role="img" aria-label={`${n}: ${usd(c ?? 0)}`}>
                <i
                  class="segbar-seg c-info"
                  style={`width:${top ? (((c ?? 0) / top) * 100).toFixed(1) : 0}%`}
                />
              </span>
              <span class="w-16 text-right tnum">{usd(c ?? 0)}</span>
            </div>
          ))
        ) : (
          <p class="text-sm muted">No spend recorded for this channel's sessions today.</p>
        )}
      </div>
    </Panel>
  );
}

/** The conflicts card: the files two live sessions edited in the window (conflicts.js). */
function ConflictsCard({ conf, now }: { conf: Conflicts | null; now: number }): JSX.Element {
  const list = conf?.conflicts ?? [];
  return (
    <Panel
      title="Conflicts"
      label="Conflicts"
      meta={list.length > 0 ? <span class="badge badge-warning badge-sm tnum">{list.length}</span> : null}
    >
      <p class="mb-3 text-xs muted">
        Files two sessions edited in the last {conf?.window_min ?? 30} minutes. Each was told once; nothing is
        locked.
      </p>
      {list.length > 0 ? (
        <ul
          class="flex flex-col divide-y divide-base-content/10"
          aria-label="Files edited by more than one session"
        >
          {list.map((c) => (
            <li key={c.path} class="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:gap-4">
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <span class="c-peach ink inline-flex">
                  <Icon name="file" class="size-4" />
                </span>
                <code class="truncate text-sm font-medium" title={c.path}>
                  {c.path}
                </code>
                {c.repo_name ? (
                  <span class="badge badge-ghost badge-sm shrink-0 gap-1" title={c.repo ?? ""}>
                    <Icon name="folder" class="size-3.5" />
                    {c.repo_name}
                  </span>
                ) : null}
              </div>
              <ul class="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Sessions that edited it">
                {c.sessions.map((s) => (
                  <li key={s.name} class="flex items-center gap-1.5 text-xs muted">
                    <Avatar name={s.name} small={true} />
                    <span class="font-medium text-base-content">{s.name}</span>
                    <Time ts={s.at} now={now} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          text="No overlapping edits"
          hint="When two sessions edit the same file within 30 minutes, it shows here."
          icon="checkc"
        />
      )}
    </Panel>
  );
}

/** The activity card: the window segment and the events-per-minute chart (app.js overviewView). */
function ActivityCard({
  state,
  win,
  now,
  onWin,
}: {
  state: HuddleState;
  win: Win;
  now: number;
  onWin: (w: Win) => void;
}) {
  const s = ovSeries(state.timeline, win, now);
  return (
    <Panel
      title="Activity"
      label="Activity"
      meta="Events per minute"
      actions={<WindowSegment win={win} onWin={onWin} />}
    >
      <AreaChart
        series={s.series}
        axis={s.axis}
        tip={s.tipOf}
        label={`Events per minute over the last ${win}`}
        note="No activity in this window"
        h={220}
      />
    </Panel>
  );
}

/** The activity window's segment: one pressed button per window. */
function WindowSegment({ win, onWin }: { win: Win; onWin: (w: Win) => void }): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the window segment's group role
    <div class="join join-sm" role="group" aria-label="Activity window">
      {OV_WINS.map(([k, l]) => (
        <button
          type="button"
          key={k}
          class={`btn join-item btn-sm${k === win ? " btn-primary" : ""}`}
          data-win={k}
          aria-pressed={k === win}
          onClick={() => onWin(k)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** The Overview page's props: the composer's hand-off, the storage the window keeps to, and the
 *  store whose live conflict pushes refetch the conflicts card. */
export type OverviewProps = {
  /** Opens the composer over the channel (the header's Send a message). */
  onCompose?: (() => void) | undefined;
  /** Site storage; the page's localStorage when omitted. */
  prefs?: Storage | undefined;
  /** The store, for the stream's "conflict" changes; tests pass a real store over a fake api. */
  store?: HuddleStore | undefined;
};

/** The Overview page: the channel at a glance. */
export function Overview({ onCompose, prefs = localStorage, store }: OverviewProps = {}): JSX.Element | null {
  const { state, api, now } = useHuddle();
  const ch = state.ch;
  const [win, setWin] = useState<Win>(() => readPref<Win>(prefs, ch ? `ovwin:${ch}` : "ovwin", "15m"));
  const [conf, setConf] = useState<Conflicts | null>(null);
  // every live "conflict" push bumps this: the fetch effect reads it as "read again now"
  const [conflictTick, setConflictTick] = useState(0);

  // a new channel starts from the window this browser kept for it
  useEffect(() => {
    setWin(readPref<Win>(prefs, ch ? `ovwin:${ch}` : "ovwin", "15m"));
  }, [prefs, ch]);

  useEffect(
    () =>
      store?.subscribe((what) => {
        if (what === "conflict") setConflictTick((n) => n + 1);
      }),
    [store],
  );

  // the conflicts load once per channel, again when the roster moves, and on every conflict
  // push the stream delivers (conflicts.js's onChange)
  useEffect(() => {
    if (!ch) return;
    let on = true;
    api
      .api(api.channelPath(ch, "/conflicts"))
      .then((d) => {
        if (on) setConf(d as Conflicts);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [api, ch, state.sessions, conflictTick]);

  if (!ch) return null;
  const v = ovVals(state);
  const t = ovTexts(v);
  const ext = state.extras?.ch === ch ? state.extras : null;
  const pick = (k: Win): void => {
    writePref(prefs, `ovwin:${ch}`, k);
    setWin(k);
  };
  return (
    <div class="flex min-w-0 flex-col gap-5" id="ovwrap">
      <IntroActions>
        {onCompose ? (
          <button type="button" id="ovmsg" class="btn" onClick={onCompose}>
            <Icon name="send" class="size-4" /> Send a message
          </button>
        ) : null}
      </IntroActions>
      <NeedsBanner state={state} ch={ch} inboxHref={api.channelHref(ch, "/inbox")} />
      <PlanProgress v={v} />
      <div class="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 xl:grid-cols-4">
        <Stat icon="users" tint="c-lavender" label="Sessions online" value={v.live} sub={t.livesub} />
        <Stat icon="ask" tint="c-mauve" label="Questions for you" value={v.asks} sub={t.asksub} />
        <Stat icon="book" tint="c-info" label="Knowledge" value={v.kb} sub="Entries the sessions share" />
        <Stat icon="activity" tint="c-sapphire" label="Events" value={v.ev} sub="Published in this channel" />
      </div>
      {ext?.obs?.available ? <CostCard obs={ext.obs} ch={ch} api={api} /> : null}
      <ConflictsCard conf={conf} now={now} />
      <ActivityCard state={state} win={win} now={now} onWin={pick} />
    </div>
  );
}
