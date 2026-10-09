// drafts.ts — the composer's drafts: one per channel + place, persisted under
// "huddle:draft:<ch>:<place>", so a half-written message survives a re-render and a reload.
// Port of compose.js DRAFTS/draft/save; the storage and the save timer are injected, so tests
// drive the debounce instead of waiting on it.

import { readPref, type Storage, writePref } from "../storage.ts";
import type { Timers } from "../store.ts";

/** How long a save waits for the next keystroke (compose.js save). */
const DRAFT_DELAY = 300;

/** The composer's kinds: a plain message, a question that must be answered, a task for someone. */
export type ComposeMode = "msg" | "ask" | "task";

/** What a caller pins on the draft before the composer shows (compose.js openCompose's o). */
export type ComposeOptions = {
  /** Preselect the recipient; "" means everyone. */
  to?: string | undefined;
  /** Open straight onto this kind. */
  mode?: ComposeMode | undefined;
  /** Compose as the answer to this ask's seq; without it a pending reply is cancelled. */
  reply?: number | null | undefined;
  /** Link the message to one task id. */
  about?: string | undefined;
  /** The task ids a new task waits on. */
  after?: string[] | undefined;
  /** The plan phase a new task lands in. */
  phase?: number | null | undefined;
};

/** One composer's state, the fields the legacy draft object carried. */
export type Draft = {
  to: string;
  mode: ComposeMode;
  msg: string;
  title: string;
  after: string[];
  about: string[];
  phase: number | null;
  reply: number | null;
};

/** A fresh draft: everyone, a plain message, nothing written yet. */
const EMPTY: Draft = {
  to: "",
  mode: "msg",
  msg: "",
  title: "",
  after: [],
  about: [],
  phase: null,
  reply: null,
};

/** The storage key of one channel + place's draft, under the "huddle:" prefix. */
export const draftKey = (ch: string, place: string): string => `draft:${ch}:${place}`;

/** Applies a caller's options to a draft: a reply wins over to and mode, and a plain open (no
 *  reply) cancels a pending reply. Port of compose.js openCompose's first lines. */
export function applyInitial(d: Draft, o: ComposeOptions): void {
  if (o.reply != null) d.reply = o.reply;
  else {
    d.reply = null;
    if (o.to !== undefined) d.to = o.to;
    if (o.mode) d.mode = o.mode;
  }
  if (o.about) d.about = [o.about];
  if (o.after) d.after = o.after;
  if (o.phase != null) d.phase = o.phase;
}

/** The drafts of one page: read a draft, save it (debounced), flush or drop the pending saves. */
export type Drafts = {
  /** The draft of one channel + place, merged over the defaults; the same object until reload. */
  draft(ch: string, place: string): Draft;
  /** Persists the draft 300 ms out; another save for the same draft replaces the pending one. */
  save(ch: string, place: string): void;
  /** Writes every pending draft now (the composer went away before its timer ran). */
  flush(): void;
  /** Cancels every pending save without writing (teardown). */
  dispose(): void;
};

/** Builds the draft store over an injected storage and save timer. */
export function createDrafts(storage: Storage, timers: Timers): Drafts {
  const cache = new Map<string, Draft>();
  const pending = new Map<string, { ch: string; place: string; h: unknown }>();

  const draft = (ch: string, place: string): Draft => {
    const key = draftKey(ch, place);
    let d = cache.get(key);
    if (!d) {
      const stored = readPref<Partial<Draft>>(storage, key, {});
      // fresh arrays: a stored list must never be shared with the defaults or another draft
      d = { ...EMPTY, ...stored, after: [...(stored.after ?? [])], about: [...(stored.about ?? [])] };
      cache.set(key, d);
    }
    return d;
  };

  const write = (ch: string, place: string): void => {
    writePref(storage, draftKey(ch, place), draft(ch, place));
  };

  const save = (ch: string, place: string): void => {
    const key = draftKey(ch, place);
    const p = pending.get(key);
    if (p) timers.cancel(p.h);
    pending.set(key, {
      ch,
      place,
      h: timers.after(() => {
        pending.delete(key);
        write(ch, place);
      }, DRAFT_DELAY),
    });
  };

  const flush = (): void => {
    for (const p of pending.values()) {
      timers.cancel(p.h);
      write(p.ch, p.place);
    }
    pending.clear();
  };

  const dispose = (): void => {
    for (const p of pending.values()) timers.cancel(p.h);
    pending.clear();
  };

  return { draft, save, flush, dispose };
}

/** The page's localStorage, or a sink that forgets when the browser blocks site data. */
export function localDraftStorage(): Storage {
  try {
    return globalThis.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

/** The browser's timers, the shape the store and the toasts also take. */
export const browserTimers: Timers = {
  after: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  interval: (fn, ms) => setInterval(fn, ms),
  stop: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};
