// live.ts — the open channel's SSE stream (GET /api/c/<ch>/live?as=owner): it applies every
// message to the store, refills what the stream cannot patch (after a reconnect anything sent
// while away is read once), and shows the connection as the store's live status instead of a
// DOM dot. Desktop notifications for new asks are opt-in and go through an injected wrapper.
// No DOM here: the stream, fetch, storage, notifications and the page state are injected.
import { readPref, type Storage, writePref } from "./storage.ts";
import type { FeedEvent, HuddleStore, PresencePatch } from "./store.ts";

/** The slice of EventSource the stream needs: three handlers and a close. */
export type EventSourceLike = {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close(): void;
};

/** Builds one open stream for a URL (the browser's EventSource, or a fake in tests). */
export type EventSourceFactory = (url: string) => EventSourceLike;

/** Desktop notifications, injected: the browser's Notification in the app, fakes in tests. */
export type Notifications = {
  /** Whether this browser can show notifications at all ("Notification" in window). */
  supported(): boolean;
  /** The current permission: "granted", "denied" or "default". */
  permission(): "granted" | "denied" | "default";
  /** Asks the user; gives the permission they chose. */
  requestPermission(): Promise<"granted" | "denied" | "default">;
  /** Shows one notification; onClick raises the page (window.focus + the Inbox route). */
  show(title: string, body: string, tag: string, onClick: () => void): void;
};

/** One message of the stream, before its type is known. */
export type StreamMessage = { type: string; data?: unknown };

/** The live host: the store it fills, the stream and fetch constructors, this browser's
 *  notification state and the three page bits a notification needs. */
export type LiveDeps = {
  store: HuddleStore;
  EventSource: EventSourceFactory;
  fetch: (url: string) => Promise<Response>;
  /** Per-viewer settings ("notify" on/off), under the huddle: prefix. */
  storage: Storage;
  notify: Notifications;
  /** This browser's sign-in ended: the host replaces the page with the sign-in card. */
  onSignedOut(): void;
  toast(text: string, o?: { bad?: boolean }): void;
  /** document.hidden, injected. */
  hidden(): boolean;
  /** Whether the open page is the Inbox (notifyAsk stays quiet while the owner sits there). */
  inboxOpen(): boolean;
  /** Raises the page onto the channel's Inbox (window.focus + #/c/<ch>/inbox). */
  focusInbox(ch: string | null): void;
};

/** The stream's controls plus the notification switch (data.js's exports). */
export type Live = {
  connect(): void;
  disconnect(): void;
  /** On and staying on: the owner allowed notifications and kept the setting. */
  notifyOn(): boolean;
  /** The Settings toggle: asks the browser, toasts the outcome. */
  toggleNotify(): Promise<void>;
  /** A desktop notification for one ask that waits for the owner (data.js's notifyAsk). */
  notifyAsk(e: FeedEvent): void;
};

export function createLive(deps: LiveDeps): Live {
  const { store } = deps;
  let es: EventSourceLike | null = null;
  let hello = 0;

  /** The channel this stream is for; captured at connect, messages from later channels are
   *  ignored until connect runs again. */
  let connected: string | null = null;

  function connect(): void {
    disconnect();
    connected = store.getState().ch;
    hello = 0;
    store.setLive("connecting");
    es = deps.EventSource(`/api/c/${encodeURIComponent(connected ?? "")}/live?as=owner`);
    es.onopen = () => store.setLive("live");
    es.onerror = () => {
      store.setLive("offline");
      // a 401 here means the sign-in itself ended, not just the stream
      deps
        .fetch("/api/whoami")
        .then((r) =>
          r.status === 401
            ? r.json().then((j) => {
                if (j && (j as { signin?: unknown }).signin) deps.onSignedOut();
              })
            : null,
        )
        .catch(() => {});
    };
    es.onmessage = (ev) => {
      if (store.getState().ch !== connected) return;
      let m: StreamMessage;
      try {
        m = JSON.parse(ev.data) as StreamMessage;
      } catch {
        return;
      }
      handle(m);
    };
  }

  function disconnect(): void {
    try {
      es?.close();
    } catch {
      // already gone
    }
    es = null;
  }

  function handle(m: StreamMessage): void {
    switch (m.type) {
      case "hello":
        store.setLive("live");
        // reconnected: anything sent while we were away was not pushed, so read it once
        if (hello++ > 0) resync();
        else if (!store.getState().timeline) void store.loadTimeline();
        break;
      case "event":
        onEvent(m.data as FeedEvent);
        break;
      case "presence":
        store.applyPresence(m.data as PresencePatch);
        break;
      case "task":
      case "plan":
        store.boardChanged();
        store.attChanged();
        store.changed("task", (m.data as { id?: string } | undefined)?.id);
        break;
      case "ack":
        store.sessChanged();
        break;
      case "channel":
        void store.loadInfo();
        store.sessChanged();
        store.attChanged();
        break;
      case "conflict":
        store.changed("conflict", m.data); // two sessions edited one file
        break;
    }
  }

  /** Reconnected: reload the timeline, roster, board, Inbox and the channel row. */
  function resync(): void {
    void store.loadTimeline();
    void store.loadSessions();
    store.boardChanged();
    store.attChanged();
    void store.loadInfo();
  }

  function onEvent(e: FeedEvent): void {
    if (!store.recordEvent(e)) return;
    if (e.to === "owner" && e.from !== "owner" && e.topic !== "reply")
      deps.toast(
        `${e.from}${e.topic === "ask" ? " asks you" : " to you"}: ${(e.msg || e.topic).slice(0, 140)}`,
      );
    if (e.to === "owner" && e.needs_reply) notifyAsk(e);
  }

  /** On and staying on: the setting is kept and the browser has granted it. */
  function notifyOn(): boolean {
    return (
      readPref(deps.storage, "notify", false) &&
      deps.notify.supported() &&
      deps.notify.permission() === "granted"
    );
  }

  async function toggleNotify(): Promise<void> {
    if (!deps.notify.supported()) {
      deps.toast("This browser cannot show notifications.", { bad: true });
      return;
    }
    if (notifyOn()) {
      writePref(deps.storage, "notify", false);
      deps.toast("Notifications off");
      return;
    }
    const p =
      deps.notify.permission() === "granted"
        ? "granted"
        : await deps.notify.requestPermission().catch(() => "denied" as const);
    if (p !== "granted") {
      writePref(deps.storage, "notify", false);
      deps.toast("The browser blocked notifications for this page. Allow them in the site settings.", {
        bad: true,
      });
      return;
    }
    writePref(deps.storage, "notify", true);
    deps.toast("You will get a notification when a session asks you something.");
  }

  function notifyAsk(e: FeedEvent): void {
    // not while the page is visible and the Inbox already shows the ask
    if (!notifyOn() || (!deps.hidden() && deps.inboxOpen())) return;
    const ch = store.getState().ch;
    try {
      deps.notify.show(`${e.from} asks you`, (e.msg || "").slice(0, 200), `huddle-${ch}-${e.seq}`, () =>
        deps.focusInbox(ch),
      );
    } catch {
      // a blocked or half-supported browser must not break the stream
    }
  }

  return { connect, disconnect, notifyOn, toggleNotify, notifyAsk };
}
