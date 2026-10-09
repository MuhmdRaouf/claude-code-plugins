// TaskDrawer.tsx — the task drawer: the shared SlideOver, a big panel from the right that floats
// over the whole UI (Escape, a click outside and the X close it), opened by the router's ?t=<id>
// from every task link. Its sections sit under daisyUI tabs — Overview (status, owner, the two
// dependency directions, the plan's body sections), Code (snippets, files, references) and Notes
// (the notes the sessions read) — then only the filled sections with one "Add section" menu.
// A status change goes through Work's setTaskStatus; every other change is a task_update / note /
// note_edit / approve op. Port of work.js openDrawer/closeDrawer/refreshTask/renderTask/wireTask
// and their render helpers.

import { CodeBlock, langOf } from "@muhmdraouf/ui/code.tsx";
import { Dialog } from "@muhmdraouf/ui/dialog.tsx";
import { Inline, Paragraphs } from "@muhmdraouf/ui/markdown.tsx";
import { type MenuItem, PopMenu } from "@muhmdraouf/ui/menu.tsx";
import { SlideOver } from "@muhmdraouf/ui/slide-over.tsx";
import type { ToastFn } from "@muhmdraouf/ui/toast.tsx";
import type { ComponentChildren, JSX, RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { errText } from "../app/context.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { Pill, Skeleton, StatusIcon, Time } from "../kit.tsx";
import { Picker, type PickerTask } from "../picker.tsx";
import {
  FIN,
  type SessionStatus,
  SSTM,
  STAT,
  STATM,
  sessionStatus,
  type Task,
  type TaskState,
  type TaskStatus,
  taskState,
  who,
  whoL,
} from "../status.ts";
import { readPref, type Storage, writePref } from "../storage.ts";
import type { Board, HuddleStore, PlanStep, SessionList } from "../store.ts";
import type { Step } from "./model.ts";
import { setTaskStatus } from "./Work.tsx";

/** One note on a task, as GET /task/<id> returns it. */
export type TaskNote = {
  id: number;
  kind?: string | null;
  body?: string | null;
  by?: string | null;
  resolved?: number | boolean | null;
  created_at?: string | null;
};

/** One row of the "alternatives" section. */
export type TaskAlternative = { option?: string; why_not?: string };

/** One quoted snippet: what it is called, where it came from, and its code. */
export type TaskSnippet = {
  title?: string;
  lang?: string;
  path?: string;
  proposed?: boolean | number;
  code?: string;
};

/** One check of the "verify" section. */
export type TaskVerify = { cmd?: string; expect?: string };

/** One unfinished dependency, as the server spells the wait out. */
export type TaskUnmet = { id: string; owner?: string | null; status?: string; title?: string | null };

/** A task as GET /task/<id> returns it: the board's step plus its body sections and notes.
 * `comments` and `edited` are replaced: the detail carries the notes themselves and the edit marks. */
export type TaskDetail = Omit<PlanStep, "comments" | "edited"> & {
  value?: string;
  what?: string;
  why?: string;
  use?: string;
  rollback?: string;
  notes?: string;
  alternatives?: TaskAlternative[];
  how?: string[];
  snippets?: TaskSnippet[];
  verify?: TaskVerify[];
  files?: string[];
  refs?: string[];
  needed_by?: string[];
  unmet?: TaskUnmet[];
  comments?: TaskNote[];
  edited?: Record<string, { at?: string; by?: string | null }> | null;
  status_at?: string | null;
  status_note?: string | null;
  ready?: boolean;
};

/** A field of the task the owner may edit: the title and every body section. */
export type Field =
  | "title"
  | "value"
  | "what"
  | "why"
  | "alternatives"
  | "how"
  | "snippets"
  | "use"
  | "verify"
  | "rollback"
  | "files"
  | "refs"
  | "notes";

/** The body sections in drawer order: field, label, icon (work.js SECS). */
const SECS: readonly (readonly [Field, string, IconName])[] = [
  ["value", "Done means", "checkc"],
  ["what", "What it is", "file"],
  ["why", "Why, and why now", "ask"],
  ["alternatives", "Why not another way", "turn"],
  ["how", "How", "list"],
  ["snippets", "Code", "code"],
  ["use", "How to use it", "terminal"],
  ["verify", "How to check it", "check"],
  ["rollback", "How to undo it", "undo"],
  ["files", "Files", "folder"],
  ["refs", "References", "hash"],
  ["notes", "Notes and gaps", "alert"],
];

const LABEL_OF: ReadonlyMap<Field, string> = new Map(SECS.map(([f, l]) => [f, l] as const));

/** Fields whose value is a list of lines, edited one per line (work.js LINE_FIELDS). */
const LINE_FIELDS: ReadonlySet<Field> = new Set<Field>(["how", "files", "refs"]);

/** Fields whose value is JSON, edited as JSON text (work.js JSONF). */
const JSON_FIELDS: ReadonlySet<Field> = new Set<Field>(["alternatives", "snippets", "verify"]);

/** The kinds a note can have, in strip order (work.js NOTE_KINDS). */
export const NOTE_KINDS: readonly (readonly [string, string])[] = [
  ["change", "Change"],
  ["question", "Question"],
  ["direction", "Direction"],
  ["optimize", "Optimize"],
  ["enhance", "Enhance"],
  ["note", "Note"],
];

/** The help line under an editor, per field kind (work.js editor). */
export function editHelp(f: Field): string {
  if (LINE_FIELDS.has(f)) return "One item per line.";
  if (JSON_FIELDS.has(f))
    return `JSON: ${
      (
        {
          alternatives: '[{"option": "…", "why_not": "…"}]',
          snippets: '[{"title", "lang", "path", "proposed", "code"}]',
          verify: '[{"cmd": "…", "expect": "…"}]',
        } as Record<Field, string>
      )[f]
    }`;
  return "Plain text; `code` and **bold** work.";
}

/** A field counts as filled when its list has a row or its text survives a trim (work.js filled). */
export function filled(t: TaskDetail, f: Field): boolean {
  const v: unknown = t[f];
  return Array.isArray(v) ? v.length > 0 : !!String(v ?? "").trim();
}

/** The raw text an editor opens with, per field kind (work.js editor). */
export function editText(f: Field, v: unknown): string {
  if (LINE_FIELDS.has(f)) return Array.isArray(v) ? v.map((x) => String(x)).join("\n") : "";
  if (JSON_FIELDS.has(f)) return JSON.stringify(Array.isArray(v) && v.length > 0 ? v : [], null, 2);
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** The parsed value of an editor's text: lines, JSON, or the text itself (work.js saveEdit). */
export function parseEdit(
  f: Field,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (LINE_FIELDS.has(f))
    return {
      ok: true,
      value: raw
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    };
  if (JSON_FIELDS.has(f)) {
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, value: raw };
}

/** Who the owner select offers: the sessions that stayed, plus a current owner the roster lost. */
export function ownerOptions(
  sessions: SessionList | null | undefined,
  cur: string | null | undefined,
): { value: string; label: string }[] {
  const names = (sessions?.sessions ?? []).filter((s) => s.state !== "left").map((s) => s.name);
  if (cur && !names.includes(cur) && cur !== "owner") names.push(cur);
  return [
    { value: "", label: "Nobody" },
    { value: "owner", label: "Me" },
    ...names.map((n) => ({ value: n, label: n })),
  ];
}

/** Has this gated task been approved? A direction note that says so is the record: the server
 *  writes "Approved by the owner" or "Approved by <name>" when another session approves, and it
 *  hides a gate from the Inbox on the same broad shape. */
export function isApproved(t: TaskDetail): boolean {
  return (t.comments ?? []).some((c) => c.kind === "direction" && /^Approved by /.test(c.body ?? ""));
}

/** One snippet-drift row, as GET /repo/drift returns it. */
export type DriftRow = { step?: string; i?: number; state?: string; score?: number; path?: string };

/** The pill a drift state wears: its word, its icon, its badge tone (work.js snipBody dState). */
export function driftMeta(d: DriftRow): { word: string; icon: IconName; badge: string } {
  if (d.state === "ok") return { word: "Matches the repo", icon: "check", badge: "badge-success" };
  if (d.state === "partial") return { word: "Partly changed", icon: "alert", badge: "badge-warning" };
  if (d.state === "missing") return { word: "File missing", icon: "x", badge: "badge-error" };
  return { word: "Drifted from the repo", icon: "x", badge: "badge-error" };
}

/** The status model's view of a step, for the pills and the picker. GET /task/<id> sends no
 *  blocked_by: its `unmet` rows name the unfinished dependencies, so they stand in for them. */
const asTask = (s: Pick<PlanStep, "status" | "blocked_by"> & { unmet?: readonly TaskUnmet[] }): Task => ({
  status: s.status ?? "todo",
  blocked_by: s.blocked_by ?? (s.unmet ?? []).map((u) => u.id),
});

/** The pool the dependency picker ranks: every task of the board with its status model. */
const pickerPool = (board: Board | null | undefined): PickerTask[] =>
  ((board?.steps ?? []) as readonly Step[]).map((s) => ({
    id: s.id,
    title: s.title ?? "",
    status: s.status ?? "todo",
    ...(s.blocked_by ? { blocked_by: s.blocked_by } : {}),
    ...(s.unmet ? { unmet: s.unmet } : {}),
  }));

/** The verify ticks this browser kept for one task: the checked indexes (work.js "ck:" keys). */
export function readTicks(store: Storage, ch: string, id: string): ReadonlySet<number> {
  const m = readPref<Record<string, boolean>>(store, `ck:${ch}:${id}`, {});
  return new Set(
    Object.entries(m)
      .filter(([, v]) => v === true)
      .map(([k]) => Number(k))
      .filter((n) => Number.isInteger(n)),
  );
}

/** Keeps or clears one tick of a task's checks (work.js data-ck). */
export function writeTick(store: Storage, ch: string, id: string, i: number, on: boolean): void {
  const m = readPref<Record<string, boolean>>(store, `ck:${ch}:${id}`, {});
  if (on) m[String(i)] = true;
  else delete m[String(i)];
  writePref(store, `ck:${ch}:${id}`, m);
}

/** One file excerpt as GET /repo/code returns it. */
export type RepoCode = {
  dir?: boolean;
  missing?: boolean;
  error?: string;
  binary?: boolean;
  size?: number;
  excerpt?: string;
  from?: number;
  total?: number;
};

/** What the drawer holds while it reads one file: its path, its phase, and what came back. */
type FileState = { path: string; phase: "loading" | "ready" | "error"; data?: RepoCode; error?: string };

/** The drawer's props: the open task's id (?t=), the channel's data, and the ways out. */
export type TaskDrawerProps = {
  /** The task the address names; null closes the drawer. */
  id: string | null | undefined;
  /** The open channel; without one nothing shows. */
  ch: string | null;
  api: Api;
  /** This paint's time, for everything relative. */
  now: number;
  /** The board, for the position line, the prev/next steps and the picker's pool. */
  board: Board | null;
  /** The board's steps by id, as the store keeps them. */
  byId: Map<string, PlanStep>;
  /** The roster, for the owner select and the sessions on this task. */
  sessions: SessionList | null;
  /** The channel's repo views (info.views): "code" makes file chips open, "drift" loads drift. */
  views: readonly string[];
  toast: ToastFn;
  /** Writes to the clipboard and says so (core.js copy). */
  copy: (text: string, message?: string) => void;
  /** Site storage (localStorage), injectable: note kind, verify ticks, snippet tab. */
  store: Storage;
  /** The store, when the shell hands it over: board and task changes refresh the open task. */
  live?: HuddleStore | undefined;
  /** Closes the drawer: the shell drops ?t= from the address. */
  onClose: () => void;
  /** Opens another task's drawer (prev/next, dependencies, blockers). */
  onOpenTask: (id: string) => void;
  /** Opens a session's drawer. */
  onOpenSession: (name: string) => void;
  /** Reloads the board after a change (the store's loadBoard). */
  reloadBoard?: (() => unknown) | undefined;
  /** Refills the Inbox after a change (data.js's attChanged). */
  touchAttention?: (() => void) | undefined;
};

/** A file chip: a button into the excerpt when the channel serves the code view, else plain. */
function FileChip({
  path,
  hasCode,
  onOpenFile,
}: {
  path: string;
  hasCode: boolean;
  onOpenFile: (p: string) => void;
}): JSX.Element {
  return hasCode ? (
    <button
      type="button"
      class="badge badge-ghost gap-1.5 font-mono hover:underline"
      data-file={path}
      title={path}
      onClick={() => onOpenFile(path)}
    >
      <Icon name="file" class="size-3.5" />
      <span class="max-w-56 truncate">{path}</span>
    </button>
  ) : (
    <span class="badge badge-ghost gap-1.5 font-mono" title={path}>
      <Icon name="file" class="size-3.5" />
      <span class="max-w-56 truncate">{path}</span>
    </span>
  );
}

/** The "Edited …/Undo edit" tag of an edited field (work.js edMark). */
function EditedMark({
  f,
  task,
  now,
  onRevert,
}: {
  f: Field;
  task: TaskDetail;
  now: number;
  onRevert: (f: Field) => void;
}): JSX.Element | null {
  const e = task.edited?.[f];
  if (!e) return null;
  return (
    <span class="badge badge-ghost badge-sm gap-1" data-edited={f}>
      <span>
        Edited {e.at ? <Time ts={e.at} now={now} /> : ""}
        {e.by && e.by !== "owner" ? ` by ${e.by}` : ""}
      </span>
      <button type="button" class="underline underline-offset-2" data-revert={f} onClick={() => onRevert(f)}>
        Undo edit
      </button>
    </span>
  );
}

/** A session's derived status as its coloured icon with a screen-reader word. */
function SessionDot({ k }: { k: SessionStatus }): JSX.Element {
  const m = SSTM[k];
  return (
    <span class={`${m.c} ink inline-flex`} title={m.l}>
      <Icon name={m.i} class="size-3" />
      <span class="sr-only">{m.l}</span>
    </span>
  );
}

/** One quoted snippet with its tabs, its drift pill and its code (work.js snipBody). */
function SnippetBody({
  task,
  snips,
  at,
  drift,
  hasCode,
  onPick,
  onCopy,
  onOpenFile,
}: {
  task: TaskDetail;
  snips: TaskSnippet[];
  at: number;
  drift: ReadonlyMap<string, DriftRow> | null;
  hasCode: boolean;
  onPick: (i: number) => void;
  onCopy: (code: string) => void;
  onOpenFile: (p: string) => void;
}): JSX.Element | null {
  const s = snips[at];
  if (!s) return null;
  const d = drift?.get(`${task.id}:${at}`);
  const dm = d ? driftMeta(d) : null;
  return (
    <>
      {snips.length > 1 ? (
        <div class="tabs tabs-box mx-4 mt-3 w-fit" role="tablist" aria-label="Snippets">
          {snips.map((x, k) => (
            <button
              type="button"
              key={k}
              role="tab"
              class={`tab ${k === at ? "tab-active" : ""}`}
              data-tab={k}
              aria-selected={k === at}
              onClick={() => onPick(k)}
            >
              {x.title || x.path || `Snippet ${k + 1}`}
            </button>
          ))}
        </div>
      ) : null}
      <div class="flex flex-wrap items-center gap-2 px-4 py-2.5 text-meta">
        {snips.length === 1 && s.title ? <b class="font-semibold">{s.title}</b> : null}
        {s.path ? <FileChip path={s.path} hasCode={hasCode} onOpenFile={onOpenFile} /> : null}
        {s.proposed ? <span class="badge badge-warning badge-sm">Proposed: not in the repo yet</span> : null}
        {dm ? (
          <span
            class={`badge badge-sm gap-1 ${dm.badge}`}
            title={`${d?.score ?? ""}% of its lines are still in the file`}
          >
            <Icon name={dm.icon} class="size-3.5" />
            {dm.word}
          </span>
        ) : null}
        <span class="flex-1" />
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-copysnip={at}
          onClick={() => onCopy(s.code ?? "")}
        >
          <Icon name="copy" class="size-4.5" />
          Copy
        </button>
      </div>
      <CodeBlock
        code={s.code ?? ""}
        lang={s.lang ?? langOf(s.path ?? "")}
        class="rounded-b-box border-t border-base-content/8"
      />
    </>
  );
}

/** The verify list: one ticked row per check, its command and what to expect (work.js secBody). */
function VerifyList({
  items,
  ticks,
  onTick,
  onCopy,
}: {
  items: TaskVerify[];
  ticks: ReadonlySet<number>;
  onTick: (i: number, on: boolean) => void;
  onCopy: (cmd: string) => void;
}): JSX.Element {
  return (
    <ul class="flex flex-col gap-3">
      {items.map((x, i) => (
        <li key={i} class={`flex items-start gap-3 ${ticks.has(i) ? "opacity-70" : ""}`} data-ck={i}>
          <input
            type="checkbox"
            class="checkbox mt-1"
            checked={ticks.has(i)}
            aria-label={`Checked: ${x.cmd ?? ""}`}
            onChange={(e) => onTick(i, e.currentTarget.checked)}
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-stretch gap-1 rounded-lg bg-base-200">
              <code class="min-w-0 flex-1 overflow-x-auto px-3 py-2 text-sm whitespace-pre">{x.cmd}</code>
              <button
                type="button"
                class="btn btn-ghost btn-square btn-sm my-1 mr-1"
                aria-label="Copy the command"
                onClick={() => onCopy(x.cmd ?? "")}
              >
                <Icon name="copy" class="size-4.5" />
              </button>
            </div>
            {x.expect ? (
              <div class="mt-1.5 text-meta muted">
                Expect: <Inline text={x.expect} />
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One body section's content, by field; the snippets body has its own component (work.js secBody). */
function SectionBody({
  f,
  task,
  ticks,
  hasCode,
  onTick,
  onCopy,
  onOpenFile,
}: {
  f: Field;
  task: TaskDetail;
  ticks: ReadonlySet<number>;
  hasCode: boolean;
  onTick: (i: number, on: boolean) => void;
  onCopy: (text: string) => void;
  onOpenFile: (p: string) => void;
}): JSX.Element {
  switch (f) {
    case "alternatives":
      return (
        <div class="flex flex-col divide-y divide-base-content/10">
          {(task.alternatives ?? []).map((a, i) => (
            <div
              key={i}
              class="grid gap-1 py-2 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4"
            >
              <div class="font-medium">
                <Inline text={a.option} />
              </div>
              <div class="muted">
                <Inline text={a.why_not} />
              </div>
            </div>
          ))}
        </div>
      );
    case "how":
      return (
        <ol class="list-decimal pl-5">
          {(task.how ?? []).map((h, i) => (
            <li key={i} class="my-1">
              <Inline text={h} />
            </li>
          ))}
        </ol>
      );
    case "verify":
      return <VerifyList items={task.verify ?? []} ticks={ticks} onTick={onTick} onCopy={onCopy} />;
    case "files":
      return (
        <div class="flex flex-wrap gap-1.5">
          {(task.files ?? []).map((p, i) => (
            <FileChip key={`${i} ${p}`} path={p} hasCode={hasCode} onOpenFile={onOpenFile} />
          ))}
        </div>
      );
    case "refs":
      return (
        <div class="flex flex-wrap gap-1.5">
          {(task.refs ?? []).map((r, i) => (
            <span key={`${i} ${r}`} class="badge badge-ghost">
              <Inline text={r} />
            </span>
          ))}
        </div>
      );
    default:
      return <Paragraphs text={typeof task[f] === "string" ? (task[f] as string) : ""} />;
  }
}

/** The one card of a filled (or open) section, with its Edit button and edited mark. */
function SectionCard({
  f,
  task,
  now,
  editing,
  children,
  onEdit,
  onRevert,
}: {
  f: Field;
  task: TaskDetail;
  now: number;
  editing: boolean;
  children: JSX.Element;
  onEdit: (f: Field) => void;
  onRevert: (f: Field) => void;
}): JSX.Element {
  const label = LABEL_OF.get(f) ?? f;
  const icon = SECS.find((x) => x[0] === f)?.[2] ?? "file";
  return (
    <section class="panel min-w-0" aria-labelledby={`sh-${f}`} data-sec={f}>
      <div class="flex min-h-11 flex-wrap items-center gap-2 border-b border-base-content/8 px-4 py-2">
        <h3 id={`sh-${f}`} class="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <span class="text-primary">
            <Icon name={icon} class="size-4.5" />
          </span>
          {label}
        </h3>
        {editing ? null : <EditedMark f={f} task={task} now={now} onRevert={onRevert} />}
        <button type="button" class="btn btn-ghost btn-sm" data-edit={f} onClick={() => onEdit(f)}>
          <Icon name="pencil" class="size-4.5" />
          Edit
          <span class="sr-only"> {label}</span>
        </button>
      </div>
      {editing ? (
        <div class="p-4">{children}</div>
      ) : f === "snippets" ? (
        children
      ) : (
        <div class="prose-h p-4">{children}</div>
      )}
    </section>
  );
}

/** The wait's plain words: who owns what it waits on, and in which state it sits. */
function UnmetBox({
  unmet,
  owner,
  onOpenTask,
}: {
  unmet: TaskUnmet[];
  owner: string | null | undefined;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  return (
    <div role="alert" class="alert alert-warning alert-soft items-start text-[0.9375rem]" data-unmet>
      <span class="mt-0.5 shrink-0">
        <Icon name="hourglass" class="size-5" />
      </span>
      <span>
        It waits on{" "}
        {unmet.map((u, i) => (
          <span key={u.id}>
            {i > 0 ? ", " : ""}
            <button
              type="button"
              class="font-medium underline underline-offset-2"
              onClick={() => onOpenTask(u.id)}
            >
              {u.id}
            </button>{" "}
            ({u.owner ? whoL(u.owner) : "nobody"},{" "}
            {STATM[u.status as TaskState]?.l?.toLowerCase() ?? u.status})
          </span>
        ))}
        . “Doing” is refused until they are done or skipped; {owner ? whoL(owner) : "its owner"} is woken
        then.
      </span>
    </div>
  );
}

/** The approval box of a gated task: the ask, the note variant, the Approve button. */
function GateBox({
  task,
  approved,
  noteOpen,
  note,
  busy,
  onNote,
  onNoteClose,
  onNoteText,
  onApprove,
}: {
  task: TaskDetail;
  approved: boolean;
  noteOpen: boolean;
  note: string;
  busy: boolean;
  onNote: () => void;
  onNoteClose: () => void;
  onNoteText: (t: string) => void;
  onApprove: () => void;
}): JSX.Element {
  const owner = task.owner && task.owner !== "owner" ? task.owner : null;
  return (
    <div role="alert" class="alert items-start sm:items-center" data-gate>
      <span class="shrink-0">
        <Icon name={approved ? "checkc" : "key"} class="size-5" />
      </span>
      <span class="min-w-0 flex-1 text-[0.9375rem]">
        {approved
          ? "You approved it."
          : `${owner ? `${owner} waits` : "It waits"} for your go-ahead before it starts.`}
      </span>
      {approved ? null : (
        <div class="flex flex-wrap items-center gap-2">
          {noteOpen ? (
            <>
              <label class="sr-only" for="gnote">
                Note
              </label>
              <input
                id="gnote"
                class="input w-52"
                placeholder={`Note for ${owner ?? "the session"}`}
                value={note}
                onInput={(e) => onNoteText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onApprove();
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onNoteClose();
                  }
                }}
              />
            </>
          ) : (
            <button type="button" class="btn" data-approve-note onClick={onNote}>
              With a note
            </button>
          )}
          <button type="button" class="btn btn-primary" data-approve disabled={busy} onClick={onApprove}>
            <Icon name="check" class="size-4.5" />
            Approve
          </button>
        </div>
      )}
    </div>
  );
}

/** The notes panel: the kind strip, the composer and every note with its controls. */
function NotesPanel({
  task,
  kind,
  now,
  taRef,
  onKind,
  onAdd,
  onResolve,
  onDelete,
}: {
  task: TaskDetail;
  kind: string;
  now: number;
  taRef: RefObject<HTMLTextAreaElement | null>;
  onKind: (k: string) => void;
  onAdd: () => void;
  onResolve: (id: number, resolved: boolean) => void;
  onDelete: (id: number) => void;
}): JSX.Element {
  const notes = task.comments ?? [];
  const open = notes.filter((c) => !c.resolved).length;
  const wordOf = (k: string | null | undefined): string => NOTE_KINDS.find((x) => x[0] === k)?.[1] ?? k ?? "";
  return (
    <section class="panel min-w-0" aria-labelledby="nt-h">
      <div class="flex flex-wrap items-center gap-2 border-b border-base-content/8 px-4 py-2.5">
        <h3 id="nt-h" class="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <span class="text-primary">
            <Icon name="note" class="size-4.5" />
          </span>
          Notes for the sessions
        </h3>
        {open > 0 ? <span class="badge badge-sm badge-primary badge-soft">{open} open</span> : null}
      </div>
      <div class="flex flex-col gap-3 p-4">
        <p class="text-meta muted">Sessions read open notes before the task text, and the notes win.</p>
        {/* biome-ignore lint/a11y/useSemanticElements: the kind strip's group role */}
        <div class="join flex-wrap" role="group" aria-label="Kind of note">
          {NOTE_KINDS.map(([k, l]) => (
            <button
              type="button"
              key={k}
              class={`btn join-item btn-sm${kind === k ? " btn-primary" : ""}`}
              data-kind={k}
              aria-pressed={kind === k}
              onClick={() => onKind(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <label class="sr-only" for="cbody">
          Note
        </label>
        <textarea
          id="cbody"
          ref={taRef}
          rows={3}
          class="textarea"
          placeholder="What should change, be checked or done differently?"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <div class="flex items-center gap-2">
          <button type="button" id="csave" class="btn btn-primary" onClick={onAdd}>
            Add note
          </button>
          <span class="text-meta muted">
            <kbd class="kbd">⌘</kbd>
            <kbd class="kbd">↵</kbd>
          </span>
        </div>
        {notes.length > 0 ? (
          <ul class="mt-1 divide-y divide-base-content/10">
            {[...notes].reverse().map((c) => (
              <li
                key={c.id}
                class={`flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0 ${c.resolved ? "opacity-75" : ""}`}
                data-note={c.id}
              >
                <div class="flex flex-wrap items-center gap-1.5 text-meta">
                  <span class="badge badge-ghost badge-sm">{wordOf(c.kind)}</span>
                  <span class="text-base-content/50">
                    {who(c.by ?? "")}, <Time ts={c.created_at} now={now} />
                  </span>
                  {c.resolved ? (
                    <span class="badge badge-success badge-sm badge-soft gap-1">
                      <Icon name="check" class="size-3.5" />
                      Resolved
                    </span>
                  ) : null}
                  <span class="flex-1" />
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    data-res={c.id}
                    onClick={() => onResolve(c.id, !c.resolved)}
                  >
                    {c.resolved ? (
                      "Reopen"
                    ) : (
                      <>
                        <Icon name="check" class="size-4" />
                        Resolve
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-square btn-sm"
                    aria-label="Delete this note"
                    data-del={c.id}
                    onClick={() => onDelete(c.id)}
                  >
                    <Icon name="trash" class="size-4.5" />
                  </button>
                </div>
                <div class="text-[0.9375rem] whitespace-pre-wrap">{c.body}</div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

/** The file excerpt's body: the words for a folder, a missing or binary file, else the lines. */
function FileBody({ st }: { st: FileState }): JSX.Element {
  if (st.phase === "loading")
    return (
      <div class="p-4">
        <Skeleton rows={3} class="h-6" />
      </div>
    );
  if (st.phase === "error")
    return (
      <div class="p-6 text-center text-sm text-error" role="alert">
        {st.error}
      </div>
    );
  const r = st.data;
  if (r?.dir) return <p class="p-6 text-center text-sm muted">That is a folder; the repo views list it.</p>;
  if (r?.missing)
    return <p class="p-6 text-center text-sm muted">Not in the repo yet: this task creates it.</p>;
  if (r?.error)
    return (
      <div class="p-6 text-center text-sm text-error" role="alert">
        {r.error}
      </div>
    );
  if (r?.binary) return <p class="p-6 text-center text-sm muted">A binary file ({r.size ?? 0} bytes).</p>;
  const from = r?.from ?? 1;
  return (
    <>
      <div class="flex items-center gap-2 border-b border-base-content/8 px-4 py-2.5 text-meta muted">
        <span class="tnum">
          Lines {from} to {Math.min(from + 79, r?.total ?? 0)} of {r?.total ?? 0}
        </span>
      </div>
      <CodeBlock code={r?.excerpt ?? ""} lang={langOf(st.path)} />
    </>
  );
}

/** One editor over a field: the textarea, Save/Cancel, the help line and the error (work.js editor). */
function Editor({
  f,
  task,
  taRef,
  error,
  onText,
  onSave,
  onCancel,
}: {
  f: Field;
  task: TaskDetail;
  taRef: RefObject<HTMLTextAreaElement | null>;
  error: string;
  /** The text moved: an editor's error line gives the reader a clean slate. */
  onText: () => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const json = JSON_FIELDS.has(f);
  return (
    <div data-editor={f}>
      <label class="sr-only" for="edta">
        Edit {LABEL_OF.get(f) ?? f}
      </label>
      <textarea
        id="edta"
        ref={taRef}
        class={`textarea${json ? " font-mono text-sm" : ""}`}
        spellcheck={!json}
        defaultValue={editText(f, f === "title" ? task.title : task[f])}
        style={`min-height:${f === "title" ? "52px" : json ? "240px" : "120px"}`}
        aria-describedby="edh"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        onInput={onText}
      />
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" id="edsave" class="btn btn-primary" onClick={onSave}>
          Save
        </button>
        <button type="button" id="edcancel" class="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <span class="text-meta muted" id="edh">
          {editHelp(f)} <kbd class="kbd">⌘</kbd>
          <kbd class="kbd">↵</kbd> saves.
        </span>
      </div>
      {error ? (
        <p class="mt-1 text-sm text-error" id="ederr" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The moves an open editor takes, handed down from the drawer. */
export type EditCtl = {
  /** The field being edited, null when none is. */
  field: Field | null;
  /** The editor's error line. */
  error: string;
  open(f: Field): void;
  cancel(): void;
  save(): void;
  clear(): void;
  /** Restores a field to the plan's text (work.js data-revert). */
  revert(f: Field): void;
  /** The editor's textarea. */
  ta: RefObject<HTMLTextAreaElement | null>;
};

/** The gate's approval box, handed down from the drawer. */
export type GateCtl = {
  approved: boolean;
  /** The note field is open. */
  noteOpen: boolean;
  text: string;
  busy: boolean;
  showNote(): void;
  hideNote(): void;
  writeNote(t: string): void;
  approve(): void;
};

/** The notes panel's moves, handed down from the drawer. */
export type NotesCtl = {
  kind: string;
  pick(k: string): void;
  add(): void;
  resolve(id: number, resolved: boolean): void;
  remove(id: number): void;
  ta: RefObject<HTMLTextAreaElement | null>;
};

/** Everything the drawer's body does, built once per render in the drawer. */
export type DrawerCtl = {
  edit: EditCtl;
  status: { note: string; write(v: string): void; set(st: TaskStatus): void };
  assign: { owner(to: string): void; deps(ids: string[]): void };
  gate: GateCtl;
  notes: NotesCtl;
  body: {
    ticks: ReadonlySet<number>;
    tick(i: number, on: boolean): void;
    drift: ReadonlyMap<string, DriftRow> | null;
    hasCode: boolean;
    openFile(p: string): void;
    copy(text: string, message?: string): void;
    snipAt: number;
    pickSnippet(i: number): void;
  };
};

/** The drawer's body props: the open task, its control bundle, the active tab, and the ways out. */
type TaskBodyProps = {
  t: TaskDetail;
  ch: string;
  now: number;
  board: Board | null;
  byId: Map<string, PlanStep>;
  sessions: SessionList | null;
  ctl: DrawerCtl;
  /** The tab whose panel shows. */
  tab: DrawerTab;
  /** Switches the drawer's tab (the Add section menu lands code fields on Code). */
  onTab: (t: DrawerTab) => void;
  onOpenTask: (id: string) => void;
  onOpenSession: (name: string) => void;
};

/** The body fields that live on the Code tab (work.js kept them inline; the tabs split them out). */
const CODE_FIELDS: ReadonlySet<Field> = new Set<Field>(["snippets", "files", "refs"]);

/** The drawer's body: the title and controls on Overview, the code sections on Code, the notes on
 *  Notes — one daisyUI tabpanel each, only the active one shown. */
function TaskBody({
  t,
  ch,
  now,
  board,
  byId,
  sessions,
  ctl,
  tab,
  onTab,
  onOpenTask,
  onOpenSession,
}: TaskBodyProps): JSX.Element {
  // the "Add section" menu's state lives here: only this list knows what is missing
  const [addOpen, setAddOpen] = useState(false);
  const [addBtn, setAddBtn] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    setAddOpen(false);
  }, [t.id]);

  const shown = SECS.filter(([f]) => filled(t, f) || ctl.edit.field === f);
  const missing = SECS.map(([f]) => f).filter((f) => !filled(t, f) && ctl.edit.field !== f);
  const addItems: MenuItem[] = missing.map((f) => ({
    label: LABEL_OF.get(f) ?? f,
    run: () => {
      if (CODE_FIELDS.has(f)) onTab("code");
      ctl.edit.open(f);
    },
  }));
  const overview = shown.filter(([f]) => !CODE_FIELDS.has(f));
  const code = shown.filter(([f]) => CODE_FIELDS.has(f));
  const panel = (id: DrawerTab, children: ComponentChildren): JSX.Element => (
    <div
      role="tabpanel"
      id={`tp-${id}`}
      aria-labelledby={`tt-${id}`}
      class={`flex flex-col gap-4${tab === id ? "" : " hidden"}`}
    >
      {children}
    </div>
  );
  const editFor = (f: Field): JSX.Element => (
    <Editor
      f={f}
      task={t}
      taRef={ctl.edit.ta}
      error={ctl.edit.error}
      onText={ctl.edit.clear}
      onSave={ctl.edit.save}
      onCancel={ctl.edit.cancel}
    />
  );
  return (
    <>
      {panel(
        "overview",
        <>
          {ctl.edit.field === "title" ? (
            editFor("title")
          ) : (
            <div class="flex items-start gap-2">
              <h2 class="min-w-0 flex-1 text-xl leading-snug font-semibold" data-title>
                {t.title}
              </h2>
              <EditedMark f="title" task={t} now={now} onRevert={ctl.edit.revert} />
              <button
                type="button"
                class="btn btn-ghost btn-square btn-sm"
                data-edit="title"
                aria-label="Edit the title"
                onClick={() => ctl.edit.open("title")}
              >
                <Icon name="pencil" class="size-4.5" />
              </button>
            </div>
          )}
          <ControlSection
            t={t}
            ch={ch}
            now={now}
            sessions={sessions}
            board={board}
            byId={byId}
            ctl={ctl}
            onOpenTask={onOpenTask}
            onOpenSession={onOpenSession}
          />
          {overview.map(([f]) => (
            <SectionCard
              key={f}
              f={f}
              task={t}
              now={now}
              editing={ctl.edit.field === f}
              onEdit={ctl.edit.open}
              onRevert={ctl.edit.revert}
            >
              {ctl.edit.field === f ? (
                editFor(f)
              ) : (
                <SectionBody
                  f={f}
                  task={t}
                  ticks={ctl.body.ticks}
                  hasCode={ctl.body.hasCode}
                  onTick={ctl.body.tick}
                  onCopy={(text) => ctl.body.copy(text, "Copied")}
                  onOpenFile={ctl.body.openFile}
                />
              )}
            </SectionCard>
          ))}
          {missing.length > 0 ? (
            <div>
              <button
                type="button"
                ref={setAddBtn}
                id="addsec"
                class="btn"
                aria-haspopup="menu"
                aria-expanded={addOpen}
                onClick={() => setAddOpen(true)}
              >
                <Icon name="plus" class="size-4.5" />
                Add section
              </button>
            </div>
          ) : null}
          {addOpen && addBtn ? (
            <PopMenu anchor={addBtn} items={addItems} onClose={() => setAddOpen(false)} />
          ) : null}
        </>,
      )}
      {panel(
        "code",
        code.length ? (
          code.map(([f]) => (
            <SectionCard
              key={f}
              f={f}
              task={t}
              now={now}
              editing={ctl.edit.field === f}
              onEdit={ctl.edit.open}
              onRevert={ctl.edit.revert}
            >
              {ctl.edit.field === f ? (
                editFor(f)
              ) : f === "snippets" ? (
                <SnippetBody
                  task={t}
                  snips={t.snippets ?? []}
                  at={ctl.body.snipAt}
                  drift={ctl.body.drift}
                  hasCode={ctl.body.hasCode}
                  onPick={ctl.body.pickSnippet}
                  onCopy={(codeText) => ctl.body.copy(codeText, "Copied the snippet")}
                  onOpenFile={ctl.body.openFile}
                />
              ) : (
                <SectionBody
                  f={f}
                  task={t}
                  ticks={ctl.body.ticks}
                  hasCode={ctl.body.hasCode}
                  onTick={ctl.body.tick}
                  onCopy={(text) => ctl.body.copy(text, "Copied")}
                  onOpenFile={ctl.body.openFile}
                />
              )}
            </SectionCard>
          ))
        ) : (
          <p class="rounded-box border border-dashed border-base-content/20 px-6 py-10 text-center text-sm muted">
            No snippets, files or references yet. Add one with “Add section” on Overview.
          </p>
        ),
      )}
      {panel(
        "notes",
        <NotesPanel
          task={t}
          kind={ctl.notes.kind}
          now={now}
          taRef={ctl.notes.ta}
          onKind={ctl.notes.pick}
          onAdd={ctl.notes.add}
          onResolve={ctl.notes.resolve}
          onDelete={ctl.notes.remove}
        />,
      )}
    </>
  );
}

/** How far the drawer's fetch of one task got. */
type Phase = "loading" | "ready" | "missing";

/** The status strip: the segment with its note, and who set the status last (work.js renderTask). */
function StatusStrip({
  t,
  now,
  note,
  onNote,
  onSet,
}: {
  t: TaskDetail;
  now: number;
  note: string;
  onNote: (v: string) => void;
  onSet: (st: TaskStatus) => void;
}): JSX.Element {
  return (
    <>
      <div class="flex flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: the status strip's group role */}
        <div class="join" role="group" aria-label="Status">
          {STAT.map((x, n) => (
            <button
              type="button"
              key={x}
              class={`btn join-item btn-sm${t.status === x ? " btn-primary" : ""}`}
              data-st={x}
              aria-pressed={t.status === x}
              aria-keyshortcuts={String(n + 1)}
              title={`${STATM[x].l} (${n + 1})`}
              onClick={() => onSet(x)}
            >
              <span class={`${STATM[x].c} ink`}>
                <Icon name={STATM[x].i} class="size-4.5" />
              </span>
              {STATM[x].l}
            </button>
          ))}
        </div>
        {taskState(asTask(t)) === "waiting" ? <Pill status="waiting" /> : null}
      </div>
      <label class="sr-only" for="stnote">
        Evidence or reason for the next status change
      </label>
      <input
        id="stnote"
        class="input"
        placeholder="Evidence or reason for the next change (optional)"
        value={note}
        onInput={(e) => onNote(e.currentTarget.value)}
      />
      {t.status_by ? (
        <p class="text-meta muted" data-status-by>
          {STATM[t.status as TaskState]?.l ?? t.status} by {whoL(t.status_by)}{" "}
          {t.status_at ? <Time ts={t.status_at} now={now} /> : null}
          {t.status_note ? `: “${t.status_note}”` : ""}
        </p>
      ) : null}
    </>
  );
}

/** The task's own tags: kind, gate, risk; nothing when the plan gave it none. */
function DetailsTags({ t }: { t: TaskDetail }): JSX.Element | null {
  if (!t.kind && !t.risk && !(t.gate && t.gate !== "none")) return null;
  return (
    <>
      <span class="text-sm font-medium muted sm:col-span-2 sm:text-left">Details</span>
      <div class="flex flex-wrap gap-1.5 sm:col-span-2" data-details>
        {t.kind ? <span class="badge badge-ghost">{t.kind}</span> : null}
        {t.gate && t.gate !== "none" ? (
          <span class="badge badge-ghost gap-1.5">
            <Icon name="key" class="size-4" />
            {t.gate === "owner" ? "Needs your approval" : "Ask first"}
          </span>
        ) : null}
        {t.risk ? <span class="badge badge-ghost">{t.risk} risk</span> : null}
      </div>
    </>
  );
}

/** Owner, the sessions on it, and the two dependency directions, labelled both ways. */
function MetaGrid({
  t,
  ch,
  sessions,
  board,
  byId,
  onOwner,
  onDeps,
  onOpenSession,
  onOpenTask,
}: {
  t: TaskDetail;
  ch: string;
  sessions: SessionList | null;
  board: Board | null;
  byId: Map<string, PlanStep>;
  onOwner: (to: string) => void;
  onDeps: (ids: string[]) => void;
  onOpenSession: (name: string) => void;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  const taskById = (tid: string): Task | null => {
    const s = byId.get(tid);
    return s ? asTask(s) : null;
  };
  const onIt = (sessions?.sessions ?? []).filter((x) => x.step === t.id && x.state !== "left");
  return (
    <div class="grid gap-x-4 gap-y-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center">
      <label class="text-sm font-medium muted" for="owner-sel">
        Owner
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <select
          id="owner-sel"
          class="select w-auto"
          value={t.owner ?? ""}
          onChange={(e) => onOwner(e.currentTarget.value)}
        >
          {ownerOptions(sessions, t.owner).map((o) => (
            <option key={o.value || "-"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {onIt.map((x) => {
          const k = sessionStatus(x, taskById);
          return (
            <a
              key={x.name}
              class="badge badge-ghost gap-1.5 hover:underline"
              href={`#/c/${ch}/team?s=${encodeURIComponent(x.name)}`}
              title={`${x.name} has this task: ${k}`}
              onClick={(e) => {
                e.preventDefault();
                onOpenSession(x.name);
              }}
            >
              <SessionDot k={k} />
              {x.name}: {k}
            </a>
          );
        })}
      </div>
      <label class="text-sm font-medium muted" for={`dep-${t.id}-q`}>
        Blocked by
      </label>
      <Picker
        id={`dep-${t.id}`}
        value={t.depends ?? []}
        tasks={pickerPool(board)}
        byId={(tid) => {
          const s = byId.get(tid);
          return s ? { ...asTask(s), title: s.title ?? "" } : null;
        }}
        exclude={t.id}
        placeholder="Add a task it waits on"
        label="Add a task it waits on"
        onChange={onDeps}
      />
      {(t.needed_by?.length ?? 0) > 0 ? (
        <>
          <span class="text-sm font-medium muted">Blocks</span>
          <div class="flex flex-wrap gap-1.5" data-blocks>
            {(t.needed_by ?? []).map((tid) => {
              const s = byId.get(tid);
              const k = s ? taskState(asTask(s)) : "todo";
              return (
                <button
                  type="button"
                  key={tid}
                  class="badge badge-ghost gap-1.5 hover:underline"
                  onClick={() => onOpenTask(tid)}
                >
                  <StatusIcon status={k} class="size-4" />
                  <span class="font-mono">{tid}</span>
                  <span class="max-w-40 truncate">{s?.title ?? ""}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      <DetailsTags t={t} />
    </div>
  );
}

/** The status, owner and dependencies section of the drawer's body. */
function ControlSection({
  t,
  ch,
  now,
  sessions,
  board,
  byId,
  ctl,
  onOpenTask,
  onOpenSession,
}: Omit<TaskBodyProps, "tab" | "onTab">): JSX.Element {
  const gated = (t.gate === "owner" || t.gate === "ask-first") && !FIN.has(t.status ?? "todo");
  return (
    <section class="flex flex-col gap-3" aria-label="Status, owner and dependencies">
      <StatusStrip t={t} now={now} note={ctl.status.note} onNote={ctl.status.write} onSet={ctl.status.set} />
      <MetaGrid
        t={t}
        ch={ch}
        sessions={sessions}
        board={board}
        byId={byId}
        onOwner={ctl.assign.owner}
        onDeps={ctl.assign.deps}
        onOpenSession={onOpenSession}
        onOpenTask={onOpenTask}
      />
      {(t.unmet?.length ?? 0) > 0 && !FIN.has(t.status ?? "todo") ? (
        <UnmetBox unmet={t.unmet ?? []} owner={t.owner} onOpenTask={onOpenTask} />
      ) : null}
      {gated ? (
        <GateBox
          task={t}
          approved={ctl.gate.approved}
          noteOpen={ctl.gate.noteOpen}
          note={ctl.gate.text}
          busy={ctl.gate.busy}
          onNote={ctl.gate.showNote}
          onNoteClose={ctl.gate.hideNote}
          onNoteText={ctl.gate.writeNote}
          onApprove={ctl.gate.approve}
        />
      ) : null}
    </section>
  );
}

/** The drawer's head facts: the status mark, the task id, and the position in the plan. */
function DrawerHead({
  id,
  board,
  state,
}: {
  id: string;
  board: Board | null;
  state: TaskState;
}): JSX.Element {
  const steps = board?.steps ?? [];
  const at = steps.findIndex((x) => x.id === id);
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <StatusIcon status={state} class="size-5" />
        <span class="badge badge-ghost font-mono" id="td-title">
          {id}
        </span>
        <span class="min-w-0 truncate text-sm muted">
          {at >= 0 ? `${at + 1} of ${steps.length} in the plan` : ""}
        </span>
      </div>
    </div>
  );
}

/** The fetch of the task the address names: its result and how far the drawer got. */
function useOpenTask(
  api: Api,
  ch: string | null,
  id: string | null | undefined,
  tick: number,
): { task: TaskDetail | null; phase: Phase; setTask: (t: TaskDetail | null) => void } {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  useEffect(() => {
    if (!id || !ch) return;
    let on = true;
    setPhase("loading");
    api
      .api(api.channelPath(ch, `/task/${encodeURIComponent(id)}`))
      .then((t) => {
        if (!on) return;
        setTask(t as TaskDetail);
        setPhase("ready");
      })
      .catch(() => {
        if (!on) return;
        setTask(null);
        setPhase("missing");
      });
    return () => {
      on = false;
    };
  }, [api, ch, id, tick]);
  return { task, phase, setTask };
}

/** Drops the drawer's per-task state whenever another task opens (work.js openDrawer). */
function useFreshTask(reset: () => void, deps: readonly unknown[]): void {
  useEffect(() => {
    reset();
    // the reset's own triggers are the list: every entry is a primitive or a stable object
  }, deps);
}

/** The board's and the stream's task changes refresh the open task, unless it is being edited. */
function useTaskRefresh(
  live: HuddleStore | undefined,
  id: string | null | undefined,
  bump: () => void,
  editing: () => boolean,
): void {
  // the pending refresh survives the effect's re-arms: the handle lives in a ref, not the closure
  const h = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = (): void => {
    if (h.current !== null) {
      clearTimeout(h.current);
      h.current = null;
    }
  };
  useEffect(() => {
    if (!live || !id) return;
    const un = live.subscribe((what, x) => {
      const relevant = what === "board" || (what === "task" && (x == null || x === id));
      if (!relevant || editing()) return;
      stop();
      h.current = setTimeout(bump, 200);
    });
    return un;
  }, [live, id, bump, editing]);
  // the drawer is gone: nothing pending may fire
  useEffect(() => stop, []);
}

/** The drift table once per drawer, when the channel serves the drift view (work.js openDrawer). */
function useDrift(
  api: Api,
  ch: string | null,
  on: boolean,
  has: boolean,
  set: (m: ReadonlyMap<string, DriftRow>) => void,
): void {
  const tried = useRef(false);
  useEffect(() => {
    if (!ch || !on || has || tried.current) return;
    tried.current = true;
    let live = true;
    api
      .api(api.channelPath(ch, "/repo/drift"))
      .then((r) => {
        if (!live) return;
        const rows = (r as { rows?: DriftRow[] }).rows ?? [];
        set(new Map(rows.filter((x) => x.step).map((x) => [`${x.step}:${x.i}`, x] as const)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, ch, on, has, set]);
}

/** Escape closes the drawer once the key reaches the window: an open edit claims its Escape first
 *  (the editor stops the key from bubbling), and so does any other open dialog (the file excerpt).
 *  The SlideOver's own dialog handles the browser's Escape for the rest. */
function useEscapeClose(id: string | null | undefined, onEscape: () => void): void {
  useEffect(() => {
    if (!id) return;
    const on = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const mine = document.querySelector("dialog[open] [data-slide-over]")?.closest("dialog");
      const others = [...document.querySelectorAll("dialog[open]")].some((d) => d !== mine);
      if (others) return;
      e.preventDefault();
      onEscape();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [id, onEscape]);
}

/** What every action hook reads: the channel's client, the open task and the refills. */
type ActionDeps = {
  /** The task the drawer has open; the per-task state resets whenever it changes. */
  id: string | null | undefined;
  api: Api;
  ch: string;
  toast: ToastFn;
  /** Site storage (localStorage): the note kind and the verify ticks. */
  store: Storage;
  /** The open task, kept current by the drawer. */
  taskRef: RefObject<TaskDetail | null>;
  /** Refetches the open task (work.js refreshTask). */
  refresh: () => void;
  /** Reloads the board after a change (the store's loadBoard). */
  reloadBoard?: (() => unknown) | undefined;
  /** Refills the Inbox after a change (data.js's attChanged). */
  touchAttention?: (() => void) | undefined;
};

/** One owner op with its toast (core.js act): true when it landed, a bad toast when not. */
type ActFn = (
  name: string,
  args: Record<string, unknown>,
  ok: string,
  o?: { undo?: () => void },
) => Promise<boolean>;

/** One task_update with its toast and Undo: the new task, or null when there was no result. */
type UpdateFn = (
  args: Record<string, unknown>,
  msg: string,
  o?: { undo?: () => void },
) => Promise<TaskDetail | null>;

/** A failed op's toast text: the 404 "no operation" becomes an update nudge (core.js act). */
function refusalText(name: string, e: unknown): string {
  const raw = errText(e);
  const status = (e as { status?: number }).status;
  return status === 404 && /no operation/.test(raw)
    ? `This Huddle server does not support “${name}” yet. Update the server.`
    : raw;
}

/** Builds the owner-op runner over one open channel (core.js act). */
function makeAct(api: Api, ch: string, toast: ToastFn): ActFn {
  return async (name, args, ok, o) => {
    try {
      await api.op(ch, name, args);
      if (ok) toast(ok, o);
      return true;
    } catch (e) {
      toast(refusalText(name, e), { bad: true });
      return false;
    }
  };
}

/** The editor: the open field and its error, the save, and the refills after an update. */
function useTaskEdit(deps: ActionDeps & { setTask: (t: TaskDetail | null) => void }): {
  edit: EditCtl;
  update: UpdateFn;
  fail: (e: unknown) => void;
} {
  const { api, ch, toast, taskRef, refresh, reloadBoard, touchAttention, setTask } = deps;
  const [field, setField] = useState<Field | null>(null);
  const [error, setError] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const fieldRef = useRef<Field | null>(null);
  fieldRef.current = field;

  // another task opens with no editor on the page
  useEffect(() => {
    setField(null);
    setError("");
  }, [deps.id]);

  /** Where a failed call's message shows: inside the editor when one is open, else a toast. */
  const fail = (e: unknown): void => {
    const m = errText(e);
    if (fieldRef.current) setError(m);
    else toast(m, { bad: true });
  };

  /** One task_update op: its result, or undefined when the server refused (the message shows). */
  const updateTask = async (
    tid: string,
    args: Record<string, unknown>,
  ): Promise<TaskDetail | null | undefined> => {
    try {
      const r = (await api.op(ch, "task_update", { id: tid, ...args })) as { result?: unknown } | null;
      const res = (r?.result ?? null) as TaskDetail | null;
      return res && typeof res.id === "string" ? res : null;
    } catch (e) {
      fail(e);
      return undefined;
    }
  };

  /** One task_update: the result becomes the drawer's task; board and Inbox refill (work.js). */
  const update = async (
    args: Record<string, unknown>,
    msg: string,
    o: { undo?: () => void } = {},
  ): Promise<TaskDetail | null> => {
    const cur = taskRef.current;
    if (!cur) return null;
    const next = await updateTask(cur.id, args);
    if (next === undefined) return null;
    if (msg) toast(msg, o);
    void Promise.resolve(reloadBoard?.()).catch(() => {});
    touchAttention?.();
    if (next) setTask(next);
    else refresh();
    setField(null);
    setError("");
    return next;
  };

  /** Saves the open editor's text back to the task (work.js saveEdit). */
  const save = async (): Promise<void> => {
    const f = fieldRef.current;
    if (!f || !ta.current) return;
    const parsed = parseEdit(f, ta.current.value);
    if (!parsed.ok) {
      setError(`That is not valid JSON: ${parsed.error}`);
      return;
    }
    setError("");
    await update({ field: f, value: parsed.value }, "Saved");
  };

  return {
    fail,
    update,
    edit: {
      field,
      error,
      open: (f) => {
        setField(f);
        setError("");
      },
      cancel: () => setField(null),
      save: () => void save(),
      clear: () => setError(""),
      revert: (f) => void update({ field: f, value: null }, "Back to the plan's text"),
      ta,
    },
  };
}

/** The status strip's note and its change through Work's setTaskStatus (work.js setStatus). */
function useTaskStatus(
  deps: ActionDeps,
  byId: Map<string, PlanStep>,
): { note: string; write: (v: string) => void; set: (st: TaskStatus) => void } {
  const { api, ch, toast, taskRef, refresh, reloadBoard, touchAttention } = deps;
  const [note, setNote] = useState("");
  // another task opens with an empty evidence line
  useEffect(() => {
    setNote("");
  }, [deps.id]);
  const set = async (st: TaskStatus): Promise<void> => {
    const cur = taskRef.current;
    if (!cur || cur.status === st) return;
    const ok = await setTaskStatus(
      {
        api,
        ch,
        toast,
        byId,
        // only the step's own fields, so the notes' shape stays the detail's
        current: {
          id: cur.id,
          status: cur.status ?? "todo",
          ...(cur.blocked_by ? { blocked_by: cur.blocked_by } : {}),
          comments: null,
        },
        reloadBoard,
        touchAttention,
      },
      cur.id,
      st,
      note.trim(),
    );
    if (ok) {
      setNote("");
      refresh();
    }
  };
  return { note, write: setNote, set: (st) => void set(st) };
}

/** The owner and dependency changes, each with Undo (work.js wireTask). */
function useTaskAssign(
  deps: Pick<ActionDeps, "taskRef" | "refresh">,
  update: UpdateFn,
): { owner: (to: string) => void; deps: (ids: string[]) => void } {
  const { taskRef, refresh } = deps;
  const owner = (to: string): void => {
    const cur = taskRef.current;
    if (!cur) return;
    const was = cur.owner || null;
    const next = to || null;
    if ((was ?? "") === next) return;
    void update(
      { owner: next },
      `${cur.id} now belongs to ${next ? who(next).replace("You", "you") : "nobody"}`,
      {
        undo: () => {
          void update({ owner: was }, `${cur.id} is back with ${was || "nobody"}`);
        },
      },
    );
  };
  const changeDeps = (ids: string[]): void => {
    const cur = taskRef.current;
    if (!cur) return;
    const was = cur.depends ?? [];
    void update(
      { after: ids },
      ids.length > was.length
        ? `${cur.id} now waits on ${ids.filter((x) => !was.includes(x)).join(", ")}`
        : `${cur.id} no longer waits on ${was.filter((x) => !ids.includes(x)).join(", ")}`,
      {
        undo: () => {
          void update({ after: was }, "Dependencies restored");
        },
      },
    ).then((r) => {
      if (!r) refresh();
    });
  };
  return { owner, deps: changeDeps };
}

/** The gate's approval box (work.js wireTask approve). */
function useTaskGate(deps: ActionDeps, act: ActFn, approved: boolean): GateCtl {
  const { taskRef, refresh, touchAttention } = deps;
  const [noteOpen, setNoteOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // another task opens with its approval box closed
  useEffect(() => {
    setNoteOpen(false);
    setText("");
    setBusy(false);
  }, [deps.id]);
  const approve = async (): Promise<void> => {
    const cur = taskRef.current;
    if (!cur) return;
    setBusy(true);
    if (await act("approve", { id: cur.id, msg: text.trim() }, `Approved ${cur.id}`)) {
      setNoteOpen(false);
      setText("");
      refresh();
      touchAttention?.();
    } else {
      setBusy(false);
    }
  };
  return {
    approved,
    noteOpen,
    text,
    busy,
    showNote: () => setNoteOpen(true),
    hideNote: () => setNoteOpen(false),
    writeNote: setText,
    approve: () => void approve(),
  };
}

/** The notes panel's moves: the kind, add, resolve and delete (work.js wireTask). */
function useTaskNotes(deps: ActionDeps, act: ActFn): NotesCtl {
  const { store, taskRef, refresh, reloadBoard, touchAttention } = deps;
  const [kind, setKind] = useState<string>(() => readPref(store, "kind", "change"));
  const ta = useRef<HTMLTextAreaElement>(null);

  /** Adds a note (work.js wireTask add): an empty one puts the caret back. */
  const add = async (): Promise<void> => {
    const cur = taskRef.current;
    const el = ta.current;
    if (!cur || !el) return;
    const body = el.value.trim();
    if (!body) {
      el.focus();
      return;
    }
    if (await act("note", { id: cur.id, kind, body }, "Note added")) {
      el.value = "";
      refresh();
      reloadBoard?.();
      touchAttention?.();
      el.focus();
    }
  };

  /** Resolves or reopens one note (work.js data-res). */
  const resolve = async (noteId: number, resolved: boolean): Promise<void> => {
    if (await act("note_edit", { id: noteId, resolved }, resolved ? "Note resolved" : "Note reopened")) {
      refresh();
      reloadBoard?.();
      touchAttention?.();
    }
  };

  /** Deletes one note (work.js data-del). */
  const remove = async (noteId: number): Promise<void> => {
    if (await act("note_edit", { id: noteId, remove: true }, "Note deleted")) {
      refresh();
      reloadBoard?.();
    }
  };

  return {
    kind,
    pick: (k) => {
      writePref(store, "kind", k);
      setKind(k);
    },
    add: () => void add(),
    resolve: (id, res) => void resolve(id, res),
    remove: (id) => void remove(id),
    ta,
  };
}

/** The drawer's tabs: Overview (status, owner, the plan's body), Code (snippets, files, references)
 *  and Notes (the notes the sessions read), each with its count where one helps. */
export type DrawerTab = "overview" | "code" | "notes";

/** The tabs of one open task: id, word, and a count when the tab has something to count. */
export function drawerTabs(t: TaskDetail | null | undefined): {
  id: DrawerTab;
  label: string;
  count: number | null;
}[] {
  const code = (t?.snippets?.length ?? 0) + (t?.files?.length ?? 0) + (t?.refs?.length ?? 0);
  const openNotes = (t?.comments ?? []).filter((c) => !c.resolved).length;
  return [
    { id: "overview", label: "Overview", count: null },
    { id: "code", label: "Code", count: code || null },
    { id: "notes", label: "Notes", count: openNotes || null },
  ];
}

/** The key a tab walk takes from `at`, wrapping at the ends; NaN for a key the strip ignores. */
const tabKeyTo = (n: number, key: string, at: number): number => {
  if (key === "ArrowRight") return (at + 1 + n) % n;
  if (key === "ArrowLeft") return (at - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return Number.NaN;
};

/** The drawer's tab strip: daisyUI `tabs tabs-box`, the selected tab the only tab stop, the arrows
 *  walk and select. */
function TaskTabs({
  tabs,
  value,
  onPick,
}: {
  tabs: ReturnType<typeof drawerTabs>;
  value: DrawerTab;
  onPick: (t: DrawerTab) => void;
}): JSX.Element {
  const onKey = (id: DrawerTab, key: string): void => {
    const at = tabs.findIndex((x) => x.id === id);
    const to = tabKeyTo(tabs.length, key, at);
    if (Number.isNaN(to)) return;
    onPick(tabs[to]?.id ?? id);
  };
  return (
    <div role="tablist" class="tabs tabs-box" aria-label="Task sections">
      {tabs.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          id={`tt-${x.id}`}
          data-tab={x.id}
          aria-selected={x.id === value}
          aria-controls={`tp-${x.id}`}
          tabIndex={x.id === value ? 0 : -1}
          class={`tab gap-1.5${x.id === value ? " tab-active" : ""}`}
          onClick={() => onPick(x.id)}
          onKeyDown={(e) => onKey(x.id, e.key)}
        >
          {x.label}
          {x.count ? <span class="badge badge-ghost badge-sm tnum">{x.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** The body's slot: the skeleton, the missing card, or the open task's body. */
function BodySlot({
  id,
  t,
  phase,
  of,
}: {
  id: string;
  t: TaskDetail | null;
  phase: Phase;
  /** The open task's body, built once the fetch has answered with it. */
  of: (t: TaskDetail) => ComponentChildren;
}): JSX.Element {
  if (!t) {
    return phase === "missing" ? (
      <div class="flex flex-col items-center gap-1.5 rounded-box border border-dashed border-base-content/20 px-6 py-10 text-center text-sm muted">
        <h2 class="text-base font-medium text-base-content">No task {id}</h2>
        <p>It may have been removed by a plan import.</p>
      </div>
    ) : (
      <Skeleton rows={6} />
    );
  }
  return <>{of(t)}</>;
}

/** The tasks before and after `id` in the plan: the drawer's stepping targets. */
function neighbors(
  steps: readonly PlanStep[],
  id: string,
): { prevId: string | undefined; nextId: string | undefined } {
  const at = steps.findIndex((x) => x.id === id);
  return {
    prevId: at > 0 ? steps[at - 1]?.id : undefined,
    nextId: at >= 0 && at + 1 < steps.length ? steps[at + 1]?.id : undefined,
  };
}

/** The snippet tab this browser kept, clamped to the snippets there are. */
const snipShown = (picked: number | null, stored: number, count: number): number =>
  Math.max(0, Math.min(picked ?? stored, Math.max(0, count - 1)));

/** The body's control bundle, built once per render (work.js wired the same pieces by hand). */
function bodyCtl(
  store: Storage,
  ch: string,
  fallbackId: string,
  taskId: string | null | undefined,
  ticks: ReadonlySet<number>,
  setTicks: (t: ReadonlySet<number>) => void,
  drift: ReadonlyMap<string, DriftRow> | null,
  hasCode: boolean,
  openFile: (p: string) => void,
  copy: (text: string, message?: string) => void,
  snip: number | null,
  setSnip: (n: number) => void,
  snipCount: number,
): DrawerCtl["body"] {
  return {
    ticks,
    tick: (i, on) => {
      writeTick(store, ch, taskId ?? fallbackId, i, on);
      setTicks(readTicks(store, ch, taskId ?? fallbackId));
    },
    drift,
    hasCode,
    openFile,
    copy,
    snipAt: snipShown(snip, readPref(store, `tab:${fallbackId}`, 0), snipCount),
    pickSnippet: (k) => {
      writePref(store, `tab:${taskId ?? fallbackId}`, k);
      setSnip(k);
    },
  };
}

/** The fetch behind a file chip: the excerpt, or how the read failed (work.js openFile). */
function openRepoFile(api: Api, ch: string, p: string, set: (st: FileState) => void): void {
  set({ path: p, phase: "loading" });
  api
    .api(api.channelPath(ch, `/repo/code?path=${encodeURIComponent(p.replace(/:\d.*$/, ""))}`))
    .then((r) => set({ path: p, phase: "ready", data: r as RepoCode }))
    .catch((e) => set({ path: p, phase: "error", error: e instanceof Error ? e.message : String(e) }));
}

/** The drawer's prev/next step buttons, in the slide-over's actions slot. */
function DrawerNav({
  prevId,
  nextId,
  onOpenTask,
}: {
  prevId: string | undefined;
  nextId: string | undefined;
  onOpenTask: (id: string) => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        class="btn btn-ghost btn-square"
        data-nav={prevId ?? ""}
        disabled={!prevId}
        aria-label={prevId ? `Previous task: ${prevId}` : "Previous task"}
        title="Previous task"
        onClick={() => prevId && onOpenTask(prevId)}
      >
        <Icon name="up" class="size-4.5" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-square"
        data-nav={nextId ?? ""}
        disabled={!nextId}
        aria-label={nextId ? `Next task: ${nextId}` : "Next task"}
        title="Next task"
        onClick={() => nextId && onOpenTask(nextId)}
      >
        <Icon name="down" class="size-4.5" />
      </button>
    </>
  );
}

/** The task drawer over ?t=<id>: the shared SlideOver with its Overview/Code/Notes tabs; nothing
 *  without an id or a channel. */
export function TaskDrawer(props: TaskDrawerProps): JSX.Element | null {
  const { id, ch, api, now, board, byId, sessions, views, toast, copy, store } = props;
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<DrawerTab>("overview");
  const [snip, setSnip] = useState<number | null>(null);
  const [ticks, setTicks] = useState<ReadonlySet<number>>(new Set<number>());
  const [drift, setDrift] = useState<ReadonlyMap<string, DriftRow> | null>(null);
  const [file, setFile] = useState<FileState | null>(null);

  const live = props.live;
  const hasDrift = views.includes("drift");

  /** Refetches the open task (work.js refreshTask): the tick also plays "the store moved". */
  const refresh = (): void => setTick((n) => n + 1);
  const { task, phase, setTask } = useOpenTask(api, ch, id, tick);

  // the open task, as long as the fetch still answers the address
  const taskRef = useRef<TaskDetail | null>(null);
  taskRef.current = task?.id === id ? task : null;
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const editRef = useRef<Field | null>(null);

  // a new task starts clean: no ticks, no excerpt dialog, no drift, no editor, on Overview
  useFreshTask(() => {
    setTab("overview");
    setSnip(null);
    setTicks(id && ch ? readTicks(store, ch, id) : new Set<number>());
    setFile(null);
    setDrift(null);
    editRef.current = null;
  }, [id, ch, store]);

  useTaskRefresh(live, id, refresh, () => editRef.current !== null);
  useDrift(api, ch, hasDrift, !!drift, setDrift);

  // the actions live in hooks, so they stay above the "nothing open" return
  const deps: ActionDeps & { setTask: (t: TaskDetail | null) => void } = {
    id,
    api,
    ch: ch ?? "",
    toast,
    store,
    taskRef,
    refresh,
    reloadBoard: props.reloadBoard,
    touchAttention: props.touchAttention,
    setTask,
  };
  const act = makeAct(api, ch ?? "", toast);
  const { edit, update } = useTaskEdit(deps);
  editRef.current = edit.field;
  // the editor cancels its own Escapes; this one catches the ones that reach the window
  useEscapeClose(id, () => {
    if (editRef.current) {
      editRef.current = null;
      edit.cancel();
      return;
    }
    closeRef.current();
  });
  const status = useTaskStatus(deps, byId);
  const assign = useTaskAssign({ taskRef, refresh }, update);
  const gate = useTaskGate(deps, act, !!taskRef.current && isApproved(taskRef.current));
  const notes = useTaskNotes(deps, act);

  if (!id || !ch) return null;

  const t = taskRef.current;
  const ctl: DrawerCtl = {
    edit,
    status,
    assign,
    gate,
    notes,
    body: bodyCtl(
      store,
      ch,
      id,
      t?.id,
      ticks,
      setTicks,
      drift,
      views.includes("code"),
      (p) => openRepoFile(api, ch, p, setFile),
      copy,
      snip,
      setSnip,
      t?.snippets?.length ?? 0,
    ),
  };

  const state: TaskState = t ? taskState(asTask(t)) : "todo";
  const { prevId, nextId } = neighbors(board?.steps ?? [], id);

  return (
    <>
      <SlideOver
        open
        id="tdrawer"
        onClose={props.onClose}
        label={`Task ${id}`}
        header={<DrawerHead id={id} board={board} state={state} />}
        tabs={<TaskTabs tabs={drawerTabs(t)} value={tab} onPick={setTab} />}
        width="w-[min(56rem,94vw)]"
        actions={<DrawerNav prevId={prevId} nextId={nextId} onOpenTask={props.onOpenTask} />}
      >
        <div class="flex min-w-0 flex-col">
          <BodySlot
            id={id}
            t={t}
            phase={phase}
            of={(task) => (
              <TaskBody
                t={task}
                ch={ch}
                now={now}
                board={board}
                byId={byId}
                sessions={sessions}
                ctl={ctl}
                tab={tab}
                onTab={setTab}
                onOpenTask={props.onOpenTask}
                onOpenSession={props.onOpenSession}
              />
            )}
          />
        </div>
      </SlideOver>
      <Dialog open={file !== null} onClose={() => setFile(null)} title={file?.path} class="dlg hr-dialog">
        {file ? <FileBody st={file} /> : null}
      </Dialog>
    </>
  );
}
