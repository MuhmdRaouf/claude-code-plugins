// Map.tsx — the work Map: the big picture in one read — every phase with its progress bar, every
// session online with the task it is on now and the one queued next, and the critical path with
// the link that shows it in the Graph. Port of work.js paintMap.

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { JSX } from "preact";
import type { Api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { Avatar, StatusIcon } from "../kit.tsx";
import { FIN, SSTM, sessionStatus } from "../status.ts";
import type { Board, PlanStep, RosterSession, SessionList } from "../store.ts";
import type { Phase, Step } from "./model.ts";
import { asTask, type NextTask, nextStepId, phases, sessHref, stepState, taskHref } from "./model.ts";

/** The Map's props: the plan, the roster, the attention snapshot's next picks, and the critical
 *  path. */
export type MapProps = {
  ch: string;
  api: Api;
  board: Board;
  /** The board's steps by id. */
  byId: Map<string, PlanStep>;
  sessions: SessionList | null;
  /** The attention snapshot's `next`: each session's queued task. */
  next: readonly NextTask[];
  /** The channel's orchestrator session, when it has one; its row carries the baton. */
  orchestrator: string | null;
  /** The critical path's ids, from the model. */
  crit: readonly string[];
  onOpenTask: (id: string) => void;
  onOpenSession: (name: string) => void;
};

/** One phase card: its number and title, the complete mark when every task is done, and the
 *  "d of n done" bar. */
function PhaseCard({ p, steps }: { p: Phase; steps: readonly Step[] }): JSX.Element {
  const d = steps.filter((x) => FIN.has(x.status ?? "todo")).length;
  const done = steps.length > 0 && d === steps.length;
  return (
    <Panel
      title={`Phase ${p.n}`}
      meta={
        <span class="inline-flex items-center gap-2">
          {done ? (
            <span class="text-success" title="complete">
              <Icon name="checkc" class="size-4.5" />
            </span>
          ) : null}
          <span class="tnum">{`${d} of ${steps.length} done`}</span>
        </span>
      }
    >
      <div class="segbar" role="img" aria-label={`Progress: ${d} of ${steps.length} done`}>
        <i class="segbar-seg" style={`width:${steps.length ? ((d / steps.length) * 100).toFixed(1) : 0}%`} />
      </div>
      {p.title !== `Phase ${p.n}` ? <p class="mt-2 min-w-0 truncate text-sm">{p.title}</p> : null}
    </Panel>
  );
}

/** The work Map over the whole plan. */
export function MapView(props: MapProps): JSX.Element {
  const { ch, api, board, byId, sessions, next, orchestrator, crit, onOpenTask, onOpenSession } = props;
  const ps = phases(board);

  const tops = (sessions?.sessions ?? []).filter((s) => s.state !== "left" && !s.parent);
  const taskById = (id: string): ReturnType<typeof asTask> | null => {
    const t = byId.get(id);
    return t ? asTask(t) : null;
  };

  /** A task id as its drawer link, or the bare id when the board does not have it. */
  const tl = (id: string): JSX.Element => {
    const t = byId.get(id);
    return t ? (
      <a
        class="inline-flex min-w-0 max-w-full items-center gap-1.5 hover:underline"
        href={taskHref(api, ch, id)}
        onClick={(e) => {
          e.preventDefault();
          onOpenTask(id);
        }}
      >
        <StatusIcon status={stepState(t)} class="size-3.5" />
        <span class="badge badge-ghost badge-sm font-mono">{id}</span>
        <span class="truncate">{t.title}</span>
      </a>
    ) : (
      <span class="badge badge-ghost badge-sm font-mono">{id}</span>
    );
  };

  /** One session's now/next rows. */
  const sessRow = (s: RosterSession): JSX.Element => {
    const st = sessionStatus(s, taskById);
    const m = SSTM[st];
    const nxId = nextStepId(s.name, s.step, next, board);
    return (
      <li key={s.name} class="flex flex-col gap-2 px-5 py-4">
        <div class="flex items-center gap-2">
          <a
            class="flex min-w-0 flex-1 items-center gap-2.5 hover:underline"
            href={sessHref(api, ch, s.name)}
            onClick={(e) => {
              e.preventDefault();
              onOpenSession(s.name);
            }}
          >
            <Avatar name={s.name} />
            <b class="truncate text-[0.9375rem] font-semibold">{s.name}</b>
            {orchestrator === s.name ? (
              <span class="text-base-content/50" title="Orchestrator">
                <Icon name="baton" class="size-4" />
              </span>
            ) : null}
          </a>
          <span class={`badge badge-sm gap-1.5 ${m.c} tinted ink`}>
            <Icon name={m.i} class="size-3.5" />
            {m.l}
          </span>
        </div>
        <div class="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-sm">
          <span class="text-base-content/50">Now</span>
          <span class="min-w-0">
            {s.step ? tl(s.step) : <span class="text-base-content/50">{s.task || "nothing"}</span>}
          </span>
          <span class="text-base-content/50">Next</span>
          <span class="min-w-0">
            {nxId && nxId !== s.step ? tl(nxId) : <span class="text-base-content/50">nothing queued</span>}
          </span>
        </div>
      </li>
    );
  };

  return (
    <div class="grid min-w-0 items-start gap-5 lg:grid-cols-2">
      <section class="flex min-w-0 flex-col gap-3" aria-labelledby="mp-ph">
        <h2 id="mp-ph" class="text-sm font-medium muted px-1">
          Phases
        </h2>
        {ps.length ? (
          ps.map((p) => <PhaseCard key={p.n} p={p} steps={board.steps.filter((x) => x.phase_n === p.n)} />)
        ) : (
          <Panel>
            <p class="text-center text-sm muted">No phases yet.</p>
          </Panel>
        )}
      </section>
      <Panel
        title="Sessions"
        meta="now and next"
        icon={<Icon name="users" class="size-4.5" />}
        flush
        label="Sessions"
        class="min-w-0"
      >
        <ul class="divide-y divide-base-content/10">
          {tops.length ? (
            tops.map(sessRow)
          ) : (
            <li class="px-5 py-10 text-center text-sm muted">No session online.</li>
          )}
        </ul>
      </Panel>
      <Panel
        title="Critical path"
        label="Critical path"
        icon={<Icon name="graph" class="size-4.5" />}
        actions={
          <a class="btn btn-ghost btn-sm" href={api.channelHref(ch, "/work/graph")}>
            <Icon name="graph" class="size-4.5" />
            Show in Graph
          </a>
        }
        class="min-w-0 lg:col-span-2"
      >
        {crit.length ? (
          <>
            <p class="mb-4 text-sm muted">
              The longest chain of unfinished tasks. Any delay here delays the end.
            </p>
            <ol class="flex flex-wrap items-center gap-2">
              {crit.map((id, i) => (
                <li key={id} class="flex min-w-0 items-center gap-2">
                  {i ? <Icon name="arrow" class="size-4 text-base-content/50" /> : null}
                  <span class="badge badge-ghost max-w-64 gap-1.5 px-2 py-1.5 text-[0.9375rem]">
                    {tl(id)}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p class="text-sm muted">No chain of unfinished tasks: everything open can run in parallel.</p>
        )}
      </Panel>
    </div>
  );
}
