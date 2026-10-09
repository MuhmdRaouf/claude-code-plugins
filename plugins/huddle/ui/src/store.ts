// store.ts — the open channel's data in one observable store. Loaders fill it (info, board,
// sessions, attention, timeline, extras); `changed(what)` broadcasts every change so views can
// redraw what shows it. The channel's live stream (live.ts) patches the same state in place.
// No DOM here: time, timers and page visibility are injected, so tests drive every branch.
import type { Api } from "./api.ts";
import type { Session as StatusSession, TaskStatus } from "./status.ts";
import { who } from "./status.ts";

/** Time and timers, injected: the app passes the browser's, the tests pass fakes they flush. */
export type Timers = {
  /** One timeout; the handle is opaque and only ever given back to cancel. */
  after(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** A repeating interval; the handle is opaque and only ever given back to stop. */
  interval(fn: () => void, ms: number): unknown;
  stop(handle: unknown): void;
};

/** The store's host: the API client, the timers, whether the page is hidden, and the
 *  screen-reader announcements for fresh Inbox items (core.js's #announce element). */
export type StoreDeps = {
  api: Api;
  timers: Timers;
  /** document.hidden, injected. */
  hidden(): boolean;
  announce(text: string): void;
};

/** What a change was about; views filter by it the way data.js's onChange did. */
export type ChangeWhat =
  | "info"
  | "board"
  | "sess"
  | "att"
  | "tl"
  | "event"
  | "task"
  | "ack"
  | "channel"
  | "conflict"
  | "kb"
  | "ext";

/** The stream's state in one word: connecting until the first hello, live, offline while
 *  reconnecting (data.js's #ldot dot, now data instead of a DOM write). */
export type LiveStatus = "connecting" | "live" | "offline";

/** A channel's config: the bits the chrome and views read, plus whatever else it carries. */
export type ChannelConfig = {
  title?: string;
  repo?: string;
  /** Set when the channel has an orchestrator; its value is the orchestrator's name. */
  orchestrator?: unknown;
} & Record<string, unknown>;

/** GET /api/c/<ch>: the channel's own row — name, config, counts and the repo views it serves. */
export type ChannelInfo = {
  name?: string;
  config?: ChannelConfig;
  stats?: { knowledge?: number; last?: number } & Record<string, unknown>;
  views?: string[];
  turn?: { holder?: string | null } & Record<string, unknown>;
};

/** One step of the plan (GET /board's steps): a task with its phase, owner and dependencies. */
export type PlanStep = {
  id: string;
  phase_n?: number;
  title?: string;
  owner?: string | null;
  kind?: string;
  gate?: string;
  risk?: string;
  status?: TaskStatus;
  value?: string;
  depends?: string[];
  status_by?: string;
  blocked_by?: string[];
  comments?: { n: number; open: number; kinds: string[] } | null;
  edited?: boolean;
};

/** GET /board: the phases of the plan and its steps. */
export type Board = {
  phases?: { n: number; title: string }[];
  steps: PlanStep[];
  meta?: Record<string, unknown>;
};

/** One session of the roster (GET /sessions), as the status model and the views read it. */
export type RosterSession = StatusSession & {
  name: string;
  unread?: number;
  open?: number;
  holds_turn?: boolean;
  parent?: string | null;
  role?: string | null;
  /** What the session says it is doing now, when it is not working a plan step. */
  task?: string;
};

/** GET /sessions: the roster, the turn and the channel config as of right now. */
export type SessionList = {
  sessions: RosterSession[];
  turn?: { holder?: string | null } & Record<string, unknown>;
  config?: ChannelConfig;
};

/** An ask that waits for the owner's reply (the Inbox's questions). */
export type AskItem = {
  seq: number;
  from: string;
  msg?: string;
  ts?: string;
  task?: string | null;
  ref?: string | null;
};

/** A task that waits for the owner's approval (the Inbox's gates). */
export type GateItem = {
  id: string;
  title?: string;
  gate?: string;
  owner?: string | null;
  status?: TaskStatus;
  phase_n?: number;
};

/** A session the owner paused. */
export type PausedItem = { name: string; by?: string; at?: string };

/** A task whose status is blocked. */
export type BlockedItem = {
  id: string;
  title?: string;
  owner?: string | null;
  note?: string;
  waits_on?: string[];
};

/** GET /attention: only what needs the owner right now. */
export type Attention = {
  asks?: AskItem[];
  gates?: GateItem[];
  paused?: PausedItem[];
  blocked?: BlockedItem[];
  open_notes?: number;
  total?: number;
};

/** One timeline event as the API returns it: a seq, the topic, who sent it to whom, and data. */
export type FeedEvent = {
  seq: number;
  topic: string;
  from?: string;
  to?: string;
  ref?: string;
  msg?: string;
  ts?: string;
  /** The seq of the ask this event answers; the store collects who answered which ask. */
  reply_to?: number;
  /** Set when the sender waits for the owner specifically (a desktop notification ask). */
  needs_reply?: boolean;
  data?: Record<string, unknown>;
};

/** A presence patch from the stream: one session's fresh fields, keyed by its name. */
export type PresencePatch = Partial<RosterSession> & { name: string };

/** One approval request Radar saw (a command a rule names, awaiting the owner). */
export type Approval = { seq: number; from: string; labels?: string[]; ts?: string };

/** One Radar alert. */
export type RadarAlert = {
  id: number | string;
  kind: string;
  session: string;
  agent?: boolean;
  detail?: string;
  since?: string;
  cost?: number | null;
};

/** GET /x/radar when Radar runs for this channel. */
export type Radar = {
  available: true;
  alerts?: RadarAlert[];
  cost?: Record<string, number>;
  total?: number;
  range?: string;
};

/** The store's extras for one channel: approval requests plus Radar, when it runs. */
export type Extras = { ch: string; approvals: Approval[]; obs: Radar | null };

/** A row of GET /api/channels, for the channel switcher and the Home cards. */
export type ChannelSummary = { name: string; title?: string };

/** The whole store state. Like core.js's S it is one object, mutated in place; views read
 *  fields fresh on every change notification. */
export type HuddleState = {
  /** The open channel, or null on the channels page. */
  ch: string | null;
  info: ChannelInfo | null;
  board: Board | null;
  /** The board's steps by id, rebuilt on every board load. */
  byId: Map<string, PlanStep>;
  sessions: SessionList | null;
  /** The timeline, newest last; older pages are prepended by olderTimeline. */
  timeline: FeedEvent[] | null;
  attention: Attention | null;
  /** Every channel on this Huddle, loaded once per page. */
  channels: ChannelSummary[] | null;
  /** Which names answered which ask: ask seq → the names that replied. */
  replies: Map<number, string[]>;
  /** Approval requests and Radar, for the open channel. */
  extras: Extras | null;
  live: LiveStatus;
};

/** The observable store: the state, change subscriptions and every loader of data.js. */
export type HuddleStore = {
  getState(): HuddleState;
  /** Subscribes to every change; gets (what, x) the way data.js's changed() broadcast it. */
  subscribe(f: (what: ChangeWhat, x?: unknown) => void): () => void;
  /** Broadcasts a change to the subscribers (data.js's changed; views and slices call it). */
  changed(what: ChangeWhat, x?: unknown): void;
  /** Opens a channel: resets its data to empty and remembers the name (app.js's openChannel). */
  setChannel(ch: string | null): void;
  /** The channel list from GET /api/channels (app.js fetches it once per page). */
  loadChannels(): Promise<void>;
  setChannels(list: ChannelSummary[]): void;
  loadInfo(): Promise<void>;
  loadBoard(): Promise<Board | null>;
  loadSessions(): Promise<void>;
  loadAttention(): Promise<void>;
  loadTimeline(): Promise<void>;
  /** Loads the page before the timeline's first event; gives how many events it added. */
  olderTimeline(): Promise<number>;
  /** The Inbox badge: asks + gates + paused + blocked, plus the extras' needs. */
  inboxCount(): number;
  /** Debounced refills, the way the stream asks for them (data.js's *Changed). */
  attChanged(): void;
  sessChanged(): void;
  boardChanged(): void;
  setLive(live: LiveStatus): void;
  /** A timeline event from the stream: appends it, notes replies, refills what it touches.
   *  Gives false for an event older than what the store already has (live.ts stays silent). */
  recordEvent(e: FeedEvent): boolean;
  /** A presence patch from the stream: patches the roster entry, or adds the session. */
  applyPresence(p: PresencePatch): void;
  /** Extras: approval requests and Radar (extras.js's load). */
  loadExtras(): Promise<void>;
  /** How many extras need the owner: approvals plus Radar alerts, for the open channel. */
  needs(): number;
  /** "2 permission requests · 1 Radar alert", or "" when there is nothing or no Radar. */
  needsText(): string;
  /** A session's estimated cost today, from Radar; undefined without Radar. */
  costOf(name: string): number | undefined;
  /** Stops the 30 s extras poll and every pending debounce (tests, teardown). */
  dispose(): void;
};

/** Dollars, the way every cost figure shows: whole dollars from 100 up, cents from a cent,
 *  three decimals under that, "$0" for nothing. */
export const usd = (n: number | null | undefined): string =>
  n == null
    ? ""
    : n >= 100
      ? `$${n.toFixed(0)}`
      : n >= 0.01
        ? `$${n.toFixed(2)}`
        : n > 0
          ? `$${n.toFixed(3)}`
          : "$0";

/** Does a channel's config carry an orchestrator (its controls are only shown then)? */
export const hasOrch = (info: ChannelInfo | null): boolean =>
  !!info?.config && info.config.orchestrator !== undefined;

/** Which Inbox items an attention snapshot holds, keyed like data.js's SEEN (a/g/p/b + id). */
export function inboxKeys(a: Attention): Map<string, string> {
  return new Map<string, string>([
    ...(a.asks ?? []).map((x): [string, string] => [`a${x.seq}`, `${who(x.from)} asks you`]),
    ...(a.gates ?? []).map((x): [string, string] => [`g${x.id}`, `${x.id} waits for your approval`]),
    ...(a.paused ?? []).map((x): [string, string] => [`p${x.name}`, `${x.name} is paused`]),
    ...(a.blocked ?? []).map((x): [string, string] => [`b${x.id}`, `${x.id} is blocked`]),
  ]);
}

/** The screen-reader line for the Inbox items that just arrived: three named, the rest counted. */
export function freshInboxText(fresh: string[]): string {
  return `New in Inbox: ${fresh.slice(0, 3).join("; ")}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ""}.`;
}

/** A debounce by key: a second call for the same key replaces the pending one (core.js's soon,
 *  minus the pointer deferral — Preact keeps the node under the pointer by itself). */
export function createSoon(timers: Timers): (key: string, f: () => void, ms?: number) => void {
  const pending = new Map<string, unknown>();
  return (key, f, ms = 350) => {
    const h = pending.get(key);
    if (h !== undefined) timers.cancel(h);
    pending.set(key, timers.after(f, ms));
  };
}

/** Builds the store over its injected host. */
export function createStore(deps: StoreDeps): HuddleStore {
  const { api, channelPath } = deps.api;
  const soon = createSoon(deps.timers);

  const state: HuddleState = {
    ch: null,
    info: null,
    board: null,
    byId: new Map(),
    sessions: null,
    timeline: null,
    attention: null,
    channels: null,
    replies: new Map(),
    extras: null,
    live: "connecting",
  };

  const subs = new Set<(what: ChangeWhat, x?: unknown) => void>();
  const changed: HuddleStore["changed"] = (what, x) => {
    for (const f of subs) {
      try {
        f(what, x);
      } catch (e) {
        console.error(e);
      }
    }
  };

  // ── loaders ──────────────────────────────────────────────────────────────────
  async function loadInfo(): Promise<void> {
    const ch = state.ch;
    if (!ch) return;
    try {
      const i = (await api(channelPath(ch, ""))) as ChannelInfo;
      if (state.ch !== ch) return;
      state.info = i;
      changed("info");
    } catch (e) {
      // a 404 names a channel that does not exist: syncChannel paints the No channel page and
      // never opens the stream. Anything else is transient — the stream still serves the rest,
      // so the old row stays.
      if ((e as { status?: number }).status === 404) throw e;
    }
  }

  async function loadBoard(): Promise<Board | null> {
    const ch = state.ch;
    if (!ch) return null;
    const b = (await api(channelPath(ch, "/board"))) as Board;
    if (state.ch !== ch) return null;
    state.board = b;
    state.byId = new Map(b.steps.map((s) => [s.id, s]));
    changed("board");
    return b;
  }

  async function loadSessions(): Promise<void> {
    const ch = state.ch;
    if (!ch) return;
    let s: SessionList;
    try {
      s = (await api(channelPath(ch, "/sessions"))) as SessionList;
    } catch {
      return;
    }
    if (state.ch !== ch) return;
    state.sessions = s;
    changed("sess");
  }

  // the Inbox: only what needs the owner (asks, approvals, paused sessions, blocked tasks)
  let seen: { ch: string; keys: Map<string, string> } | null = null;
  async function loadAttention(): Promise<void> {
    const ch = state.ch;
    if (!ch) return;
    let a: Attention;
    try {
      a = (await api(channelPath(ch, "/attention"))) as Attention;
    } catch {
      return;
    }
    if (state.ch !== ch) return;
    state.attention = a;
    const keys = inboxKeys(a);
    const prior = seen;
    if (prior && prior.ch === ch) {
      const fresh = [...keys.entries()].filter(([k]) => !prior.keys.has(k)).map(([, t]) => t);
      if (fresh.length) deps.announce(freshInboxText(fresh));
    }
    seen = { ch, keys };
    changed("att");
  }

  async function loadTimeline(): Promise<void> {
    const ch = state.ch;
    if (!ch) return;
    const t = (await api(channelPath(ch, "/timeline?limit=300")).catch(() => [])) as FeedEvent[];
    if (state.ch !== ch) return;
    state.timeline = t;
    state.replies = new Map();
    for (const e of t) addReply(e);
    changed("tl");
  }

  async function olderTimeline(): Promise<number> {
    const ch = state.ch;
    const first = state.timeline?.[0]?.seq;
    if (!ch || !first) return 0;
    const more = (await api(channelPath(ch, `/timeline?limit=300&before=${first}`)).catch(
      () => [],
    )) as FeedEvent[];
    for (const e of more) addReply(e);
    state.timeline = more.concat(state.timeline ?? []);
    return more.length;
  }

  // ── stream patches (live.ts calls these) ─────────────────────────────────────
  function addReply(e: FeedEvent): void {
    if (!e.reply_to || !e.from) return;
    const a = state.replies.get(e.reply_to) ?? [];
    if (!a.includes(e.from)) a.push(e.from);
    state.replies.set(e.reply_to, a);
  }

  /** Appends one event to the timeline, newest last, capped at 3000: false when it is old news. */
  function appendEvent(e: FeedEvent): boolean {
    if (!state.timeline) return true;
    const last = state.timeline.length ? (state.timeline[state.timeline.length - 1]?.seq ?? 0) : 0;
    if (e.seq <= last) return false;
    state.timeline.push(e);
    if (state.timeline.length > 3000) state.timeline.splice(0, state.timeline.length - 3000);
    return true;
  }

  function recordEvent(e: FeedEvent): boolean {
    if (!appendEvent(e)) return false;
    addReply(e);
    changed("event", e);
    attChanged();
    sessChanged();
    if (/^kb\./.test(e.topic)) changed("kb");
    return true;
  }

  function applyPresence(p: PresencePatch): void {
    if (!p || !state.sessions) return;
    const ss = state.sessions.sessions;
    const i = ss.findIndex((x) => x.name === p.name);
    const cur = i >= 0 ? ss[i] : undefined;
    const was = cur?.control;
    if (cur) ss[i] = { ...cur, ...p } as RosterSession;
    else ss.push({ unread: 0, open: 0, holds_turn: false, ...p } as RosterSession);
    if (p.control !== undefined && p.control !== was) attChanged();
    soon("presence", () => changed("sess"), 60);
  }

  // ── debounced refills ────────────────────────────────────────────────────────
  const attChanged = (): void => {
    if (state.ch) soon("att", () => void loadAttention(), 500);
  };
  const sessChanged = (): void => {
    if (state.ch) soon("sess", () => void loadSessions(), 400);
  };
  const boardChanged = (): void => {
    if (state.ch) soon("board", () => loadBoard().catch(() => {}), 350);
  };

  // ── extras: approval requests and Radar, for the open channel (extras.js) ────
  async function loadExtras(): Promise<void> {
    const ch = state.ch;
    if (!ch) return;
    const [a, o] = await Promise.all([
      api(channelPath(ch, "/x/approvals")).catch(() => null),
      api(channelPath(ch, "/x/radar")).catch(() => null),
    ]);
    if (state.ch !== ch) return;
    const ap = a as { approvals?: Approval[] } | null;
    const rad = o as Partial<Radar> | null;
    state.extras = { ch, approvals: ap?.approvals ?? [], obs: rad?.available ? (rad as Radar) : null };
    changed("att"); // the Inbox, its count and the nav repaint from here
    changed("ext");
  }

  // Radar's alerts change on their own: read again every 30 s while a channel is open and
  // visible — even when Radar answered "unavailable" last time, it may have started since
  const poll = deps.timers.interval(() => {
    if (state.ch && !deps.hidden()) void loadExtras();
  }, 30_000);

  // how many of these need the owner (part of the Inbox count)
  const needs = (): number =>
    state.extras && state.extras.ch === state.ch
      ? state.extras.approvals.length + (state.extras.obs?.alerts?.length ?? 0)
      : 0;
  const needsText = (): string => {
    if (!state.extras || state.extras.ch !== state.ch) return "";
    const a = state.extras.approvals.length;
    const o = state.extras.obs?.alerts?.length ?? 0;
    return [a && `${a} permission request${a > 1 ? "s" : ""}`, o && `${o} Radar alert${o > 1 ? "s" : ""}`]
      .filter(Boolean)
      .join(" · ");
  };
  const costOf = (name: string): number | undefined =>
    state.extras?.ch === state.ch ? state.extras?.obs?.cost?.[name] : undefined;

  // a fresh approval request asks soon; a just-opened channel fills its extras as soon as
  // anything else lands (the att/ext changes the fill itself causes are skipped)
  subs.add((what, x) => {
    if (what === "event" && (x as { topic?: string } | undefined)?.topic === "approval.request")
      soon("ext", () => void loadExtras(), 300);
    else if (state.ch && state.extras?.ch !== state.ch && what !== "att" && what !== "ext")
      soon("ext", () => void loadExtras(), 50);
  });

  return {
    getState: () => state,
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
    changed,
    setChannel(ch) {
      state.ch = ch;
      state.info = null;
      state.board = null;
      state.byId = new Map();
      state.sessions = null;
      state.timeline = null;
      state.attention = null;
    },
    async loadChannels() {
      try {
        state.channels = (await api("/api/channels")) as ChannelSummary[];
      } catch {
        // the switcher simply offers nothing this once
      }
    },
    setChannels(list) {
      state.channels = list;
    },
    loadInfo,
    loadBoard,
    loadSessions,
    loadAttention,
    loadTimeline,
    olderTimeline,
    inboxCount(): number {
      const a = state.attention;
      const att = a
        ? (a.asks?.length ?? 0) + (a.gates?.length ?? 0) + (a.paused?.length ?? 0) + (a.blocked?.length ?? 0)
        : 0;
      return att + needs();
    },
    attChanged,
    sessChanged,
    boardChanged,
    setLive(live) {
      state.live = live;
    },
    recordEvent,
    applyPresence,
    loadExtras,
    needs,
    needsText,
    costOf,
    dispose() {
      deps.timers.stop(poll);
    },
  };
}
