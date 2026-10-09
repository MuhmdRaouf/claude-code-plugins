// Work.tsx — the Work page's shell: the List/Board/Graph/Map strip, one import-a-plan label and
// the New task button, and the shared filter bar under them (status segments with counts, the
// query box, the owner and phase selects, and the segmented progress bar with its legend). The
// views below read everything through their props; every filter interaction lands in site storage
// and in this component's state. Port of work.js view/paintFilters/wireClear/importPlan and
// app.js progressBar, with work.js setTaskStatus kept whole for the other views.

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { ToastFn } from "@muhmdraouf/ui/toast.tsx";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { IntroActions } from "../app/intro.tsx";
import { Icon } from "../icons.tsx";
import { FIN, STATM, type TaskStatus } from "../status.ts";
import type { Storage } from "../storage.ts";
import { writePref } from "../storage.ts";
import type { Attention, Board, PlanStep, SessionList } from "../store.ts";
import { BoardView } from "./Board.tsx";
import { Graph } from "./Graph.tsx";
import { List } from "./List.tsx";
import { MapView } from "./Map.tsx";
import {
  changedSteps,
  critical,
  FILTERS,
  type Filters,
  hasSteps,
  here,
  type ImportResult,
  importPlanArgs,
  importToastText,
  legend,
  matches,
  noFilters,
  type Phase,
  phases,
  prefKey,
  readFilters,
  type Step,
  scope,
  setTaskStatusArgs,
  statusToast,
  statusUndoNote,
  stepState,
  VIEW_IDS,
  type ViewId,
  visible,
  type WithNext,
  writeFilters,
} from "./model.ts";
import { Repo } from "./Repo.tsx";

/** The strip's tabs, in the order the legacy file spelled them. */
const VIEW_TABS: readonly ViewTab[] = [
  { id: "list", label: "List", icon: <Icon name="list" class="size-4.5" /> },
  { id: "board", label: "Board", icon: <Icon name="columns" class="size-4.5" /> },
  { id: "graph", label: "Graph", icon: <Icon name="graph" class="size-4.5" /> },
  { id: "map", label: "Map", icon: <Icon name="map" class="size-4.5" /> },
];

/** The Repo tab, joined on when the channel serves repo views (work.js view). */
const REPO_TAB: ViewTab = { id: "repo", label: "Repo", icon: <Icon name="code" class="size-4.5" /> };

/** One tab of the view strip. */
export type ViewTab = { id: ViewId; label: string; icon: JSX.Element };

/** The key a tab walk takes from `at`, wrapping at the ends; NaN for a key the strip ignores. */
const tabKeyTo = (n: number, key: string, at: number): number => {
  if (key === "ArrowRight") return (at + 1 + n) % n;
  if (key === "ArrowLeft") return (at - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return Number.NaN;
};

/** The view strip: daisyUI `tabs tabs-box`, the selected tab the only tab stop, the arrows walk
 *  and select. Keeps the shared strip's contract: `wt-<id>` ids, `data-tab`, `#wpanel` target. */
function ViewTabs({
  tabs,
  value,
  onPick,
}: {
  tabs: readonly ViewTab[];
  value: ViewId;
  onPick: (id: ViewId) => void;
}): JSX.Element {
  const onKey = (id: ViewId, key: string): void => {
    const at = tabs.findIndex((x) => x.id === id);
    const to = tabKeyTo(tabs.length, key, at);
    if (Number.isNaN(to)) return;
    onPick(tabs[to]?.id ?? id);
  };
  return (
    <div role="tablist" class="tabs tabs-box" aria-label="View">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`wt-${t.id}`}
          data-tab={t.id}
          aria-selected={t.id === value}
          aria-controls="wpanel"
          tabIndex={t.id === value ? 0 : -1}
          class={`tab gap-2 h-10 px-4 text-[0.9375rem]${t.id === value ? " tab-active neon-text text-primary" : ""}`}
          onClick={() => onPick(t.id)}
          onKeyDown={(e) => onKey(t.id, e.key)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The work views' props: the channel's data as the store holds it, the services, and the three
 *  ways out — a task's drawer, the composer, and a switch of sub-view. */
export type WorkProps = {
  ch: string;
  /** The sub-view this render shows: list, board, graph, map or repo. A bare Work address (the
   *  rail, the g-w chord, a task link's href) names none and reads as the Map. */
  view: ViewId | undefined;
  /** The route's parts under Work: the view first, then the repo's [view, ...path]. */
  sub?: readonly string[] | undefined;
  /** The repo views the channel serves; the Repo tab joins the strip only when it has any. */
  repoViews?: readonly string[] | undefined;
  /** The repo the channel is pointed at, shown beside the repo chips. */
  repoPath?: string | undefined;
  board: Board | null;
  /** The board's steps by id, as the store keeps them. */
  byId: Map<string, PlanStep>;
  sessions: SessionList | null;
  /** The attention snapshot, whose `next` names each session's queued task. */
  attention: (Attention & WithNext) | null;
  /** The channel's orchestrator session, when it has one; the Map marks it. */
  orchestrator?: string | null | undefined;
  /** The current time, for anything relative the views show. */
  now: number;
  api: Api;
  toast: ToastFn;
  /** Site storage (localStorage), injectable so tests drive the kept filters. */
  store: Storage;
  /** Opens a task's drawer. */
  onOpenTask: (id: string) => void;
  /** Opens a session's drawer. */
  onOpenSession: (name: string) => void;
  /** Opens the composer for a new task, with the filters' phase when one is picked. */
  onCompose: (opts: { phase?: number | undefined }, anchor: Element | null) => void;
  /** Switches the sub-view. */
  onNavigate: (view: ViewId) => void;
  /** Reloads the board after an import or a status change (the store's loadBoard). */
  reloadBoard?: (() => unknown) | undefined;
  /** Refills the Inbox after a status change (data.js's attChanged). */
  touchAttention?: (() => void) | undefined;
  /** The task whose drawer is open; its row reads as open. */
  activeTaskId?: string | null | undefined;
};

/** What a status change needs: where the op goes, who is told, and what the board looks like. */
export type StatusDeps = {
  api: Api;
  ch: string;
  toast: ToastFn;
  /** The board's steps by id; a successful change rewrites the row's status in place. */
  byId: Map<string, PlanStep>;
  /** The task the drawer has open, whose status may be ahead of the board's copy. */
  current?: PlanStep | null | undefined;
  /** Reloads the board (data.js's loadBoard). */
  reloadBoard?: (() => unknown) | undefined;
  /** Refills the Inbox (data.js's attChanged). */
  touchAttention?: (() => void) | undefined;
};

/** Every task-status change goes through here: the op, a toast with Undo, the row patched, the
 *  board reloaded and the Inbox refilled. False when there was nothing to change or the server
 *  refused. Port of work.js setTaskStatus; the drawer's own refresh lives with the drawer. */
export async function setTaskStatus(
  deps: StatusDeps,
  id: string,
  st: TaskStatus,
  note = "",
): Promise<boolean> {
  const prevTask = deps.current?.id === id ? deps.current : deps.byId.get(id);
  const prev = prevTask?.status;
  if (!prev || prev === st) return false;
  try {
    await deps.api.op(deps.ch, "task_status", setTaskStatusArgs(id, st, note));
  } catch (e) {
    const err = e as Error & { status?: number };
    const msg = err.message ?? String(e);
    deps.toast(
      err.status === 404 && /no operation/.test(msg)
        ? "This Huddle server does not support “task_status” yet. Update the server."
        : msg,
      { bad: true },
    );
    return false;
  }
  deps.toast(statusToast(id, st), { undo: () => void setTaskStatus(deps, id, prev, statusUndoNote(prev)) });
  const row = deps.byId.get(id);
  if (row) row.status = st;
  await Promise.resolve(deps.reloadBoard?.()).catch(() => {});
  deps.touchAttention?.();
  return true;
}

/** One segmented bar: done · doing · waiting · blocked; a zero segment never draws. The legend
 *  line rides beside it in the filter bar (work.js legend). Port of app.js progressBar. */
export function SegBar({
  steps,
  label = true,
}: {
  steps: readonly Step[];
  label?: boolean | undefined;
}): JSX.Element {
  const t = steps.length || 1;
  const c = (k: string): number =>
    steps.filter((s) => (k === "done" ? FIN.has(s.status ?? "todo") : stepState(s) === k)).length;
  const seg = (
    [
      ["done", "c-good"],
      ["doing", "c-yellow"],
      ["waiting", "c-peach"],
      ["blocked", "c-red"],
    ] as const
  )
    .map(([k, cl]) => [k, cl, c(k)] as const)
    .filter((x) => x[2] > 0);
  const txt =
    `${seg.map(([k, , n]) => `${n} ${k === "done" ? "done" : STATM[k].l.toLowerCase()}`).join(", ")}` +
    `, ${steps.length} in all`;
  return (
    <div class="segbar" role="img" aria-label={`${label ? "Progress: " : ""}${txt}`} title={txt}>
      {seg.map(([k, cl, n]) => (
        <i key={k} class={`segbar-seg ${cl}`} style={`width:${((n / t) * 100).toFixed(3)}%`} />
      ))}
    </div>
  );
}

/** The plan file's import: read it, hand it to import_plan, tell what it made, reload the board.
 *  Port of work.js importPlan; the input empties either way, so the same file can come twice. */
async function importPlan(
  api: Api,
  ch: string,
  toast: ToastFn,
  reloadBoard: (() => unknown) | undefined,
  input: HTMLInputElement,
): Promise<void> {
  const f = input.files?.[0];
  if (!f) return;
  try {
    const j: unknown = JSON.parse(await f.text());
    const r = (await api.op(ch, "import_plan", importPlanArgs(j))) as { result?: ImportResult } | null;
    toast(importToastText(r?.result), { bad: (r?.result?.errors?.length ?? 0) > 0 });
    await Promise.resolve(reloadBoard?.()).catch(() => {});
  } catch (err) {
    toast(`The plan was not imported: ${err instanceof Error ? err.message : String(err)}`, { bad: true });
  }
  input.value = "";
}

/** The panel under the filter bar: one of the views, only while a board is loaded. */
function WorkPanel(
  props: WorkProps & {
    filters: Filters;
    rows: readonly Step[];
    ps: readonly Phase[];
    on: Map<string, string[]>;
    hot: ReadonlySet<string>;
    crit: readonly string[];
    anySteps: boolean;
    activeTaskId: string | null;
    setStatus: (id: string, st: TaskStatus, note?: string) => Promise<boolean>;
    onClear: () => void;
  },
): JSX.Element | null {
  const { ch, view, board, byId, sessions, attention, api, rows, ps, on, hot, crit } = props;
  const { anySteps, activeTaskId, setStatus, onClear } = props;
  if (!board) return null;
  const openTask = (id: string): void => props.onOpenTask(id);
  if (view === "repo")
    return (
      <Repo
        ch={ch}
        api={api}
        now={props.now}
        parts={(props.sub ?? []).slice(1)}
        views={props.repoViews ?? []}
        repoPath={props.repoPath}
        byId={byId}
        onOpenTask={openTask}
      />
    );
  if (view === "graph")
    return (
      <Graph
        ch={ch}
        api={api}
        rows={rows}
        crit={crit}
        anySteps={anySteps}
        onOpenTask={openTask}
        onClear={onClear}
      />
    );
  if (view === "board")
    return (
      <BoardView
        ch={ch}
        api={api}
        board={board}
        rows={rows}
        on={on}
        hot={hot}
        byId={byId}
        activeTaskId={activeTaskId}
        onOpenTask={openTask}
        onStatus={setStatus}
        onClear={onClear}
      />
    );
  if (view === "list")
    return (
      <List
        ch={ch}
        api={api}
        board={board}
        byId={byId}
        rows={rows}
        ps={ps}
        on={on}
        hot={hot}
        phase={props.filters.phase}
        q={props.filters.q}
        anySteps={anySteps}
        activeTaskId={activeTaskId}
        onOpenTask={openTask}
        onClear={onClear}
      />
    );
  return (
    <MapView
      ch={ch}
      api={api}
      board={board}
      byId={byId}
      sessions={sessions}
      next={attention?.next ?? []}
      orchestrator={props.orchestrator ?? null}
      crit={crit}
      onOpenTask={openTask}
      onOpenSession={props.onOpenSession}
    />
  );
}

/** The shell of the Work page, over one of its views. */
export function Work(props: WorkProps): JSX.Element {
  const { ch, board, byId, sessions, api, toast, store } = props;
  // a bare Work address shows the Map with its tab selected, like the fall-through always did
  const raw = props.view;
  const view: ViewId = raw !== undefined && (VIEW_IDS as readonly string[]).includes(raw) ? raw : "map";
  const [filters, setFilters] = useState<Filters>(() => readFilters(store, ch));

  // the view the browser kept, for the t/<id> alias that lands on the channel's last Work view
  // (the defaulted Map is not a choice, so it never overwrites the kept one)
  useEffect(() => {
    const v = props.view;
    if (v !== undefined && (VIEW_IDS as readonly string[]).includes(v))
      writePref(store, prefKey(ch, "wview"), v);
  }, [store, ch, props.view]);

  // rows new or changed since the previous paint flash for a beat; the first paint only primes
  const seen = useRef<Map<string, string> | null>(null);
  const hot = useRef<ReadonlySet<string>>(new Set<string>());
  if (board) {
    const next = changedSteps(board.steps, seen.current);
    hot.current = next.hot;
    seen.current = next.seen;
  }

  const sc = scope(filters, board);
  const steps = board?.steps ?? [];

  const write = (next: Filters): void => {
    writeFilters(store, ch, next);
    setFilters(next);
  };
  const setStatus = (id: string, st: TaskStatus, note = ""): Promise<boolean> =>
    setTaskStatus(
      { api, ch, toast, byId, reloadBoard: props.reloadBoard, touchAttention: props.touchAttention },
      id,
      st,
      note,
    );

  return (
    <div class="flex min-h-full min-w-0 flex-col gap-5">
      {/* the page-wide controls ride the shell's PageIntro actions; the tests see the fallback row */}
      <IntroActions>
        <label
          class="btn btn-ghost cursor-pointer"
          title="Load a plan file (JSON). Status, edits and notes are kept by task id."
        >
          <Icon name="upload" class="size-4.5" />
          Import a plan
          <input
            id="imp"
            type="file"
            accept=".json,application/json"
            class="sr-only"
            onChange={(e) =>
              void importPlan(api, ch, toast, props.reloadBoard, e.currentTarget as HTMLInputElement)
            }
          />
        </label>
        <button
          id="wnew"
          type="button"
          class="btn btn-primary"
          onClick={(e) =>
            props.onCompose(
              { phase: filters.phase !== "all" ? Number(filters.phase) : undefined },
              e.currentTarget,
            )
          }
        >
          <Icon name="plus" class="size-4.5" />
          New task
        </button>
      </IntroActions>
      <div class="flex flex-wrap items-center gap-3">
        <ViewTabs
          tabs={props.repoViews?.length ? [...VIEW_TABS, REPO_TAB] : VIEW_TABS}
          value={view}
          onPick={(id) => props.onNavigate(id as ViewId)}
        />
      </div>
      {view !== "repo" ? (
        <Panel label="Filters">
          <FiltersBar
            steps={steps}
            sc={sc}
            filters={filters}
            ps={phases(board)}
            onFilter={(f) => write({ ...filters, f })}
            onOwner={(owner) => write({ ...filters, owner })}
            onPhase={(phase) => write({ ...filters, phase })}
            onQuery={(q) => write({ ...filters, q })}
          />
        </Panel>
      ) : null}
      <div id="wpanel" role="tabpanel" aria-labelledby={`wt-${view}`} class="min-h-0 min-w-0 flex-1">
        <WorkPanel
          {...props}
          view={view}
          filters={filters}
          rows={visible(steps, filters.f, sc)}
          ps={phases(board)}
          on={here(sessions)}
          hot={hot.current}
          crit={critical(steps)}
          anySteps={hasSteps(board)}
          activeTaskId={props.activeTaskId ?? null}
          setStatus={setStatus}
          onClear={() => write(noFilters())}
        />
      </div>
    </div>
  );
}

/** The filter bar's props: the board's steps, the rest of the filters, and how each part changes. */
type FiltersBarProps = {
  steps: readonly Step[];
  sc: { owner: string; phase: string; q: string; board: Board | null };
  filters: Filters;
  ps: readonly Phase[];
  onFilter: (f: Filters["f"]) => void;
  onOwner: (owner: string) => void;
  onPhase: (phase: string) => void;
  onQuery: (q: string) => void;
};

/** The shared filter bar: the status segments with their counts, the query box, the owner select,
 *  the phase select once the plan has more than one phase, and the progress bar with its legend. */
function FiltersBar({
  steps,
  sc,
  filters,
  ps,
  onFilter,
  onOwner,
  onPhase,
  onQuery,
}: FiltersBarProps): JSX.Element {
  const owners = [...new Set(steps.map((s) => s.owner).filter((o): o is string => !!o))].sort();
  const shown = steps.filter((s) => matches(s, "all", sc));
  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-3">
        {/* biome-ignore lint/a11y/useSemanticElements: the legacy filter strip's group role, kept word for word */}
        <div class="join" role="group" aria-label="Filter">
          {FILTERS.map(([k, l]) => {
            const n = k === "all" ? null : steps.filter((s) => matches(s, k, sc)).length;
            return (
              <button
                key={k}
                type="button"
                class={`btn join-item btn-sm${filters.f === k ? " btn-primary" : ""}`}
                data-f={k}
                aria-pressed={filters.f === k}
                onClick={() => onFilter(k)}
              >
                {l}
                {n ? <span class="tnum text-xs opacity-60">{n}</span> : null}
              </button>
            );
          })}
        </div>
        <span class="flex-1" />
        <div class="relative w-full sm:w-64">
          <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base-content/50">
            <Icon name="search" />
          </span>
          <input
            id="wq"
            type="search"
            class="input w-full pl-9"
            placeholder="Filter by id, title or owner"
            aria-label="Filter tasks"
            value={filters.q}
            onInput={(e) => onQuery(e.currentTarget.value)}
          />
        </div>
        <label class="sr-only" for="wown">
          Owner
        </label>
        <select
          id="wown"
          class="select w-auto"
          value={filters.owner}
          onChange={(e) => onOwner(e.currentTarget.value)}
        >
          <option value="">Any owner</option>
          <option value="owner">Me</option>
          <option value="-">Nobody</option>
          {owners
            .filter((o) => o !== "owner")
            .map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
        </select>
        {ps.length > 1 ? (
          <>
            <label class="sr-only" for="wph">
              Phase
            </label>
            <select
              id="wph"
              class="select w-auto max-w-56"
              value={filters.phase}
              onChange={(e) => onPhase(e.currentTarget.value)}
            >
              <option value="all">Every phase</option>
              {ps.map((p) => (
                <option key={p.n} value={String(p.n)}>
                  {`Phase ${p.n}: ${p.title}`}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
      {shown.length ? (
        <div class="flex items-center gap-3">
          <div class="max-w-md flex-1">
            <SegBar steps={shown} />
          </div>
          <span class="text-xs muted tnum">{legend(shown)}</span>
        </div>
      ) : null}
    </div>
  );
}
