// model.ts — the work views' shared model, all of it pure: the per-browser filter state (status,
// owner, phase, query, kept in site storage per channel the way the legacy file spelled its keys),
// the plan's phases (the declared ones plus those the steps imply), which tasks a filter keeps,
// the critical path, which sessions sit on which task, the one-line progress legend, the flash
// fingerprints of a repaint, and the pieces of one task-status change. Port of work.js
// fkey/filter/phases/matches/visible/critical/here/fprint/changed/legend and the pure half of
// setTaskStatus.

import { fuzzy } from "@muhmdraouf/ui/fuzzy.ts";
import type { Api } from "../api.ts";
import type { PhaseGraph } from "../progress.tsx";
import { FIN, STATM, type Task, type TaskState, type TaskStatus, taskState } from "../status.ts";
import { readPref, type Storage, writePref } from "../storage.ts";
import type { Board, PlanStep, SessionList } from "../store.ts";

/** The fields of a plan step the model reads; some boards also carry `unmet` waits. */
export type Step = PlanStep & { unmet?: readonly string[] | undefined };

/** The status model's view of a step: a missing status reads as "to do". */
export const asTask = (s: Step): Task => ({
  status: s.status ?? "todo",
  blocked_by: s.blocked_by,
  unmet: s.unmet,
});

/** What a step shows, "waiting" included; a step the board does not have reads as "to do". */
export const stepState = (s: Step | null | undefined): TaskState => taskState(s ? asTask(s) : null);

// ── the filters, per browser and channel ─────────────────────────────────────

/** A per-viewer preference key, scoped to the channel: "wfilter:<ch>" and its friends. */
export const prefKey = (ch: string, k: string): string => `${k}:${ch}`;

/** The status filters, in strip order: all · mine · ready · waiting · blocked · has notes. */
export const FILTERS = [
  ["all", "All"],
  ["mine", "Mine"],
  ["ready", "Ready"],
  ["waiting", "Waiting"],
  ["blocked", "Blocked"],
  ["notes", "Has notes"],
] as const satisfies readonly (readonly [FilterId, string])[];

/** One status filter of the strip. */
export type FilterId = "all" | "mine" | "ready" | "waiting" | "blocked" | "notes";

/** The work views, in strip order; Repo joins when the channel serves repo views. */
export const VIEW_IDS = ["list", "board", "graph", "map", "repo"] as const;

/** One sub-view of the Work page. */
export type ViewId = (typeof VIEW_IDS)[number];

/** The work views' filter state: the status filter plus owner, phase and query. */
export type Filters = { f: FilterId; owner: string; phase: string; q: string };

/** The filters a view starts from: every status, any owner, every phase, no query. */
export const noFilters = (): Filters => ({ f: "all", owner: "", phase: "all", q: "" });

/** The filters this browser kept for the channel; the defaults where it kept none. */
export function readFilters(store: Storage, ch: string): Filters {
  return {
    f: readPref<FilterId>(store, prefKey(ch, "wfilter"), "all"),
    owner: readPref<string>(store, prefKey(ch, "wowner"), ""),
    phase: readPref<string>(store, prefKey(ch, "wphase"), "all"),
    q: readPref<string>(store, prefKey(ch, "wq"), ""),
  };
}

/** Keeps the filters for the channel, the way every filter interaction did. */
export function writeFilters(store: Storage, ch: string, f: Filters): void {
  writePref(store, prefKey(ch, "wfilter"), f.f);
  writePref(store, prefKey(ch, "wowner"), f.owner);
  writePref(store, prefKey(ch, "wphase"), f.phase);
  writePref(store, prefKey(ch, "wq"), f.q);
}

// ── the plan and its phases ──────────────────────────────────────────────────

/** A declared phase's extra body: the summary and diagram its card shows. */
type RawPhase = { n: number; title: string; summary?: string | undefined; diagram?: PhaseGraph | undefined };

/** One phase of the plan: its number and title, the declared body when the plan carries one,
 *  and `implied` when only the steps use the number. */
export type Phase = {
  n: number;
  title: string;
  implied?: boolean | undefined;
  summary?: string | undefined;
  diagram?: PhaseGraph | undefined;
};

/** The plan's phases in number order: the declared ones plus every phase number the steps use. */
export function phases(board: Board | null): Phase[] {
  if (!board) return [];
  const m = new Map<number, Phase>(
    (board.phases as readonly RawPhase[]).map((p) => [
      p.n,
      { n: p.n, title: p.title, summary: p.summary, diagram: p.diagram },
    ]),
  );
  for (const s of board.steps) {
    if (s.phase_n === undefined || m.has(s.phase_n)) continue;
    m.set(s.phase_n, { n: s.phase_n, title: `Phase ${s.phase_n}`, implied: true });
  }
  return [...m.values()].sort((a, b) => a.n - b.n);
}

// ── which tasks a filter keeps ───────────────────────────────────────────────

/** Everything but the status filter: the owner, phase and query the browser kept, over a board. */
export type Scope = { owner: string; phase: string; q: string; board: Board | null };

/** The scope of one render: the filters' owner/phase/query parts over the open board. */
export const scope = (f: Filters, board: Board | null): Scope => ({
  owner: f.owner,
  phase: f.phase,
  q: f.q,
  board,
});

/** Does a step pass the owner, phase and query parts of the filters? The phase part only bites
 *  while the plan has more than one phase; a step without a phase number passes no phase pick. */
export function inScope(s: Step, scope: Scope): boolean {
  const { owner, phase, q } = scope;
  if (owner && (owner === "-" ? s.owner : s.owner !== owner)) return false;
  if (phase !== "all" && phases(scope.board).length > 1 && s.phase_n !== Number(phase)) return false;
  if (q && fuzzy(q, `${s.id} ${s.title ?? ""} ${s.owner ?? ""}`) < 0) return false;
  return true;
}

/** Does a step pass one status filter? "mine" is the owner's own tasks, "ready" an open task
 *  that neither waits nor blocks, "notes" any task with an open note. */
export function statusMatch(s: Step, f: FilterId): boolean {
  const k = stepState(s);
  if (f === "mine") return s.owner === "owner";
  if (f === "ready") return !FIN.has(s.status ?? "todo") && k !== "waiting" && k !== "blocked";
  if (f === "waiting") return k === "waiting";
  if (f === "blocked") return k === "blocked";
  if (f === "notes") return (s.comments?.open ?? 0) > 0;
  return true;
}

/** Does a step show under one status filter and the rest of the filters? */
export function matches(s: Step, f: FilterId, scope: Scope): boolean {
  return inScope(s, scope) && statusMatch(s, f);
}

/** The steps a view shows: the board's steps that pass. */
export const visible = (steps: readonly Step[], f: FilterId, scope: Scope): Step[] =>
  steps.filter((s) => matches(s, f, scope));

/** The owners on a board, sorted, without the blanks: the owner select's extra options. */
export function owners(steps: readonly Step[]): string[] {
  return [...new Set(steps.map((s) => s.owner).filter((o): o is string => !!o))].sort();
}

// ── the critical path, and who is where ──────────────────────────────────────

/** The ids of the longest chain of unfinished tasks through their dependencies; [] when no chain
 *  of two or more runs through the open work. A dependency cycle reads as a chain of zero. */
export function critical(steps: readonly Step[]): string[] {
  const open = steps.filter((s) => !FIN.has(s.status ?? "todo"));
  const by = new Map(open.map((s) => [s.id, s]));
  const memo = new Map<string, [number, string | null]>();
  const on = new Set<string>();
  /** The longest unfinished dependency chain behind `id`, as [length, the next id back]. */
  const bestDep = (id: string): [number, string | null] => {
    let best: [number, string | null] = [0, null];
    for (const d of by.get(id)?.depends ?? []) {
      if (!by.has(d)) continue;
      const l = len(d)[0];
      if (l > best[0]) best = [l, d];
    }
    return best;
  };
  const len = (id: string): [number, string | null] => {
    const done = memo.get(id);
    if (done) return done;
    if (on.has(id)) return [0, null];
    on.add(id);
    const best = bestDep(id);
    on.delete(id);
    const r: [number, string | null] = [best[0] + 1, best[1]];
    memo.set(id, r);
    return r;
  };
  let top: string | null = null;
  let n = 0;
  for (const s of open) {
    const l = len(s.id)[0];
    if (l > n) {
      n = l;
      top = s.id;
    }
  }
  const chain: string[] = [];
  while (top) {
    chain.unshift(top);
    top = memo.get(top)?.[1] ?? null;
  }
  return chain.length > 1 ? chain : [];
}

/** Which sessions sit on which step right now: step id → the names still in the channel. */
export function here(sessions: SessionList | null | undefined): Map<string, string[]> {
  const h = new Map<string, string[]>();
  for (const s of sessions?.sessions ?? []) {
    if (!s.step || s.state === "left") continue;
    const names = h.get(s.step) ?? [];
    names.push(s.name);
    h.set(s.step, names);
  }
  return h;
}

// ── the repaint's flash ──────────────────────────────────────────────────────

/** The fingerprint of a row: every field whose change should flash it. */
export const fprint = (s: Step): string =>
  `${s.status}|${s.owner || ""}|${s.title}|${s.depends?.length || 0}|${s.blocked_by?.length || 0}|${s.comments?.open || 0}`;

/** The rows that changed since `seen`, as their ids, plus the map to keep for the next paint.
 *  A null `seen` — the first paint after a load — flashes nothing; it only primes the prints. */
export function changedSteps(
  steps: readonly Step[],
  seen: Map<string, string> | null,
): { hot: Set<string>; seen: Map<string, string> } {
  const hot = seen ? steps.filter((s) => seen.get(s.id) !== fprint(s)).map((s) => s.id) : [];
  return { hot: new Set(hot), seen: new Map(steps.map((s) => [s.id, fprint(s)])) };
}

// ── the little words: legend, empty, links, import ───────────────────────────

/** "3 of 4 done, 1 doing": a step set's counts, zero values left out. */
export function legend(steps: readonly Step[]): string {
  const c = (k: TaskState): number =>
    steps.filter((s) => (k === "done" ? FIN.has(s.status ?? "todo") : stepState(s) === k)).length;
  return [
    `${c("done")} of ${steps.length} done`,
    ...(["doing", "waiting", "blocked"] as const)
      .map((k) => [k, c(k)] as const)
      .filter((x) => x[1] > 0)
      .map(([k, n]) => `${n} ${STATM[k].l.toLowerCase()}`),
  ].join(", ");
}

/** Does the board carry any task at all? Decides the empty state's wording. */
export const hasSteps = (board: Board | null | undefined): boolean => (board?.steps.length ?? 0) > 0;

/** A task's drawer link: the work view carrying ?t=<id> (app.js taskHref, spelled by the API). */
export const taskHref = (api: Api, ch: string, id: string): string =>
  `${api.channelHref(ch, "/work")}?t=${encodeURIComponent(id)}`;

/** A session's drawer link: the team view carrying ?s=<name> (app.js sessHref). */
export const sessHref = (api: Api, ch: string, name: string): string =>
  `${api.channelHref(ch, "/team")}?s=${encodeURIComponent(name)}`;

/** The op args of import_plan: the file's JSON, or its `plan` member when it wraps one. */
export const importPlanArgs = (j: unknown): { plan: unknown } => ({
  plan: (j as { plan?: unknown }).plan ?? j,
});

/** What import_plan answered: the counts it created and the problems it hit. */
export type ImportResult = { tasks?: number; phases?: number; errors?: string[] };

/** The toast of an import: the counts, and up to two of the problems. */
export function importToastText(r: ImportResult | null | undefined): string {
  const errs = r?.errors ?? [];
  return `Imported ${r?.tasks ?? 0} tasks in ${r?.phases ?? 0} phases${
    errs.length ? `, with ${errs.length} problems: ${errs.slice(0, 2).join("; ")}` : ""
  }.`;
}

// ── the pieces of one task-status change ─────────────────────────────────────

/** The op args of one status change: the task, its new status, and an optional note. */
export const setTaskStatusArgs = (
  id: string,
  st: TaskStatus,
  note = "",
): { id: string; status: TaskStatus; note: string } => ({
  id,
  status: st,
  note,
});

/** The toast of a status change: "t3 is done". */
export const statusToast = (id: string, st: TaskStatus): string => `${id} is ${STATM[st].l.toLowerCase()}`;

/** The note the Undo of a status change leaves behind: "undo: back to todo". */
export const statusUndoNote = (prev: TaskStatus): string => `undo: back to ${prev}`;

// ── the map's next task ──────────────────────────────────────────────────────

/** One session's next task as the attention snapshot names it: its id and title. */
export type NextTask = {
  session: string;
  task?: { id: string; title?: string; ready?: boolean; unmet?: readonly string[] } | null;
};

/** The attention snapshot with the `next` list the server adds and the Map reads. */
export type WithNext = { next?: readonly NextTask[] | undefined };

/** The id of a session's next task: the attention snapshot's pick, else the first of the
 *  session's own steps that is neither finished nor being worked; null when nothing is queued. */
export function nextStepId(
  name: string,
  step: string | null | undefined,
  next: readonly NextTask[],
  board: Board | null,
): string | null {
  const pick = next.find((x) => x.session === name && x.task && x.task.id !== step)?.task;
  if (pick) return pick.id;
  const t = (board?.steps ?? []).find(
    (x) => x.owner === name && x.id !== step && (!x.status || !FIN.has(x.status)) && x.status !== "doing",
  );
  return t?.id ?? null;
}
