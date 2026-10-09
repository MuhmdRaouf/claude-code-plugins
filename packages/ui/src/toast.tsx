// toast.tsx — the toast stack: short confirmations and errors at the bottom of the screen, each with a
// dismiss button, an optional Undo action and its own lifetime (8s with Undo, 6s for an error, 3s else).
// A good toast is a polite live region, a bad one an assertive alert. Port of core.js toast; the timers are
// injectable so tests can step time instead of waiting.

import type { ComponentChildren, JSX } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.tsx";

/** The timers a stack lives on; inject fakes in tests. */
export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as number),
};

/** How a toast behaves: `bad` turns it into an alert, `undo` adds the Undo button and a longer life. */
export type ToastOptions = {
  bad?: boolean | undefined;
  undo?: (() => void) | undefined;
};

/** One toast in the stack while it is on screen (or leaving). */
type Toast = {
  id: number;
  text: string;
  bad: boolean;
  undo: (() => void) | undefined;
  out: boolean;
};

/** What useToast hands out: show a toast. */
export type ToastFn = (text: string, opts?: ToastOptions) => void;

const Push = createContext<ToastFn | null>(null);

const LIFETIME = { undo: 8000, bad: 6000, good: 3000, out: 180 } as const;
const MAX_TOASTS = 4;

/** The stack's shell: the classes the legacy index.html put on #toasts, popover attribute included. */
const SHELL =
  "pointer-events-none fixed inset-x-3 top-auto bottom-20 z-50 m-0 w-auto overflow-visible border-0 bg-transparent p-0 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end";

/** Show the popover so the stack paints above dialogs; where the engine has no popover API this is a no-op. */
function raise(box: HTMLElement | null): void {
  try {
    if (box?.matches(":popover-open")) box.hidePopover();
    box?.showPopover();
  } catch {
    // no popover support: the stack renders in place
  }
}

/** Provides `useToast` for the tree below it and renders the stack itself. */
export function ToastProvider({
  children,
  timers = realTimers,
}: {
  children: ComponentChildren;
  timers?: Timers | undefined;
}): JSX.Element {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const live = useRef(new Map<number, unknown>());
  const seq = useRef(0);

  const stop = (id: number): void => {
    const tm = live.current.get(id);
    if (tm !== undefined) timers.clear(tm);
    live.current.delete(id);
  };

  /** Play the leave animation, then take the toast away 180ms later. */
  const kill = (t: Toast): void => {
    stop(t.id);
    setToasts((all) => all.map((x) => (x.id === t.id ? { ...x, out: true } : x)));
    live.current.set(
      t.id,
      timers.set(() => {
        stop(t.id);
        setToasts((all) => all.filter((x) => x.id !== t.id));
      }, LIFETIME.out),
    );
  };

  const push: ToastFn = (text, opts = {}) => {
    seq.current += 1;
    const t: Toast = { id: seq.current, text, bad: opts.bad === true, undo: opts.undo, out: false };
    setToasts((all) => {
      const next = [...all, t];
      const over = next.length - MAX_TOASTS;
      for (const gone of over > 0 ? next.slice(0, over) : []) stop(gone.id);
      return over > 0 ? next.slice(over) : next;
    });
    live.current.set(
      t.id,
      timers.set(() => kill(t), t.undo ? LIFETIME.undo : t.bad ? LIFETIME.bad : LIFETIME.good),
    );
  };

  // a new or gone toast must sit on top of the top layer again, above dialogs opened meanwhile
  useEffect(() => raise(box.current), [toasts]);

  // leaving a page stops every toast it still owns
  useEffect(
    () => () => {
      for (const tm of live.current.values()) timers.clear(tm);
      live.current.clear();
    },
    [timers],
  );

  return (
    <Push.Provider value={push}>
      {children}
      <div ref={box} popover="manual" class={SHELL} aria-live="polite">
        {toasts.map((t) => (
          <ToastRow key={t.id} t={t} onKill={() => kill(t)} />
        ))}
      </div>
    </Push.Provider>
  );
}

/** One toast row: its kind icon, the text, the optional Undo and the dismiss button. */
function ToastRow({ t, onKill }: { t: Toast; onKill: () => void }): JSX.Element {
  const icon: IconName = t.bad ? "alert" : "check";
  return (
    <div
      class={`toast hr-toast ${t.bad ? "hr-toast-bad" : "hr-toast-good"}${t.out ? " out" : ""}`}
      role={t.bad ? "alert" : "status"}
    >
      <span class="ink">
        <Icon name={icon} class="size-4" />
      </span>
      <span class="min-w-0 flex-1">{t.text}</span>
      {t.undo ? (
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => {
            onKill();
            t.undo?.();
          }}
        >
          <Icon name="undo" class="size-3.5" />
          Undo
        </button>
      ) : null}
      <button type="button" class="btn btn-ghost btn-icon" aria-label="Dismiss" onClick={onKill}>
        <Icon name="x" class="size-3.5" />
      </button>
    </div>
  );
}

/** Show a toast from inside the provider: `toast("Saved")`, `toast("Gone", { undo: restore })`. */
export function useToast(): ToastFn {
  const push = useContext(Push);
  if (!push) throw new Error("useToast: no ToastProvider above this component");
  return push;
}
