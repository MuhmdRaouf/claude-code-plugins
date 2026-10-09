// Graph.tsx — the work Graph: the tasks as boxes layered left to right by the longest path behind
// them, joined by curved dependency arrows, the critical path in mauve. Selecting a task (a click,
// or Space on a focused one) traces it — its dependencies light up river-up, its dependents
// river-down, and the info panel names the counts and offers the drawer; Enter opens the task.
// Port of work.js GSYM/paintGraph.

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { Pill } from "../kit.tsx";
import { FIN, STATM, who } from "../status.ts";
import { EmptyTasks } from "./List.tsx";
import type { Step } from "./model.ts";
import { stepState, taskHref } from "./model.ts";

/** A task's state as the one glyph the box shows beside its id. */
const GSYM: Record<string, string> = {
  todo: "○",
  doing: "◐",
  done: "✓",
  blocked: "✕",
  skipped: "–",
  waiting: "⧗",
};

const NW = 210;
const NH = 52;
const GX = 64;
const GY = 12;
const M = 16;

/** Cuts a text to `k` characters, an ellipsis taking the last one. */
const cut = (t: string, k: number): string => (t.length > k ? `${t.slice(0, k - 1)}…` : t);

/** A row's dependencies as indexes into `rows`; dependencies off the graph drop out. */
const depIdxOf =
  (rows: readonly Step[], idx: Map<string, number>) =>
  (k: number): number[] =>
    (rows[k]?.depends ?? []).map((x) => idx.get(x)).filter((j): j is number => j !== undefined);

/** Every row's dependents: for each row, the rows that name it in `depends`. */
function succOf(rows: readonly Step[], idx: Map<string, number>): number[][] {
  const succ: number[][] = rows.map(() => []);
  for (let i = 0; i < rows.length; i += 1) {
    for (const x of rows[i]?.depends ?? []) {
      const j = idx.get(x);
      if (j !== undefined) (succ[j] ?? []).push(i);
    }
  }
  return succ;
}

/** The layering: every box's column (the longest chain of dependencies behind it, cycles reading
 *  as zero) and its row in that column — each column ordered to run its arrows as flat as may be. */
function layout(
  nodes: readonly Step[],
  idx: Map<string, number>,
): {
  depth: number[];
  row: number[];
  W: number;
  H: number;
  X: (i: number) => number;
  Y: (i: number) => number;
} {
  const n = nodes.length;
  const depIdx = depIdxOf(nodes, idx);
  const depth = depths(n, depIdx);
  const row = new Array<number>(n).fill(0);
  const cols = columns(n, depth);
  cols.forEach((c, ci) => {
    if (!c) return;
    if (ci > 0) order(depIdx, depth, row, c, ci);
    c.forEach((i, k) => {
      row[i] = k;
    });
  });
  const ncol = cols.length || 1;
  const nrow = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  const W = M * 2 + ncol * NW + (ncol - 1) * GX;
  const H = M * 2 + nrow * (NH + GY) - GY;
  return {
    depth,
    row,
    W,
    H,
    X: (i) => M + (depth[i] ?? 0) * (NW + GX),
    Y: (i) => M + (row[i] ?? 0) * (NH + GY),
  };
}

/** Every box's column: the longest chain of dependencies behind it, cycles reading as zero. */
function depths(n: number, depIdx: (i: number) => number[]): number[] {
  const depth = new Array<number>(n).fill(-1);
  const onStack = new Array<boolean>(n).fill(false);
  const dfs = (i: number): number => {
    const seen = depth[i] ?? -1;
    if (seen >= 0) return seen;
    if (onStack[i]) return 0;
    onStack[i] = true;
    let d = 0;
    for (const j of depIdx(i)) d = Math.max(d, dfs(j) + 1);
    onStack[i] = false;
    depth[i] = d;
    return d;
  };
  for (let i = 0; i < n; i += 1) dfs(i);
  return depth;
}

/** The boxes grouped by column, in board order within a column. */
function columns(n: number, depth: readonly number[]): number[][] {
  const cols: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const c = depth[i] ?? 0;
    const col = cols[c] ?? [];
    col.push(i);
    cols[c] = col;
  }
  return cols;
}

/** Orders one later column by the average row of its earlier dependencies, so its arrows run flat. */
function order(
  depIdx: (i: number) => number[],
  depth: readonly number[],
  row: readonly number[],
  c: number[],
  ci: number,
): void {
  const bc = (i: number): number => {
    const ds = depIdx(i).filter((j) => (depth[j] ?? 0) < ci);
    return ds.length ? ds.reduce((a, j) => a + (row[j] ?? 0), 0) / ds.length : 1e9;
  };
  const key = new Map(c.map((i) => [i, bc(i)] as const));
  c.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0) || a - b);
}

/** Every task reachable from `i` through `nx` — the closure the trace lights up. */
function walk(i: number, nx: (k: number) => number[]): Set<number> {
  const seen = new Set<number>();
  const st = [i];
  while (st.length) {
    const k = st.pop();
    if (k === undefined) break;
    for (const m of nx(k)) {
      if (!seen.has(m)) {
        seen.add(m);
        st.push(m);
      }
    }
  }
  return seen;
}

/** The Graph's props: the rows that pass the filters, the critical path, and the way out. */
export type GraphProps = {
  ch: string;
  api: Api;
  /** The rows that pass the filters, in board order. */
  rows: readonly Step[];
  /** The critical path's ids, from the model. */
  crit: readonly string[];
  /** Does the board carry any task at all? Decides the empty state's wording. */
  anySteps: boolean;
  onOpenTask: (id: string) => void;
  onClear: () => void;
};

/** The dependency graph over the rows the filters keep. */
export function Graph(props: GraphProps): JSX.Element {
  const { ch, api, rows, crit, anySteps, onOpenTask, onClear } = props;
  const critSet = new Set(crit);
  const [sel, setSel] = useState<number | null>(null);
  const idx = new Map(rows.map((s, i) => [s.id, i] as const));
  const { W, H, X, Y } = layout(rows, idx);
  const depIdx = depIdxOf(rows, idx);
  const succ = succOf(rows, idx);
  const up = sel !== null ? walk(sel, depIdx) : new Set<number>();
  const down = sel !== null ? walk(sel, (k) => succ[k] ?? []) : new Set<number>();
  const chosen = sel !== null ? rows[sel] : undefined;

  if (!rows.length) {
    return (
      <div class="flex min-w-0 flex-col gap-5">
        <Info crit={critSet} selected={null} api={api} ch={ch} onOpenTask={onOpenTask} />
        <Panel>
          <EmptyTasks anySteps={anySteps} onClear={onClear} />
        </Panel>
      </div>
    );
  }

  return (
    <div class="flex min-w-0 flex-col gap-5">
      <Info
        crit={critSet}
        selected={chosen ? { s: chosen, up, down } : null}
        api={api}
        ch={ch}
        onOpenTask={onOpenTask}
      />
      <div class="panel overflow-auto md:max-h-[calc(100dvh-300px)]">
        <Dgraph
          rows={rows}
          idx={idx}
          W={W}
          H={H}
          X={X}
          Y={Y}
          critSet={critSet}
          sel={sel}
          up={up}
          down={down}
          onSelect={setSel}
          onOpenTask={onOpenTask}
        />
      </div>
    </div>
  );
}

/** Is an end of an arrow on the selected task's river — a traced task, or the task itself? */
const onRiver = (sel: number, river: Set<number>, i: number): boolean => river.has(i) || i === sel;

/** Does the selected task's trace light this arrow? Both ends on one river do. */
function traced(sel: number, up: Set<number>, down: Set<number>, a: number, b: number): boolean {
  const riverUp = onRiver(sel, up, a) && onRiver(sel, up, b);
  const riverDown = onRiver(sel, down, a) && onRiver(sel, down, b);
  return riverUp || riverDown;
}

/** One arrow's classes: plain, ok once the dependency is finished, mauve along the critical path,
 *  and hot while it takes part in the selected task's trace. */
const edgeClass = (from: Step, to: Step, critSet: ReadonlySet<string>, hot: boolean): string =>
  [
    "ge",
    FIN.has(from.status ?? "todo") ? "ok" : "",
    critSet.has(to.id) && critSet.has(from.id) ? "crit" : "",
    hot ? "hot" : "",
  ]
    .filter(Boolean)
    .join(" ");

/** The arrows: faint once the dependency is finished, mauve along the critical path, and lit while
 *  they take part in the selected task's trace. */
function Edges({
  rows,
  idx,
  X,
  Y,
  critSet,
  sel,
  up,
  down,
}: {
  rows: readonly Step[];
  idx: Map<string, number>;
  X: (i: number) => number;
  Y: (i: number) => number;
  critSet: ReadonlySet<string>;
  sel: number | null;
  up: Set<number>;
  down: Set<number>;
}): JSX.Element {
  const edges: JSX.Element[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (const x of rows[i]?.depends ?? []) {
      const j = idx.get(x);
      if (j === undefined) continue;
      const from = rows[j];
      const to = rows[i];
      if (!from || !to) continue;
      const x1 = X(j) + NW;
      const y1 = Y(j) + NH / 2;
      const x2 = X(i);
      const y2 = Y(i) + NH / 2;
      const mx = (x1 + x2) / 2;
      const hot = sel !== null && traced(sel, up, down, j, i);
      edges.push(
        <path
          key={`${from.id}-${to.id}`}
          class={edgeClass(from, to, critSet, hot)}
          data-a={j}
          data-b={i}
          d={`M${x1} ${y1}C${mx} ${y1},${mx} ${y2},${x2} ${y2}`}
        />,
      );
    }
  }
  return <>{edges}</>;
}

/** The svg's props: the geometry, the selection and its trace, and the ways out. */
type DgraphProps = {
  rows: readonly Step[];
  idx: Map<string, number>;
  W: number;
  H: number;
  X: (i: number) => number;
  Y: (i: number) => number;
  critSet: ReadonlySet<string>;
  sel: number | null;
  up: Set<number>;
  down: Set<number>;
  onSelect: (i: number) => void;
  onOpenTask: (id: string) => void;
};

/** The drawing itself: the arrows, then the boxes over them. */
function Dgraph(p: DgraphProps): JSX.Element {
  const { rows, idx, W, H, X, Y, critSet, sel, up, down, onSelect, onOpenTask } = p;
  const chosen = sel !== null ? rows[sel] : undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: the legacy graph's svg and its group role, kept word for word
    <svg
      class={`dgraph${chosen ? " focus" : ""}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="group"
      aria-label="Task dependency graph"
    >
      <Edges rows={rows} idx={idx} X={X} Y={Y} critSet={critSet} sel={sel} up={up} down={down} />
      {rows.map((s, i) => (
        <Node
          key={s.id}
          s={s}
          i={i}
          x={X(i)}
          y={Y(i)}
          crit={critSet.has(s.id)}
          sel={sel === i}
          river={up.has(i) ? "up" : down.has(i) ? "down" : ""}
          ext={(s.depends ?? []).filter((x) => !idx.has(x)).length}
          onSelect={onSelect}
          onOpenTask={onOpenTask}
        />
      ))}
    </svg>
  );
}

/** One box: its state bar, its glyph and id, its owner, its title, and its hidden dependencies. */
function Node({
  s,
  i,
  x,
  y,
  crit,
  sel,
  river,
  ext,
  onSelect,
  onOpenTask,
}: {
  s: Step;
  i: number;
  x: number;
  y: number;
  crit: boolean;
  /** Is this the picked box? */
  sel: boolean;
  /** Which river of the picked box's trace this box sits on: up, down, or neither. */
  river: "up" | "down" | "";
  ext: number;
  onSelect: (i: number) => void;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  const k = stepState(s);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a box is an svg node, not an html button; the legacy graph read it the same way
    <g
      class={["gn", STATM[k].c, crit ? "crit" : "", sel ? "sel" : "", river].filter(Boolean).join(" ")}
      data-i={i}
      transform={`translate(${x},${y})`}
      tabindex={0}
      role="button"
      aria-label={`${s.id} ${s.title}, ${STATM[k].l}${s.owner ? `, owner ${s.owner}` : ""}${crit ? ", on the critical path" : ""}`}
      onClick={() => onSelect(i)}
      onDblClick={() => onOpenTask(s.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpenTask(s.id);
        else if (e.key === " ") {
          e.preventDefault();
          onSelect(i);
        }
      }}
    >
      <rect width={NW} height={NH} rx="8" />
      <rect class="bar" x="0" y="8" width="3" height={NH - 16} rx="1.5" />
      <text x="11" y="18" class="gid">
        {`${GSYM[k] ?? GSYM.todo} ${s.id}`}
      </text>
      <text x={NW - 8} y="18" class="gow" text-anchor="end">
        {s.owner ? cut(who(s.owner), 14) : "nobody"}
      </text>
      <text x="11" y="37">
        {cut(s.title ?? "", 30)}
      </text>
      {ext ? (
        <text x={NW - 8} y="47" class="gx" text-anchor="end">
          {`+${ext} hidden`}
        </text>
      ) : null}
    </g>
  );
}

/** The info panel over the graph: what the drawing means, the critical path once it has one, and,
 *  while a task is selected, the task and its trace with the drawer link. */
function Info({
  crit,
  selected,
  api,
  ch,
  onOpenTask,
}: {
  crit: ReadonlySet<string>;
  selected: { s: Step; up: Set<number>; down: Set<number> } | null;
  api: Api;
  ch: string;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  return (
    <div
      id="ginfo"
      class="panel flex min-h-12 flex-wrap items-center gap-2 px-5 py-3.5 text-sm muted"
      aria-live="polite"
    >
      <Icon name="graph" class="size-4 text-base-content/50" />
      {selected ? (
        <Selected
          s={selected.s}
          up={selected.up}
          down={selected.down}
          api={api}
          ch={ch}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {selected ? null : (
        <>
          {"Left to right in the order tasks can run."}
          {crit.size ? (
            <span class="inline-flex items-center gap-1.5">
              <i class="inline-block h-0.5 w-5 rounded bg-primary" />
              {`Critical path: ${[...crit].join(" → ")}`}
            </span>
          ) : null}
          {" Select a task to trace it; Enter opens it."}
        </>
      )}
    </div>
  );
}

/** The info panel's selected view: the task, its trace counts, and the drawer link. */
function Selected({
  s,
  up,
  down,
  api,
  ch,
  onOpenTask,
}: {
  s: Step;
  up: Set<number>;
  down: Set<number>;
  api: Api;
  ch: string;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  return (
    <>
      <span class="badge badge-ghost badge-sm font-mono">{s.id}</span>
      <b class="font-medium text-base-content">{s.title}</b>
      <Pill status={stepState(s)} />
      <span class="text-sm muted">{`waits on ${up.size}, ${down.size} wait on it`}</span>
      <span class="flex-1" />
      <a
        class="btn btn-primary"
        href={taskHref(api, ch, s.id)}
        onClick={(e) => {
          e.preventDefault();
          onOpenTask(s.id);
        }}
      >
        {`Open ${s.id}`}
      </a>
    </>
  );
}
