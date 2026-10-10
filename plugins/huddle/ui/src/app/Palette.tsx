// Palette.tsx — the command palette (⌘K / Ctrl-K) and the keyboard. The palette jumps to the
// destinations, tasks (the cached plan plus the server's full-text search), sessions, channels
// and knowledge, and runs the owner's actions with the names the owner thinks in: "Pause web",
// "Ask docs", "Approve api-2", "New task". "?" lists every shortcut, and the single keys — the
// g chords, "/" for the filter box, j/k across the visible tasks, 1–5 for an open task's status —
// work anywhere but inside a text field. Port of cmd.js.

import { Dialog } from "@muhmdraouf/ui/dialog.tsx";
import { fuzzy } from "@muhmdraouf/ui/fuzzy.ts";
import type { ToastFn } from "@muhmdraouf/ui/toast.tsx";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import type { ComposeOptions } from "../compose/drafts.ts";
import { Icon, type IconName } from "../icons.tsx";
import { StatusIcon } from "../kit.tsx";
import { STAT, STATM, type TaskState, type TaskStatus } from "../status.ts";
import { readPref, type Storage } from "../storage.ts";
import type { Attention, Board, ChannelSummary, HuddleStore, PlanStep, SessionList } from "../store.ts";
import { type Filters, readFilters, scope, sessHref, stepState, visible } from "../work/model.ts";
import { setTaskStatus } from "../work/Work.tsx";
import { errText, useHuddle } from "./context.tsx";
import { DESTS, parseHash, type Route } from "./router.ts";
import { setTheme, type ThemePref } from "./theme.ts";

// ── the items ────────────────────────────────────────────────────────────────

/** One palette entry: its group, what it shows, and what running it does. */
export type CmdItem = {
  /** The group heading the item sits under. */
  g: string;
  /** The item's title. */
  t: string;
  /** The muted subline. */
  s?: string | undefined;
  /** The icon before the title; a task item draws its status instead. */
  i?: IconName | undefined;
  /** The shortcut the result prints, one key per kbd. */
  kb?: string | undefined;
  /** A task item's id; it draws the task's status icon instead of a nav icon. */
  id?: string | undefined;
  /** The task's derived state, for the icon. */
  st?: TaskState | undefined;
  run: () => void;
};

/** One owner op with its success toast and an optional Undo; false when the server refused. */
export type ActFn = (
  name: string,
  args: Record<string, unknown>,
  ok: string,
  o?: { undo?: () => void },
) => Promise<boolean>;

/** What the item builders read: the channel's data plus every way out the shell owns. */
export type PaletteDeps = {
  ch: string | null;
  api: Api;
  board: Board | null;
  byId: Map<string, PlanStep>;
  attention: Attention | null;
  sessions: SessionList | null;
  channels: ChannelSummary[] | null;
  /** The task whose drawer is open, when one is. */
  taskId: string | null;
  go(href: string): void;
  act: ActFn;
  compose(prefill?: ComposeOptions): void;
  toast: ToastFn;
  notifyOn(): boolean;
  toggleNotify(): void;
  openHelp(): void;
  setTheme(p: ThemePref): void;
  exportPlan(): void;
  /** Refills the Inbox (data.js's attChanged). */
  touchAttention(): void;
  /** Refills the roster (data.js's sessChanged). */
  touchSessions(): void;
  /** One status change on an open task, with Undo (work.js setTaskStatus). */
  setTaskStatus(id: string, st: TaskStatus): void;
};

/** The work views the palette offers (cmd.js WORKV). */
const WORKV: readonly (readonly [string, string])[] = [
  ["list", "List"],
  ["board", "Board"],
  ["graph", "Graph"],
  ["map", "Map"],
];

/** Go to: the destinations with their g chords, Today, and the work views. */
function goItems(d: PaletteDeps, ch: string): CmdItem[] {
  const out: CmdItem[] = DESTS.map(([k, l, ic, key]) => ({
    g: "Go to",
    t: l,
    i: ic,
    kb: `g ${key}`,
    run: () => d.go(`#/c/${ch}/${k}`),
  }));
  out.push({
    g: "Go to",
    t: "Today",
    s: "what got done, per session",
    i: "clock",
    run: () => d.go(`#/c/${ch}/today`),
  });
  for (const [k, l] of WORKV)
    out.push({ g: "Go to", t: `Work: ${l}`, i: "list", run: () => d.go(`#/c/${ch}/work/${k}`) });
  return out;
}

/** Needs you: the asks to answer and the gates to approve. */
function needsItems(d: PaletteDeps, ch: string): CmdItem[] {
  const asks: CmdItem[] = (d.attention?.asks ?? []).map((a) => ({
    g: "Needs you",
    t: `Answer ${a.from}`,
    s: (a.msg ?? "").slice(0, 80),
    i: "ask",
    run: () => d.go(`#/c/${ch}/inbox`),
  }));
  const gates: CmdItem[] = (d.attention?.gates ?? []).map((g) => ({
    g: "Needs you",
    t: `Approve ${g.id}`,
    s: g.title,
    i: "key",
    run: () => {
      void d.act("approve", { id: g.id }, `Approved ${g.id}`).then((ok) => {
        if (ok) d.touchAttention();
      });
    },
  }));
  return [...asks, ...gates];
}

/** Sessions: pause or resume, message, ask, give a task, hand the turn, open. */
function sessionItems(d: PaletteDeps, ch: string): CmdItem[] {
  const out: CmdItem[] = [];
  for (const s of (d.sessions?.sessions ?? []).filter((x) => x.state !== "left")) {
    out.push(
      s.control === "pause"
        ? {
            g: "Sessions",
            t: `Resume ${s.name}`,
            i: "play",
            run: () => {
              void d.act("resume", { target: s.name }, `${s.name} resumed`).then((ok) => {
                if (ok) d.touchSessions();
              });
            },
          }
        : {
            g: "Sessions",
            t: `Pause ${s.name}`,
            s: "it stops at its next check",
            i: "pause",
            run: () => {
              void d
                .act("pause", { target: s.name }, `${s.name} paused`, {
                  undo: () => {
                    void d
                      .act("resume", { target: s.name }, `${s.name} resumed`)
                      .then(() => d.touchSessions());
                  },
                })
                .then((ok) => {
                  if (ok) d.touchSessions();
                });
            },
          },
    );
    out.push({
      g: "Sessions",
      t: `Message ${s.name}`,
      i: "msg",
      run: () => d.compose({ to: s.name, mode: "msg" }),
    });
    out.push({
      g: "Sessions",
      t: `Ask ${s.name}`,
      s: "a question it must answer",
      i: "ask",
      run: () => d.compose({ to: s.name, mode: "ask" }),
    });
    out.push({
      g: "Sessions",
      t: `Give ${s.name} a task`,
      i: "plus",
      run: () => d.compose({ to: s.name, mode: "task" }),
    });
    if (!s.holds_turn && !s.parent)
      out.push({
        g: "Sessions",
        t: `Hand the turn to ${s.name}`,
        i: "turn",
        run: () => {
          void d.act("pass", { to: s.name }, `${s.name} holds the turn now`).then((ok) => {
            if (ok) d.touchSessions();
          });
        },
      });
    out.push({
      g: "Sessions",
      t: `Open ${s.name}`,
      s: "its task, activity and actions",
      i: "users",
      run: () => d.go(sessHref(d.api, ch, s.name)),
    });
  }
  return out;
}

/** Actions: the composer, a new task, knowledge, the paused sweep, the plan's export. */
function actionItems(d: PaletteDeps, ch: string): CmdItem[] {
  const out: CmdItem[] = [
    { g: "Actions", t: "Send a message", i: "send", kb: "c", run: () => d.compose({ mode: "msg" }) },
    { g: "Actions", t: "New task", i: "plus", run: () => d.compose({ mode: "task", to: "" }) },
    { g: "Actions", t: "Remember something", i: "brain", run: () => d.go(`#/c/${ch}/knowledge`) },
  ];
  const paused = d.attention?.paused ?? [];
  if (paused.length > 1)
    out.push({
      g: "Actions",
      t: "Resume every paused session",
      i: "play",
      run: () => {
        for (const p of paused) void d.act("resume", { target: p.name }, "");
        d.toast(`Resumed ${paused.length} sessions`);
        d.touchSessions();
        d.touchAttention();
      },
    });
  out.push({ g: "Actions", t: "Download the plan (export.md)", i: "download", run: d.exportPlan });
  return out;
}

/** This task: the statuses the open task can move to. */
function taskItems(d: PaletteDeps): CmdItem[] {
  const cur = d.taskId ? d.byId.get(d.taskId) : undefined;
  if (!cur) return [];
  return STAT.filter((st) => st !== cur.status).map((st) => ({
    g: "This task",
    t: `Mark ${cur.id} ${STATM[st].l.toLowerCase()}`,
    i: STATM[st].i,
    run: () => d.setTaskStatus(cur.id, st),
  }));
}

/** Channels: every other channel, then all of them. */
function channelItems(d: PaletteDeps, ch: string | null): CmdItem[] {
  const out: CmdItem[] = (d.channels ?? [])
    .filter((c) => c.name !== ch)
    .map((c) => ({
      g: "Channels",
      t: c.title || c.name,
      s: c.name,
      i: "hash",
      run: () => d.go(`#/c/${c.name}`),
    }));
  out.push({ g: "Channels", t: "All channels", i: "layers", run: () => d.go("#/") });
  return out;
}

/** Settings: the themes, the notifications, the shortcuts. */
function settingItems(d: PaletteDeps): CmdItem[] {
  return [
    { g: "Settings", t: "Theme: follow the system", i: "monitor", run: () => d.setTheme("system") },
    { g: "Settings", t: "Theme: Latte (light)", i: "sun", run: () => d.setTheme("latte") },
    { g: "Settings", t: "Theme: Mocha (dark)", i: "moon", run: () => d.setTheme("mocha") },
    {
      g: "Settings",
      t: d.notifyOn() ? "Stop notifying me of questions" : "Notify me of questions",
      i: "bell",
      run: d.toggleNotify,
    },
    { g: "Settings", t: "Keyboard shortcuts", i: "keyboard", kb: "?", run: d.openHelp },
  ];
}

/** Every palette item there is right now (cmd.js base). */
export function buildItems(d: PaletteDeps): CmdItem[] {
  const ch = d.ch;
  return [
    ...(ch ? goItems(d, ch) : []),
    ...(ch ? needsItems(d, ch) : []),
    ...(ch ? sessionItems(d, ch) : []),
    ...(ch ? actionItems(d, ch) : []),
    ...(ch ? taskItems(d) : []),
    ...channelItems(d, ch),
    ...settingItems(d),
  ];
}

// ── the ranking ──────────────────────────────────────────────────────────────

/** One hit of the server's full-text search (GET /search). */
export type SearchHit = { id: string; title?: string; hit?: string };

/** The group order an empty query shows (cmd.js compute). */
const GROUP_ORDER = ["Needs you", "Go to", "Actions", "This task", "Sessions", "Channels", "Settings"];

/** The plan's tasks the query matches, best first, twelve at most. */
function taskMatches(a: { steps: readonly PlanStep[]; q: string; onTask: (id: string) => void }): CmdItem[] {
  return a.steps
    .map((s) => ({ s, sc: fuzzy(a.q, `${s.id} ${s.title ?? ""} ${s.owner ?? ""}`) }))
    .filter((x) => x.sc >= 0)
    .sort((m, n) => n.sc - m.sc)
    .slice(0, 12)
    .map(({ s }) => ({
      g: "Tasks",
      t: s.title || s.id,
      id: s.id,
      st: stepState(s),
      s: s.owner || "",
      run: () => a.onTask(s.id),
    }));
}

/** The server's text hits the task list does not already show, eight at most. */
function textMatches(
  a: { hits: readonly SearchHit[] | null; byId: Map<string, PlanStep>; onTask: (id: string) => void },
  seen: ReadonlySet<string>,
): CmdItem[] {
  return (a.hits ?? [])
    .filter((r) => !seen.has(r.id))
    .slice(0, 8)
    .map((r) => ({
      g: "Found in the task text",
      t: r.title || r.id,
      id: r.id,
      st: stepState(a.byId.get(r.id)),
      s: (r.hit || "").replace(/[«»]/g, ""),
      run: () => a.onTask(r.id),
    }));
}

/** The palette's results for a query: the ranked items, with the matching tasks — and the
 *  server's text hits — folded in around the best match (cmd.js compute). */
export function paletteResults(a: {
  items: readonly CmdItem[];
  steps: readonly PlanStep[];
  byId: Map<string, PlanStep>;
  hits: readonly SearchHit[] | null;
  q: string;
  onTask: (id: string) => void;
}): CmdItem[] {
  const q = a.q.trim();
  if (!q)
    return [...a.items].sort((x, y) => GROUP_ORDER.indexOf(x.g) - GROUP_ORDER.indexOf(y.g)).slice(0, 60);
  const ranked = a.items
    .map((x) => ({ x, sc: fuzzy(q, `${x.t} ${x.s ?? ""} ${x.g}`) }))
    .filter((x) => x.sc >= 0)
    .sort((m, n) => n.sc - m.sc)
    .map((x) => x.x);
  const tasks = taskMatches({ steps: a.steps, q, onTask: a.onTask });
  const seen = new Set<string>();
  for (const t of tasks) if (t.id) seen.add(t.id);
  const text = textMatches({ hits: a.hits, byId: a.byId, onTask: a.onTask }, seen);
  const top = ranked.slice(0, 1);
  const rest = ranked.slice(1, 14);
  const first = top[0];
  const head = tasks[0];
  const tasksFirst =
    tasks.length > 0 && (!first || fuzzy(q, first.t) < fuzzy(q, `${head?.id ?? ""} ${head?.t ?? ""}`));
  return tasksFirst ? [...tasks, ...top, ...rest, ...text] : [...top, ...tasks, ...rest, ...text];
}

// ── the dialog ───────────────────────────────────────────────────────────────

/** The toast text of a failed op: the 404 "no operation" becomes an update nudge (core.js act). */
function refusal(e: unknown, name: string): string {
  const raw = errText(e);
  return (e as { status?: number }).status === 404 && /no operation/.test(raw)
    ? `This Huddle server does not support “${name}” yet. Update the server.`
    : raw;
}

/** What the palette needs from the shell besides the context. */
export type PaletteProps = {
  open: boolean;
  onClose(): void;
  /** Opens the composer, the way the actions do. */
  onCompose(prefill?: ComposeOptions): void;
  /** Opens the shortcuts dialog. */
  onHelp(): void;
  /** The notification toggle the shell owns (live.ts). */
  notify: { on(): boolean; toggle(): void };
  /** The store, for the reloads an action asks for. */
  store?: HuddleStore | undefined;
  /** Site storage for the theme pick; tests pass a fake. */
  prefs?: Storage | undefined;
};

/** The command palette over the open channel (cmd.js openPalette/paintList/run). */
export function CmdPalette(props: PaletteProps): JSX.Element {
  const { state, api, go, toast } = useHuddle();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const prefs = props.prefs ?? localStorage;
  const ch = state.ch;
  const route = parseHash(location.hash, (k, fb) => readPref(prefs, k, fb));

  /** core.js act: one owner op, its toast; the refusal comes back as a bad toast. */
  const act: ActFn = async (name, args, ok, o) => {
    try {
      await api.op(ch ?? "", name, args);
      if (ok) toast(ok, o?.undo ? { undo: o.undo } : {});
      return true;
    } catch (e) {
      toast(refusal(e, name), { bad: true });
      return false;
    }
  };

  const store = props.store;
  const deps: PaletteDeps = {
    ch,
    api,
    board: state.board,
    byId: state.byId,
    attention: state.attention,
    sessions: state.sessions,
    channels: state.channels,
    taskId: route.task,
    go,
    act,
    compose: props.onCompose,
    toast,
    notifyOn: () => props.notify.on(),
    toggleNotify: () => props.notify.toggle(),
    openHelp: props.onHelp,
    setTheme: (p) => setTheme(prefs, p, window.matchMedia("(prefers-color-scheme: dark)").matches),
    exportPlan: () => {
      if (ch) window.open(api.channelPath(ch, "/export.md"), "_blank");
    },
    touchAttention: () => store?.attChanged(),
    touchSessions: () => store?.sessChanged(),
    setTaskStatus: (id, st) => {
      void setTaskStatus(
        {
          api,
          ch: ch ?? "",
          toast,
          byId: state.byId,
          current: state.byId.get(id),
          reloadBoard: store ? () => store.loadBoard() : undefined,
          touchAttention: () => store?.attChanged(),
        },
        id,
        st,
      );
    },
  };
  const results = paletteResults({
    items: buildItems(deps),
    steps: state.board?.steps ?? [],
    byId: state.byId,
    hits,
    q,
    onTask: (id) =>
      go(`${location.hash.split("?")[0] || `#/c/${ch ?? ""}/work`}?t=${encodeURIComponent(id)}`),
  });
  const at = Math.min(sel, Math.max(0, results.length - 1));

  // from three characters the server also searches the task text
  useEffect(() => {
    const needle = q.trim();
    if (!props.open || !ch || needle.length < 3) {
      setHits(null);
      return undefined;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .api(api.channelPath(ch, `/search?q=${encodeURIComponent(needle)}`))
        .then((r) => {
          if (alive) setHits(Array.isArray(r) ? (r as SearchHit[]) : []);
        })
        .catch(() => {});
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [props.open, ch, q, api]);

  // a fresh open starts from an empty query, on the input
  useEffect(() => {
    if (!props.open) return;
    setQ("");
    setSel(0);
    setHits(null);
    input.current?.focus();
  }, [props.open]);

  // the selection stays in view while the arrows walk
  useEffect(() => {
    document.getElementById(`po-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const run = (i: number): void => {
    const x = results[i];
    if (!x) return;
    props.onClose();
    setTimeout(() => x.run(), 0);
  };

  // the groups, in list order; each with its heading and its options
  const groups: { label: string; rows: { x: CmdItem; i: number }[] }[] = [];
  results.forEach((x, i) => {
    const last = groups[groups.length - 1];
    if (last && last.label === x.g) last.rows.push({ x, i });
    else groups.push({ label: x.g, rows: [{ x, i }] });
  });

  return (
    <Dialog open={props.open} onClose={props.onClose} class="dlg">
      <div class="flex h-12 shrink-0 items-center gap-2.5 border-b hairline px-4">
        <span class="muted">
          <Icon name="search" />
        </span>
        <input
          ref={input}
          id="palq"
          class="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-base-content/50"
          placeholder={ch ? "Jump to a task, session or place, or run an action" : "Jump to a channel"}
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="palres"
          aria-autocomplete="list"
          aria-label="Search or run a command"
          aria-activedescendant={results.length ? `po-${at}` : undefined}
          value={q}
          onInput={(e) => {
            setQ(e.currentTarget.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel(Math.min(at + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel(Math.max(at - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(at);
            }
          }}
        />
        <kbd class="kbd kbd-sm">esc</kbd>
      </div>
      <div
        id="palres"
        class="max-h-[min(48dvh,26rem)] min-h-0 overflow-y-auto pb-1.5"
        role="listbox"
        aria-label="Results"
      >
        {results.length ? (
          groups.map((gr, gi) => (
            // biome-ignore lint/a11y/useSemanticElements: the legacy palette's group headings
            <div key={`${gr.label}/${gi}`} role="group" aria-labelledby={`pg-${gi}`}>
              <div class="px-3 pt-3 pb-1 text-xs font-medium text-base-content/50" id={`pg-${gi}`}>
                {gr.label}
              </div>
              {gr.rows.map(({ x, i }) => (
                // biome-ignore lint/a11y/useFocusableInteractive: the combobox pattern keeps the input the one tab stop
                // biome-ignore lint/a11y/useKeyWithClickEvents: the arrows and Enter run the selection
                <div
                  key={i}
                  role="option"
                  id={`po-${i}`}
                  aria-selected={i === at}
                  class="mx-1.5 flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors aria-selected:bg-base-content/10"
                  onClick={() => run(i)}
                  onMouseMove={() => {
                    if (at !== i) setSel(i);
                  }}
                >
                  {x.id ? (
                    <>
                      <StatusIcon status={x.st ?? "todo"} class="size-3.5" />
                      <span class="font-mono text-xs">{x.id}</span>
                    </>
                  ) : (
                    <span class="muted">
                      <Icon name={x.i ?? "arrow"} />
                    </span>
                  )}
                  <span class="truncate">{x.t}</span>
                  <span class="min-w-0 flex-1 truncate text-xs text-base-content/50">{x.s ?? ""}</span>
                  {x.kb ? (
                    <span class="flex gap-0.5">
                      {x.kb.split(" ").map((k) => (
                        <kbd key={k} class="kbd kbd-sm">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ))
        ) : (
          <Empty text={`Nothing matches “${q}”.`} hint="esc to close" />
        )}
      </div>
      <div class="hidden shrink-0 items-center gap-3 border-t hairline px-4 py-2 text-xs text-base-content/50 sm:flex">
        <span class="flex items-center gap-1">
          <kbd class="kbd kbd-xs">↑</kbd>
          <kbd class="kbd kbd-xs">↓</kbd> move
        </span>
        <span class="flex items-center gap-1">
          <kbd class="kbd kbd-xs">↵</kbd> run
        </span>
        <span class="flex-1" />
        <span>Three letters or more also search the task text.</span>
      </div>
    </Dialog>
  );
}

/** The palette's empty state, over the shared empty block. */
function Empty({ text, hint }: { text: string; hint: string }): JSX.Element {
  return (
    <div class="flex flex-col items-center gap-1 px-6 py-10 text-center text-sm muted">
      <p class="text-sm font-medium text-base-content">{text}</p>
      <span class="text-xs text-base-content/50">{hint}</span>
    </div>
  );
}

// ── the keyboard ─────────────────────────────────────────────────────────────

/** True when the keystroke was typing into a field. */
export function isTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable]");
}

/** True when a modifier or the focus's field swallows a single key. */
export function swallowedKey(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target);
}

/** What the open dialogs do to the single keys: they keep them, unless the one open dialog is
 *  the task drawer, whose keys these are (cmd.js init's inTask). */
export function dialogGuard(): "swallow" | "task" | "none" {
  const dlgs = document.querySelectorAll("dialog[open]");
  if (dlgs.length === 0) return "none";
  return dlgs.length === 1 && dlgs[0]?.id === "tdrawer" ? "task" : "swallow";
}

/** The status change the work keys run: the op, the toast with Undo, the board refilled and
 *  the Inbox touched (work.js setTaskStatus through the shell's store). */
export function keySetStatus(
  d: {
    api: Api;
    ch: string;
    toast: ToastFn;
    byId: Map<string, PlanStep>;
    current: PlanStep | undefined;
    store: HuddleStore | undefined;
  },
  id: string,
  st: TaskStatus,
): void {
  const store = d.store;
  void setTaskStatus(
    {
      api: d.api,
      ch: d.ch,
      toast: d.toast,
      byId: d.byId,
      current: d.current,
      reloadBoard: store ? () => store.loadBoard() : undefined,
      touchAttention: () => store?.attChanged(),
    },
    id,
    st,
  );
}

/** The single keys' dependencies, built fresh for the keystroke: the address's path, the
 *  channel's board and kept filters, and the ways out. */
export function keyDeps(d: {
  ch: string | null;
  hash: string;
  board: Board | null;
  prefs: Storage;
  openPalette(): void;
  openHelp(): void;
  go(href: string): void;
  setStatus(id: string, st: TaskStatus): void;
}): KeyDeps {
  return {
    ch: d.ch,
    base: d.hash.split("?")[0] || `#/c/${d.ch ?? ""}/work`,
    board: d.board,
    filters: readFilters(d.prefs, d.ch ?? ""),
    openPalette: d.openPalette,
    openHelp: d.openHelp,
    go: d.go,
    setStatus: d.setStatus,
  };
}

/** ⌘K / Ctrl-K toggles the palette, over everything else. True when it took the key. */
function togglePaletteKey(
  e: KeyboardEvent,
  open: boolean,
  openPalette: () => void,
  closePalette: () => void,
): boolean {
  if (!((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k")) return false;
  e.preventDefault();
  if (open) closePalette();
  else openPalette();
  return true;
}

/** The g chord's destinations (cmd.js init's map). */
const CHORDS: Readonly<Record<string, string>> = {
  i: "inbox",
  t: "team",
  w: "work",
  k: "knowledge",
  s: "settings",
};

/** One chord step: g to a destination's key, g h for all channels. True when it navigated. */
export function goChord(key: string, ch: string | null, go: (h: string) => void): boolean {
  if (key === "h") {
    go("#/");
    return true;
  }
  const v = CHORDS[key];
  if (v && ch) {
    go(`#/c/${ch}/${v}`);
    return true;
  }
  return false;
}

/** Records g and resolves the chord on the key that follows, within 1.2 s. True when it took
 *  the key either way (cmd.js init's gKey). */
export function chordKey(
  e: KeyboardEvent,
  gAt: { current: number },
  ch: string | null,
  go: (h: string) => void,
): boolean {
  if (gAt.current > 0 && Date.now() - gAt.current < 1200) {
    gAt.current = 0;
    if (goChord(e.key, ch, go)) e.preventDefault();
    return true;
  }
  if (e.key === "g") {
    gAt.current = Date.now();
    return true;
  }
  return false;
}

/** j/k walks the visible task list, opening each task's drawer in turn (cmd.js init). */
export function stepTask(
  dir: 1 | -1,
  taskId: string | null,
  board: Board,
  filters: Filters,
  base: string,
  go: (h: string) => void,
): void {
  const list = visible(board.steps, filters.f, scope(filters, board));
  if (!list.length) return;
  const i = list.findIndex((s) => s.id === taskId);
  const n = dir === 1 ? (i < 0 ? 0 : Math.min(i + 1, list.length - 1)) : Math.max(i - 1, 0);
  const next = list[n];
  if (!next) return;
  go(`${base}?t=${encodeURIComponent(next.id)}`);
}

/** What the single keys need besides the route. */
export type KeyDeps = {
  ch: string | null;
  /** The address's path without a drawer, for the task links to ride on. */
  base: string;
  board: Board | null;
  filters: Filters;
  openPalette(): void;
  openHelp(): void;
  go(href: string): void;
  setStatus(id: string, st: TaskStatus): void;
};

/** j/k and 1–5 (cmd.js init's tail). True when it took the key. */
function taskKeys(e: KeyboardEvent, inTask: boolean, route: Route, d: KeyDeps): boolean {
  if ((e.key === "j" || e.key === "k") && (route.dest === "work" || inTask) && d.board) {
    e.preventDefault();
    stepTask(e.key === "j" ? 1 : -1, route.task, d.board, d.filters, d.base, d.go);
    return true;
  }
  const st = /^[1-5]$/.test(e.key) ? STAT[Number(e.key) - 1] : undefined;
  if (inTask && route.task && st) {
    e.preventDefault();
    d.setStatus(route.task, st);
    return true;
  }
  return false;
}

/** ?, / and the task keys. True when it took the key (cmd.js init's tail). */
export function singleKey(e: KeyboardEvent, inTask: boolean, route: Route, d: KeyDeps): boolean {
  if (e.key === "?") {
    e.preventDefault();
    d.openHelp();
    return true;
  }
  if (e.key === "/") {
    e.preventDefault();
    const el = document.getElementById("wq") ?? document.getElementById("kbq");
    if (el instanceof HTMLElement) el.focus();
    else d.openPalette();
    return true;
  }
  if (!d.ch) return false;
  return taskKeys(e, inTask, route, d);
}

/** The keyboard layer's props. */
export type CmdKeysProps = {
  /** Whether the palette is open right now (⌘K toggles it). */
  paletteOpen: boolean;
  openPalette(): void;
  closePalette(): void;
  openHelp(): void;
  /** Site storage for the kept work filters; tests pass a fake. */
  prefs?: Storage | undefined;
  /** The store, for the reloads a status change asks for. */
  store?: HuddleStore | undefined;
};

/** The single-key layer, over every page: ⌘K, the g chords, ?, /, j/k and 1–5, anywhere but a
 *  text field and anywhere but a dialog — except the task drawer, whose keys these are
 *  (cmd.js init). Renders nothing. */
export function CmdKeys(props: CmdKeysProps): JSX.Element | null {
  const { state, api, go, toast } = useHuddle();
  const gAt = useRef(0);
  const setStatus = (id: string, st: TaskStatus): void =>
    keySetStatus(
      { api, ch: state.ch ?? "", toast, byId: state.byId, current: state.byId.get(id), store: props.store },
      id,
      st,
    );

  // no dependency list: the shell repaints on every change, and the handler reads it fresh
  useEffect(() => {
    const prefs = props.prefs ?? localStorage;
    const on = (e: KeyboardEvent): void => {
      if (togglePaletteKey(e, props.paletteOpen, props.openPalette, props.closePalette)) return;
      if (swallowedKey(e)) return;
      const guard = dialogGuard();
      if (guard === "swallow") return;
      const route = parseHash(location.hash, (k, fb) => readPref(prefs, k, fb));
      if (chordKey(e, gAt, state.ch, go)) return;
      singleKey(
        e,
        guard === "task",
        route,
        keyDeps({
          ch: state.ch,
          hash: location.hash,
          board: state.board,
          prefs,
          openPalette: props.openPalette,
          openHelp: props.openHelp,
          go,
          setStatus,
        }),
      );
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
  return null;
}

// ── the shortcuts dialog ─────────────────────────────────────────────────────

/** Is this browser a Mac (⌘) or not (Ctrl)? */
export const isMac = (ua: string): boolean => /Mac|iPhone|iPad/.test(ua);

/** One section of the shortcuts dialog. */
export type HelpSection = { head: string; rows: readonly (readonly [string, string])[] };

/** The shortcuts, per section (cmd.js help). */
export function helpSections(mac: boolean): readonly HelpSection[] {
  return [
    {
      head: "Anywhere",
      rows: [
        [mac ? "⌘ K" : "Ctrl K", "Search or run a command"],
        ["/", "Filter this view"],
        ["c", "Send a message"],
        ["?", "These shortcuts"],
        ["esc", "Close a drawer or dialog"],
      ],
    },
    {
      head: "Go to",
      rows: [
        ["g i", "Inbox"],
        ["g t", "Team"],
        ["g w", "Work"],
        ["g k", "Knowledge"],
        ["g s", "Settings"],
        ["g h", "All channels"],
      ],
    },
    {
      head: "Tasks",
      rows: [
        ["j", "Next task"],
        ["k", "Previous task"],
        ["1", "To do"],
        ["2", "Doing"],
        ["3", "Done"],
        ["4", "Blocked"],
        ["5", "Skipped"],
      ],
    },
  ];
}

/** The keyboard shortcuts dialog (cmd.js help). */
export function HelpDialog({ open, onClose }: { open: boolean; onClose(): void }): JSX.Element {
  const mac = isMac(navigator.platform || navigator.userAgent);
  const sections = helpSections(mac);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" class="dlg">
      <div class="grid gap-x-10 gap-y-6 p-5 sm:grid-cols-2">
        {sections.map((s) => (
          <section key={s.head}>
            <h3 class="mb-2 text-xs font-medium text-base-content/50">{s.head}</h3>
            <dl class="flex flex-col gap-1.5 text-sm">
              {s.rows.map(([k, d]) => (
                <div key={`${k}/${d}`} class="flex items-baseline gap-3">
                  <dt class="flex shrink-0 gap-1">
                    {k.split(" ").map((x) => (
                      <kbd key={x} class="kbd kbd-sm">
                        {x}
                      </kbd>
                    ))}
                  </dt>
                  <dd class="min-w-0">{d}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
