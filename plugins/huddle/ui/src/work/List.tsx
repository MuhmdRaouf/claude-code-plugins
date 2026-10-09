// List.tsx — the work List: every task the filters keep as one table (status pill, id and title,
// owner, open notes, who is on it), grouped under their phase cards when the plan has more than
// one phase and no phase is picked, the picked phase's summary and diagram over the table, and —
// while a query of three or more characters runs — the tasks the server's search found in the task
// text. Port of work.js THEAD/stHPill/taskRow/paintList and its search line.

import { Markdown } from "@muhmdraouf/ui/markdown.tsx";
import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { Avatar, Pill, StatusIcon } from "../kit.tsx";
import { PhaseDiagram } from "../progress.tsx";
import { FIN, STATM, who } from "../status.ts";
import type { Board, PlanStep } from "../store.ts";
import type { Phase, Step } from "./model.ts";
import { stepState, taskHref } from "./model.ts";

/** One row of search hits: the task's id and title, and its text with «the hit» marked. */
type SearchHit = { id: string; title?: string; hit?: string };

/** The empty panel under the filters: "No task matches" while tasks exist, "No tasks yet" while
 *  the plan is empty, with the way out of the filters. Port of work.js emptyMsg/wireClear. */
export function EmptyTasks({
  anySteps,
  onClear,
}: {
  anySteps: boolean;
  onClear?: (() => void) | undefined;
}): JSX.Element {
  return (
    <div class="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <span class="text-base-content/40">
        <Icon name="list" class="size-7" />
      </span>
      {anySteps ? (
        <>
          <p class="text-base font-medium">No task matches.</p>
          <p class="max-w-sm text-sm muted">Clear the filters to see every task.</p>
          <button type="button" class="btn btn-sm mt-2" data-clear onClick={onClear}>
            Clear filters
          </button>
        </>
      ) : (
        <>
          <p class="text-base font-medium">No tasks yet</p>
          <p class="max-w-sm text-sm muted">
            Sessions add tasks as they plan. Add one with New task, or import a plan file.
          </p>
        </>
      )}
    </div>
  );
}

/** The List's props: the rows that pass the filters, the plan around them, and the query. */
export type ListProps = {
  ch: string;
  api: Api;
  /** The board, for the per-phase progress cards. */
  board: Board;
  /** The board's steps by id, for the search hits' status icons. */
  byId: Map<string, PlanStep>;
  /** The rows that pass the filters, in board order. */
  rows: readonly Step[];
  /** The plan's phases, declared and implied. */
  ps: readonly Phase[];
  /** Which sessions sit on which task right now. */
  on: Map<string, string[]>;
  /** The rows changed since the previous paint; they flash. */
  hot: ReadonlySet<string>;
  /** The phase filter's raw value: "all", or a phase number as text. */
  phase: string;
  /** The query; from three characters the server searches the task text too. */
  q: string;
  /** Does the board carry any task at all? Decides the empty state's wording. */
  anySteps: boolean;
  /** The task whose drawer is open; its row reads as open. */
  activeTaskId: string | null;
  onOpenTask: (id: string) => void;
  onClear: () => void;
};

/** One table header for every task table: Open · Status · Task · Owner · Notes · On it. */
function Thead(): JSX.Element {
  const h = "bg-base-200/60 text-sm font-medium text-base-content/70";
  return (
    <thead>
      <tr>
        <th class={`w-9 ${h}`}>
          <span class="sr-only">Open</span>
        </th>
        <th class={h}>Status</th>
        <th class={h}>Task</th>
        <th class={`hidden md:table-cell ${h}`}>Owner</th>
        <th class={`text-right tnum hidden md:table-cell ${h}`}>Notes</th>
        <th class={`text-right tnum ${h}`}>On it</th>
      </tr>
    </thead>
  );
}

/** The extras a row's title carries: the approval badge badge-ghost badge-sm while a gate holds, and what a waiting task
 *  waits on — either, both, or none. */
function RowExtra({ s, k }: { s: Step; k: string }): JSX.Element | null {
  const gated = !!s.gate && s.gate !== "none" && !FIN.has(s.status ?? "todo");
  if (!gated && k !== "waiting") return null;
  return (
    <>
      {gated ? (
        <span class="badge badge-ghost badge-sm" title="Needs your approval">
          <Icon name="key" class="size-3.5" />
          <span class="max-sm:sr-only">Approval</span>
        </span>
      ) : null}
      {k === "waiting" ? (
        <span class="hidden text-xs text-warning lg:inline">
          {`waits on ${(s.blocked_by ?? []).slice(0, 2).join(", ")}${(s.blocked_by?.length ?? 0) > 2 ? "…" : ""}`}
        </span>
      ) : null}
    </>
  );
}

/** One task row: the chevron, the status pill, the id and title as the drawer link, the owner,
 *  the open-note count and the sessions on it. A click anywhere but the link still opens. */
function TaskRow({
  s,
  on,
  hot,
  cur,
  href,
  onOpenTask,
}: {
  s: Step;
  on: Map<string, string[]>;
  hot: ReadonlySet<string>;
  cur: boolean;
  href: string;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  const k = stepState(s);
  return (
    <tr
      class={`row-open cursor-pointer hover:bg-base-200/50 ${cur ? "open bg-primary/8 [box-shadow:inset_3px_0_0_var(--color-primary)]" : ""}${hot.has(s.id) ? " flash" : ""}`}
      data-tid={s.id}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest("a")) return;
        onOpenTask(s.id);
      }}
    >
      <td class="w-9 text-base-content/50">
        <Icon name="right" class="chev size-4" />
      </td>
      <td class="whitespace-nowrap">
        <Pill status={k} label={STATM[k].l} />
      </td>
      <td class="w-full max-w-0">
        <a
          class="flex min-w-0 items-center gap-2"
          href={href}
          onClick={(e) => {
            e.preventDefault();
            onOpenTask(s.id);
          }}
        >
          <span class="badge badge-ghost badge-sm font-mono">{s.id}</span>
          <span class={`min-w-0 flex-1 truncate ${FIN.has(s.status ?? "todo") ? "muted" : ""}`}>
            {s.title}
          </span>
          <RowExtra s={s} k={k} />
        </a>
      </td>
      <td class="hidden w-24 truncate text-sm muted md:table-cell">
        {s.owner ? who(s.owner) : <span class="text-base-content/50">nobody</span>}
      </td>
      <td
        class="text-right tnum hidden text-sm muted md:table-cell"
        title={s.comments?.open ? `${s.comments.open} open notes` : undefined}
      >
        {s.comments?.open || ""}
      </td>
      <td class="w-20">
        <span class="flex justify-end -space-x-1">
          {(on.get(s.id) ?? []).slice(0, 3).map((n) => (
            <span key={n} title={`${n} is on it`}>
              <Avatar name={n} small />
            </span>
          ))}
        </span>
      </td>
    </tr>
  );
}

/** A text with the server's «hit» markers shown as marks. */
function Marks({ text }: { text: string }): JSX.Element {
  const parts = text.split(/«|»/);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={`m${i}`}>{p}</mark> : p))}</>;
}

/** The phase card's done bar: one fill, labelled for the screen reader. */
function DoneBar({ d, n }: { d: number; n: number }): JSX.Element {
  return (
    <div class="segbar" role="img" aria-label={`Progress: ${d} of ${n} done`}>
      <i class="segbar-seg" style={`width:${n ? ((d / n) * 100).toFixed(1) : 0}%`} />
    </div>
  );
}

/** The picked phase's brief: its number and title, its summary, and its diagram. */
function PhaseBrief({ cur }: { cur: Phase }): JSX.Element {
  return (
    <Panel title={`Phase ${cur.n}`} meta={cur.title} icon={<Icon name="list" class="size-4.5" />}>
      {cur.summary ? (
        <div class="prose-h muted">
          <Markdown text={cur.summary} />
        </div>
      ) : null}
      {cur.diagram ? (
        <div class={cur.summary ? "mt-4" : ""}>
          <PhaseDiagram g={cur.diagram} />
        </div>
      ) : null}
    </Panel>
  );
}

/** One grouped phase section: the phase's title and progress over its own table. */
function Group({
  p,
  list,
  all,
  table,
}: {
  p: Phase;
  list: readonly Step[];
  all: readonly Step[];
  table: (list: readonly Step[]) => JSX.Element;
}): JSX.Element {
  const d = all.filter((s) => FIN.has(s.status ?? "todo")).length;
  return (
    <section class="panel min-w-0 overflow-hidden" aria-labelledby={`ph-${p.n}`}>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-base-content/8 px-5 py-3.5">
        <h2 id={`ph-${p.n}`} class="flex min-w-0 items-baseline gap-2.5 text-base font-semibold">
          <span class="shrink-0 text-sm font-medium whitespace-nowrap text-base-content/50 tnum">
            {`Phase ${p.n}`}
          </span>
          <span class="truncate">{p.title}</span>
        </h2>
        <span class="flex shrink-0 items-center gap-3">
          <span class="block w-14 sm:w-28">
            <DoneBar d={d} n={all.length} />
          </span>
          <span class="text-sm whitespace-nowrap muted tnum">
            {d} of {all.length} done
          </span>
        </span>
      </div>
      {table(list)}
    </section>
  );
}

/** The tasks the server's search found in the task text, that the filtered list does not show. */
function Found({
  more,
  byId,
  href,
  onOpenTask,
}: {
  more: readonly SearchHit[];
  byId: Map<string, PlanStep>;
  href: (id: string) => string;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  return (
    <Panel title="Found in the task text" label="Found in the task text" flush>
      <ul class="divide-y divide-base-content/10">
        {more.map((x) => {
          const t = byId.get(x.id) ?? null;
          return (
            <li key={x.id}>
              <a
                class="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-base-200/50"
                href={href(x.id)}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenTask(x.id);
                }}
              >
                <StatusIcon status={stepState(t)} />
                <span class="badge badge-ghost badge-sm font-mono">{x.id}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[0.9375rem]">{x.title}</span>
                  <span class="hit block truncate text-sm muted">{x.hit ? <Marks text={x.hit} /> : ""}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** The work List over the rows the filters keep. */
export function List(props: ListProps): JSX.Element {
  const { ch, api, board, byId, rows, ps, on, hot, phase, q, anySteps, activeTaskId, onOpenTask, onClear } =
    props;
  const grouped = ps.length > 1 && phase === "all";
  const cur = ps.find((p) => String(p.n) === String(phase));

  // the tasks the server's search found in the task text, once the query is three characters
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    if (q.trim().length < 3) {
      setHits(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .api(api.channelPath(ch, `/search?q=${encodeURIComponent(q.trim())}`))
        .then((r) => {
          if (live) setHits((r as SearchHit[]) ?? []);
        })
        .catch(() => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, api, ch]);

  const href = (id: string): string => taskHref(api, ch, id);
  const table = (list: readonly Step[]): JSX.Element => (
    <div class="overflow-x-auto">
      <table class="table table-pin-rows text-row">
        <Thead />
        <tbody>
          {list.map((s) => (
            <TaskRow
              key={s.id}
              s={s}
              on={on}
              hot={hot}
              cur={activeTaskId === s.id}
              href={href(s.id)}
              onOpenTask={onOpenTask}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
  const more = (hits ?? []).filter((x) => !rows.some((s) => s.id === x.id)).slice(0, 12);

  return (
    <div class="flex min-w-0 flex-col gap-5">
      {cur && (cur.summary || cur.diagram) ? <PhaseBrief cur={cur} /> : null}
      {!rows.length ? (
        <Panel>
          <EmptyTasks anySteps={anySteps} onClear={onClear} />
        </Panel>
      ) : grouped ? (
        ps.map((p) => {
          const l = rows.filter((s) => s.phase_n === p.n);
          if (!l.length) return null;
          const all = board.steps.filter((s) => s.phase_n === p.n);
          return <Group key={p.n} p={p} list={l} all={all} table={table} />;
        })
      ) : (
        <Panel label="Tasks" flush>
          {table(rows)}
        </Panel>
      )}
      <div id="wfound">
        {more.length ? <Found more={more} byId={byId} href={href} onOpenTask={onOpenTask} /> : null}
      </div>
    </div>
  );
}
