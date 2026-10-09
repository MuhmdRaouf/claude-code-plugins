// Composer.tsx — the owner's composer: to (everyone or one session) × kind (message, question that
// needs a reply, task for them). Task mode creates a task owned by the chosen session that waits on
// the picked tasks: how the owner asks one session to finish something before another starts.
// It lives in the session drawer (to that session) and in a dialog (c, ⌘K, New task, Message
// buttons). Never below the fold. Drafts survive re-renders and reloads, per channel and place.
// Port of compose.js mount/send/effect; the state lives in the draft (drafts.ts), the op call and
// the toasts go through the injected api and toast, and Preact keeps the nodes a repaint used to lose.

import { Inline } from "@muhmdraouf/ui/markdown.tsx";
import type { ToastFn } from "@muhmdraouf/ui/toast.tsx";
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Api } from "../api.ts";
import { Icon, type IconName } from "../icons.tsx";
import { Time } from "../kit.tsx";
import { Picker, type PickerTask } from "../picker.tsx";
import { who } from "../status.ts";
import type { Storage } from "../storage.ts";
import type { Board, FeedEvent, PlanStep, RosterSession, Timers } from "../store.ts";
import {
  applyInitial,
  browserTimers,
  type ComposeMode,
  type ComposeOptions,
  createDrafts,
  type Draft,
  type Drafts,
  localDraftStorage,
} from "./drafts.ts";

/** The ops a composer sends (compose.js send). */
export type ComposeOp = "reply" | "task_create" | "send";

/** What a send does once it succeeded: the app refills what shows it (data.js's attChanged, and
 *  boardChanged for a task — the caller switches on the op name). */
export type ComposeSent = (op: ComposeOp) => void;

/** The composer's kinds with their button word and icon (compose.js MODES). */
const MODES: readonly (readonly [ComposeMode, string, IconName])[] = [
  ["msg", "Message", "msg"],
  ["ask", "Question", "ask"],
  ["task", "Task", "plus"],
];

/** The sessions the To menu offers: the roster minus who left, plus a recipient the roster does not
 *  know (a session that went away while the draft named it). Port of compose.js mount's names. */
export function recipientNames(sessions: readonly RosterSession[], to: string): string[] {
  const names = sessions.filter((s) => s.state !== "left").map((s) => s.name);
  if (to && !names.includes(to)) names.push(to);
  return names;
}

/** The recipient as a sentence names it: "You" for the owner, the name, or "everyone". */
export const toLabelOf = (d: Draft): string => (d.to ? who(d.to) : "everyone");

/** The timeline event a reply answers, or null when there is no reply or the seq is gone. */
export const findReply = (
  timeline: readonly FeedEvent[] | null | undefined,
  reply: number | null,
): FeedEvent | null => (reply == null || !timeline ? null : (timeline.find((x) => x.seq === reply) ?? null));

/** The task mode's line: who owns it, what it waits on, who is woken. */
function taskEffect(d: Draft, t: ComponentChildren): ComponentChildren {
  return (
    <>
      Creates a task {d.to ? ["for ", t] : "that nobody owns yet"}
      {d.after.length > 0
        ? [
            ". It waits on ",
            <b>{d.after.join(", ")}</b>,
            ", and ",
            d.to ? t : "its owner",
            " is woken when they are done",
          ]
        : ""}
      .
    </>
  );
}

/** The "what this will do" line under the message box: who reads it, what a task waits on. */
export function effect(d: Draft): ComponentChildren {
  const t = d.to ? <b>{who(d.to)}</b> : "every session";
  if (d.mode === "ask")
    return (
      <>{d.to ? t : "Every session"} must answer: it waits in their inbox and wakes them until they reply.</>
    );
  if (d.mode === "task") return taskEffect(d, t);
  return <>{d.to ? t : "Every session"} reads it at the next check of the inbox.</>;
}

/** The dialog's title: the reply's author, or what this kind of compose is called. */
export function composeTitle(mode: ComposeMode, rep: FeedEvent | null): string {
  return rep
    ? `Reply to ${rep.from}`
    : mode === "task"
      ? "New task"
      : mode === "ask"
        ? "Ask a question"
        : "Send a message";
}

/** The message box's placeholder: what a reply, a task's details, a question or a message is for. */
export function msgPlaceholder(d: Draft, rep: FeedEvent | null): string {
  if (rep) return `Answer ${rep.from}`;
  if (d.mode === "task") return "What done means, where to look";
  const label = toLabelOf(d);
  return d.mode === "ask"
    ? `Ask ${label} something they must answer`
    : `Tell ${label} what to do, decide or check`;
}

/** The send button's word: what this send will do. */
export function sendLabel(d: Draft, rep: FeedEvent | null): string {
  if (rep) return "Send reply";
  if (d.mode === "task") return "Create task";
  const label = toLabelOf(d);
  return d.mode === "ask" ? `Ask ${label}` : `Send to ${label}`;
}

/** The send button's icon: plus when it creates a task, the paper plane otherwise. */
export const sendIcon = (d: Draft, rep: FeedEvent | null): IconName =>
  d.mode === "task" && !rep ? "plus" : "send";

/** What a send still needs: the message box when a reply or message has no words, the title when a
 *  task has no name. Null when the send may go out (compose.js send's guards). */
export function missingField(d: Draft, msg: string): "msg" | "title" | null {
  if (d.reply != null || d.mode !== "task") return msg ? null : "msg";
  return d.title.trim() ? null : "title";
}

/** The task_create args: the title, the owner, what it waits on, the phase and the details. */
const taskArgs = (d: Draft, what: string | undefined): Record<string, unknown> => ({
  title: d.title.trim(),
  owner: d.to || undefined,
  after: d.after,
  phase: d.phase ?? undefined,
  what,
});

/** The send args: the recipient, the words, whether an answer is owed, and the task it is about. */
const msgArgs = (d: Draft, msg: string): Record<string, unknown> => ({
  to: d.to || undefined,
  msg,
  ask: d.mode === "ask" || undefined,
  task: d.about[0] || undefined,
});

/** The plain send's confirmation: who was asked, who was told. */
const sendOkText = (d: Draft): string =>
  d.mode === "ask" ? `Asked ${d.to || "everyone"}` : `Sent to ${d.to || "everyone"}`;

/** The task's confirmation: its id, its owner, what it starts after. */
const createdText = (r: unknown, d: Draft): string => {
  const tid = (r as { task?: { id?: string } | null } | null)?.task?.id;
  return `Created ${tid}${d.to ? ` for ${d.to}` : ""}${d.after.length > 0 ? `. It starts after ${d.after.join(", ")}` : ""}.`;
};

/** What a composer shows: the channel and place it drafts for, the data its pickers rank, and where
 *  its sends and toasts go. The optional tail wires the draft store, a fixed recipient and the
 *  dialog shell; the page's own defaults cover them. */
export type ComposerProps = {
  /** The channel to send to; the first half of the draft key. */
  ch: string;
  /** Where this composer sits ("dlg", "s:<session>", …); the second half of the draft key. */
  place: string;
  /** The roster the To menu offers. */
  sessions: readonly RosterSession[];
  /** The plan the task pickers rank. */
  board: Board | null;
  /** Looks a plan task up by id, for the pickers' chips. */
  byId: (id: string) => PlanStep | null | undefined;
  /** The API client: reply / task_create / send go through api.op. */
  api: Api;
  /** Called once a send succeeded (see ComposeSent). */
  onSent: ComposeSent;
  /** The toast stack: the confirmations and the server's refusals. */
  toast: ToastFn;
  /** openCompose's options, applied to the draft whenever they change. */
  initial?: ComposeOptions | undefined;
  /** A fixed recipient: the To menu hides (the session drawer's composer). */
  to?: string | undefined;
  /** The timeline, to find the event a reply answers. */
  timeline?: readonly FeedEvent[] | null | undefined;
  /** Renders as the body of the shared dialog: four message rows, the padding, a Cancel button. */
  dialog?: boolean | undefined;
  /** Closes the host dialog: after a send, and from the Cancel button. */
  onCancel?: (() => void) | undefined;
  /** The composer's drafts; a store over `storage`/`timers` when omitted. */
  drafts?: Drafts | undefined;
  /** Where drafts persist when `drafts` is omitted; the page's localStorage when omitted. */
  storage?: Storage | undefined;
  /** The save timer when `drafts` is omitted; the browser's when omitted. */
  timers?: Timers | undefined;
  /** The current time, for the replied-to event's relative stamp; Date.now() when omitted. */
  now?: number | undefined;
  /** Told the draft after every repaint (the dialog's title reads mode and reply from it). */
  onDraft?: ((d: Draft) => void) | undefined;
};

/** The composer: to, kind, the task fields or the reply block, the message box and the send button. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: compose.js mount, ported as one component
export function Composer(props: ComposerProps): JSX.Element {
  const {
    ch,
    place,
    sessions,
    board,
    byId,
    api,
    onSent,
    toast,
    timeline,
    dialog = false,
    onCancel,
    onDraft,
  } = props;

  const fallback = useMemo(
    () => createDrafts(props.storage ?? localDraftStorage(), props.timers ?? browserTimers),
    [props.storage, props.timers],
  );
  const drafts = props.drafts ?? fallback;
  const d = drafts.draft(ch, place);

  const [, setGen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [titleBad, setTitleBad] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const title = useRef<HTMLInputElement | null>(null);

  // the draft object is shared and mutable; a repaint reads it back (compose.js remounted the host)
  const paint = (): void => {
    onDraft?.(d);
    setGen((g) => g + 1);
  };

  const saveDraft = (): void => {
    drafts.save(ch, place);
  };

  // openCompose's head, run before the first paint so the composer mounts with the caller's options
  // already on the draft (openCompose mutated the draft, then mounted the host): a fixed recipient
  // wins over the menu, and the same content never applies twice
  const appliedKey = useRef<string | null>(null);
  const initialKey = `${JSON.stringify(props.initial ?? null)} ${props.to ?? ""}`;
  if (appliedKey.current !== initialKey) {
    appliedKey.current = initialKey;
    applyInitial(d, props.initial ?? {});
    if (props.to) d.to = props.to;
  }

  // …and the changed draft is saved and announced (the host's title follows it)
  useEffect(() => {
    saveDraft();
    paint();
  }, [initialKey, d, drafts, ch, place]);

  // a reply the timeline no longer carries is dropped (mount's missing-seq check)
  useEffect(() => {
    if (d.reply == null || !timeline) return;
    if (!timeline.some((x) => x.seq === d.reply)) {
      d.reply = null;
      saveDraft();
      paint();
    }
  }, [timeline, d, drafts, ch, place]);

  // a save still pending when the composer goes away must land anyway
  useEffect(() => () => drafts.flush(), [drafts]);

  const P = place.replace(/[^\w-]/g, "_");
  const rep = findReply(timeline, d.reply);
  const at = props.now ?? Date.now();

  const tasks: PickerTask[] = (board?.steps ?? []).map((s) => ({
    ...s,
    status: s.status ?? "todo",
    title: s.title ?? s.id,
  }));
  const lookup = (id: string): PickerTask | null => {
    const s = byId(id);
    return s ? { ...s, status: s.status ?? "todo", title: s.title ?? s.id } : null;
  };

  const setTo = (to: string): void => {
    d.to = to;
    saveDraft();
    paint();
  };
  const setMode = (mode: ComposeMode): void => {
    d.mode = mode;
    saveDraft();
    paint();
  };
  const setMessage = (msg: string): void => {
    d.msg = msg;
    saveDraft();
  };
  const setTitle = (t: string): void => {
    d.title = t;
    saveDraft();
    setTitleBad(false);
  };
  const cancelReply = (): void => {
    d.reply = null;
    saveDraft();
    paint();
  };

  /** One owner op: the server's word back, its refusal toasted (core.js act). */
  const runOp = async (name: ComposeOp, args: Record<string, unknown>, ok?: string): Promise<unknown> => {
    try {
      const r = await api.op(ch, name, args);
      if (ok) toast(ok);
      return (r as { result?: unknown } | null)?.result ?? true;
    } catch (e) {
      const err = e as Error & { status?: number };
      const m = err.message ?? String(e);
      toast(
        err.status === 404 && /no operation/.test(m)
          ? `This Huddle server does not support “${name}” yet. Update the server.`
          : m,
        { bad: true },
      );
      return null;
    }
  };

  /** The op this send runs, its result: a reply, a task (its Created toast), or a plain send. */
  const dispatch = async (): Promise<[ComposeOp, unknown]> => {
    const msg = d.msg.trim();
    if (d.reply != null) return ["reply", await runOp("reply", { seq: d.reply, msg }, "Reply sent")];
    if (d.mode === "task") {
      const r = await runOp("task_create", taskArgs(d, msg || undefined));
      if (r) toast(createdText(r, d));
      return ["task_create", r];
    }
    return ["send", await runOp("send", msgArgs(d, msg), sendOkText(d))];
  };

  const send = async (): Promise<void> => {
    const missing = missingField(d, d.msg.trim());
    if (missing === "msg") {
      box.current?.focus();
      return;
    }
    if (missing === "title") {
      title.current?.focus();
      setTitleBad(true);
      return;
    }
    setBusy(true);
    const [op, r] = await dispatch();
    setBusy(false);
    if (!r) return;
    d.msg = "";
    d.title = "";
    d.after = [];
    d.about = [];
    d.reply = null;
    setTitleBad(false);
    saveDraft();
    onSent(op);
    if (dialog) {
      onCancel?.();
      return;
    }
    paint();
    box.current?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the composer's ⌘/Ctrl+Enter, the legacy host handler
    <div
      class={`flex flex-col gap-3${dialog ? " p-4" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
      }}
    >
      {rep ? (
        <div class="flex items-start gap-3 rounded-lg bg-base-200 p-3 text-sm">
          <span class="mt-0.5 text-base-content/50">
            <Icon name="undo" class="size-4" />
          </span>
          <div class="min-w-0 flex-1">
            Replying to <b>{rep.from}</b>, <Time ts={rep.ts} now={at} />
            <div class="line-clamp-2 mt-0.5 muted">
              <Inline text={(rep.msg ?? "").slice(0, 300)} />
            </div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" onClick={cancelReply}>
            Cancel reply
          </button>
        </div>
      ) : (
        <>
          <div class="flex flex-wrap items-center gap-2">
            {props.to === undefined ? (
              <label class="flex min-w-44 flex-1 items-center gap-2 text-sm muted">
                To{" "}
                <select
                  id={`${P}-to`}
                  class="select min-w-0 flex-1"
                  value={d.to}
                  onChange={(e) => setTo(e.currentTarget.value)}
                >
                  <option value="">Everyone</option>
                  {recipientNames(sessions, d.to).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {/* biome-ignore lint/a11y/useSemanticElements: a segmented control, not a section */}
            <div class="join" role="group" aria-label="Kind">
              {MODES.map(([k, l, ic]) => (
                <button
                  key={k}
                  type="button"
                  data-mode={k}
                  class={`btn join-item btn-sm${d.mode === k ? " btn-primary" : ""}`}
                  aria-pressed={d.mode === k}
                  onClick={() => setMode(k)}
                >
                  <Icon name={ic} class="size-4.5" />
                  {l}
                </button>
              ))}
            </div>
          </div>
          {d.mode === "task" ? (
            <>
              <label class="flex flex-col gap-1.5 text-sm font-medium">
                Title{" "}
                <input
                  ref={title}
                  id={`${P}-title`}
                  class="input"
                  placeholder={`What should ${toLabelOf(d)} finish?`}
                  autocomplete="off"
                  aria-describedby={`${P}-terr`}
                  aria-invalid={titleBad ? "true" : undefined}
                  value={d.title}
                  onInput={(e) => setTitle(e.currentTarget.value)}
                />
              </label>
              <p class="flex items-center gap-1.5 text-sm text-error" id={`${P}-terr`} hidden={!titleBad}>
                <Icon name="alert" class="size-4" />A task needs a title.
              </p>
              <div class="flex flex-col gap-1.5 text-sm font-medium">
                <span id={`${P}-afl`}>
                  Waits on{" "}
                  <span class="text-sm font-normal muted">(optional: it starts once these are done)</span>
                </span>
                <Picker
                  id={`${P}-after`}
                  value={d.after}
                  tasks={tasks}
                  byId={lookup}
                  label="Tasks it waits on"
                  placeholder="Pick tasks that must finish first"
                  onChange={(ids) => {
                    d.after = ids;
                    saveDraft();
                    paint();
                  }}
                />
              </div>
            </>
          ) : null}
        </>
      )}
      <label class={!rep && d.mode === "task" ? "label" : "sr-only"} for={`${P}-msg`}>
        {!rep && d.mode === "task" ? (
          <>
            Details <span class="text-xs font-normal muted">(optional)</span>
          </>
        ) : (
          "Message"
        )}
      </label>
      <textarea
        ref={box}
        id={`${P}-msg`}
        class="textarea"
        rows={dialog ? 5 : 3}
        placeholder={msgPlaceholder(d, rep)}
        value={d.msg}
        onInput={(e) => setMessage(e.currentTarget.value)}
      />
      {!rep && d.mode !== "task" ? (
        <div class="flex flex-col gap-1.5 text-sm font-medium">
          <span>
            About a task <span class="text-sm font-normal muted">(optional)</span>
          </span>
          <Picker
            id={`${P}-about`}
            value={d.about}
            tasks={tasks}
            byId={lookup}
            label="Task it is about"
            placeholder="Link a task"
            max={1}
            onChange={(ids) => {
              d.about = ids;
              saveDraft();
              paint();
            }}
          />
        </div>
      ) : null}
      <p class="text-sm muted" id={`${P}-fx`}>
        {rep ? `${rep.from} gets it as the answer, and the question closes.` : effect(d)}
      </p>
      <div class="flex items-center gap-2">
        <span class="hidden items-center text-sm muted sm:flex">
          <kbd class="kbd kbd-sm">⌘</kbd>
          <kbd class="kbd kbd-sm">↵</kbd> sends
        </span>
        <span class="flex-1" />
        {dialog && onCancel ? (
          <button type="button" class="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          class="btn btn-primary"
          id={`${P}-send`}
          disabled={busy}
          onClick={() => void send()}
        >
          <Icon name={sendIcon(d, rep)} class="size-4" />
          {sendLabel(d, rep)}
        </button>
      </div>
    </div>
  );
}
