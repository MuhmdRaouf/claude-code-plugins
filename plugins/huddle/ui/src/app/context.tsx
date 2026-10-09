// context.tsx — what every page and every chrome piece read: the store's state, the API client,
// the paint's time, navigation, owner actions and toasts. One provider at the boot; useHuddle
// reads it. The provider is rebuilt on every change by main.tsx, so pages stay pure props-in.
import type { ToastFn } from "@muhmdraouf/ui/toast.tsx";
import type { ComponentChildren, JSX } from "preact";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Api, ApiError } from "../api.ts";
import type { HuddleState } from "../store.ts";

/** The slice of core.js toast the pages use: a line at the bottom, red when it is bad news,
 *  with an Undo where the action offers one. The shared toast's own type. */
export type { ToastFn };

/** The value under HuddleProvider, rebuilt on every change. */
export type HuddleContextValue = {
  /** The open channel's state, Home's included (ch null). Mutated in place by the loaders. */
  state: HuddleState;
  api: Api;
  /** This paint's time; a component never reads the clock itself, so tests stay deterministic. */
  now: number;
  /** Navigates: sets the hash, or re-routes when that hash is already the address (app.js go). */
  go(href: string): void;
  /** An owner action: POST /op/<name>?as=owner, toast the refusal, give the result or null
   *  (core.js act, minus the success toast — callers celebrate their own way). */
  act(name: string, args?: Record<string, unknown>): Promise<unknown | null>;
  toast: ToastFn;
  /** Writes text to the clipboard and says so; a refused write is toasted too (core.js copy). */
  copy(text: string, message?: string): void;
};

export const HuddleContext = createContext<HuddleContextValue | null>(null);

/** Provides the context for the tree below it. */
export function HuddleProvider({
  value,
  children,
}: {
  value: HuddleContextValue;
  children: ComponentChildren;
}): JSX.Element {
  return <HuddleContext.Provider value={value}>{children}</HuddleContext.Provider>;
}

/** The context every component of the shell runs under. */
export function useHuddle(): HuddleContextValue {
  const v = useContext(HuddleContext);
  if (!v) throw new Error("useHuddle: no HuddleProvider above this component");
  return v;
}

/** An error's message: what the server said, or the error itself. */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Builds act over the API client, the open channel and the toast stack (core.js act). */
export function createAct(api: Api, ch: () => string | null, toast: ToastFn): HuddleContextValue["act"] {
  return async (name, args = {}) => {
    const c = ch();
    if (!c) return null;
    try {
      const r = (await api.op(c, name, args)) as { result?: unknown } | undefined;
      return r?.result ?? true;
    } catch (e) {
      const status = (e as ApiError).status;
      toast(
        status === 404 && /no operation/.test(errText(e))
          ? `This Huddle server does not support “${name}” yet. Update the server.`
          : errText(e),
        { bad: true },
      );
      return null;
    }
  };
}

/** Builds copy over the toast stack: the message, or the failure's own (core.js copy). */
export function createCopy(toast: ToastFn): HuddleContextValue["copy"] {
  return (text, message) => {
    navigator.clipboard?.writeText(text).then(
      () => toast(message ?? "Copied"),
      () => toast("Could not copy. Select the text and copy it by hand.", { bad: true }),
    );
  };
}
