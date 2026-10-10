// main.tsx — the browser entry: the API client, the store, the live stream and the toast stack
// over the browser's own IO; navigation (channel opens and closes follow the hash); the composer
// the shell opens (its button and the C key); and one paint of <App/> per change. Thin glue on
// purpose: everything testable lives in the modules it wires together (same call as radar's main).

import { type ToastFn, ToastProvider, useToast } from "@muhmdraouf/ui/toast.tsx";
import type { ComponentChildren, ComponentType } from "preact";
import { render } from "preact";
import { createApi } from "./api.ts";
import "./app.css";
import { App, NoChannel, SignedOut } from "./app/App.tsx";
import { createAct, createCopy, type HuddleContextValue, HuddleProvider } from "./app/context.tsx";
import { CmdKeys, CmdPalette, HelpDialog } from "./app/Palette.tsx";
import { parseHash, pathOf } from "./app/router.ts";
import { ComposeDialog } from "./compose/ComposeDialog.tsx";
import type { ComposeSent } from "./compose/Composer.tsx";
import type { ComposeOptions } from "./compose/drafts.ts";
import { createLive, type Notifications } from "./live.ts";
import { Home } from "./pages/Home.tsx";
import { Inbox } from "./pages/Inbox.tsx";
import { Knowledge } from "./pages/Knowledge.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Team } from "./pages/Team.tsx";
import { Today } from "./pages/Today.tsx";
import { readPref, writePref } from "./storage.ts";
import { createStore, type Timers } from "./store.ts";
import { SessionDrawer } from "./team/SessionDrawer.tsx";
import type { ViewId } from "./work/model.ts";
import { TaskDrawer } from "./work/TaskDrawer.tsx";
import { Work } from "./work/Work.tsx";

const queried = document.querySelector<HTMLElement>("#app");
const root: HTMLElement =
  queried ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" }));
root.replaceChildren();

const timers: Timers = {
  after: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as number),
  interval: (fn, ms) => setInterval(fn, ms),
  stop: (h) => clearInterval(h as number),
};

/** The screen-reader live region the store announces fresh Inbox items through. */
const announcer = (): HTMLElement => {
  let el = document.getElementById("announce");
  if (!el) {
    el = document.createElement("div");
    el.id = "announce";
    el.className = "sr-only";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    document.body.append(el);
  }
  return el;
};

let signedOutPainted = false;
let failedCh: string | null = null;
let toastFn: ToastFn = () => {};

const api = createApi(fetch, () => paintSignedOut());
const store = createStore({
  api,
  timers,
  hidden: () => document.hidden,
  announce: (text) => {
    announcer().textContent = text;
  },
});

/** The browser's EventSource behind the stream's slice of it (radar's BrowserStream). */
class BrowserSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  private readonly es: EventSource;

  constructor(url: string) {
    this.es = new EventSource(url);
    this.es.onopen = () => this.onopen?.();
    this.es.onerror = () => this.onerror?.();
    this.es.onmessage = (ev) => this.onmessage?.({ data: ev.data });
  }

  close(): void {
    this.es.close();
  }
}

const live = createLive({
  store,
  EventSource: (url) => new BrowserSource(url),
  fetch: (url) => fetch(url),
  storage: localStorage,
  notify: {
    supported: () => "Notification" in window,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    show: (title, body, tag, onClick) => {
      const n = new Notification(title, { body, tag });
      n.onclick = () => {
        window.focus();
        n.close();
        onClick();
      };
    },
  } satisfies Notifications,
  onSignedOut: () => paintSignedOut(),
  toast: (text, o) => toastFn(text, o),
  hidden: () => document.hidden,
  inboxOpen: () => parseHash(location.hash, (k, fb) => readPref(localStorage, k, fb)).dest === "inbox",
  focusInbox: (ch) => {
    window.focus();
    go(ch ? `#/c/${ch}/inbox` : "#/");
  },
});

const act = createAct(
  api,
  () => store.getState().ch,
  (text, o) => toastFn(text, o),
);

/** Navigates: the same hash re-routes, another one moves the address bar (app.js go). */
function go(h: string): void {
  if (location.hash === h) {
    void syncChannel();
    paint();
  } else {
    location.hash = h;
  }
}

/** The composer's state, outside the tree the way the rest of the glue is: the shell's New
 *  message button, the C key, and every page's Message and New task button open it. */
const compose: { open: boolean; options: ComposeOptions | undefined } = {
  open: false,
  options: undefined,
};

/** Opens the composer over the open channel, with the prefill the caller names. */
function openCompose(o?: ComposeOptions): void {
  if (!store.getState().ch) return;
  compose.open = true;
  compose.options = o;
  paint();
}

/** Closes the composer; a send closes it through the dialog's own onCancel. */
function closeCompose(): void {
  if (!compose.open) return;
  compose.open = false;
  compose.options = undefined;
  paint();
}

/** The palette's and the shortcuts dialog's state, the same way the composer's is. */
const palette = { open: false };
const help = { open: false };

function openPalette(): void {
  palette.open = true;
  paint();
}

function closePalette(): void {
  if (!palette.open) return;
  palette.open = false;
  paint();
}

function openHelp(): void {
  help.open = true;
  paint();
}

function closeHelp(): void {
  if (!help.open) return;
  help.open = false;
  paint();
}

/** What the store refills once a send landed: the Inbox now, the board for a new task. */
const onComposeSent: ComposeSent = (op) => {
  store.attChanged();
  if (op === "task_create") void store.loadBoard().catch(() => {});
};

/** Opens and closes channels as the hash moves: reset, the channel row and Inbox first, then the
 *  stream and the roster and board (app.js openChannel). A channel that cannot be read leaves
 *  the address on a page that says so. */
async function syncChannel(): Promise<void> {
  const route = parseHash(location.hash, (k, fb) => readPref(localStorage, k, fb));
  for (const [k, v] of Object.entries(route.prefs)) writePref(localStorage, k, v);
  const ch = route.ch;
  failedCh = null;
  if (ch === store.getState().ch) return;
  closeCompose();
  closePalette();
  closeHelp();
  store.setChannel(ch);
  live.disconnect();
  if (!ch) return;
  try {
    await Promise.all([store.loadInfo(), store.loadAttention()]);
  } catch {
    // no channel row: the address names nothing that exists
    if (ch === store.getState().ch) {
      store.setChannel(null);
      failedCh = ch;
    }
    return;
  }
  live.connect();
  await Promise.all([store.loadSessions(), store.loadBoard().catch(() => {})]);
}

/** Catches the toast stack's push function for the glue that sits outside the tree. */
function ToastBridge(): null {
  toastFn = useToast();
  return null;
}

/** The destination the address bar names, for the pages that read their route (Knowledge's id). */
function routeOf(): ReturnType<typeof parseHash> {
  return parseHash(location.hash, (k, fb) => readPref(localStorage, k, fb));
}

/** One page per destination; the closures read the store fresh on every paint, so the pages stay
 *  pure props-in (main re-renders them on every change). */
const pages: Record<string, ComponentType> = {
  home: () => <Home />,
  overview: () => <Overview onCompose={() => openCompose({ mode: "msg" })} store={store} />,
  today: () => <Today />,
  inbox: () => (
    <Inbox
      state={store.getState()}
      api={api}
      ch={store.getState().ch ?? ""}
      now={Date.now()}
      toast={(text, o) => toastFn(text, o)}
      onCompose={(prefill) => openCompose(prefill)}
      onOpenTask={(id) =>
        go(`${location.hash.split("?")[0] || `#/c/${store.getState().ch}/inbox`}?t=${encodeURIComponent(id)}`)
      }
      onOpenSession={(name) =>
        go(
          `${location.hash.split("?")[0] || `#/c/${store.getState().ch}/team`}?s=${encodeURIComponent(name)}`,
        )
      }
      store={store}
    />
  ),
  team: () => (
    <Team
      onCompose={(o) => openCompose(o)}
      onOlder={() => {
        void store.olderTimeline().then((n) => {
          if (n) paint();
        });
      }}
    />
  ),
  work: () => {
    const s = store.getState();
    const ch = s.ch ?? "";
    const base = location.hash.split("?")[0] || `#/c/${ch}/work`;
    return (
      <Work
        ch={ch}
        view={routeOf().sub[0] as ViewId | undefined}
        sub={routeOf().sub}
        repoViews={s.info?.views ?? []}
        repoPath={typeof s.info?.config?.repo === "string" ? s.info.config.repo : undefined}
        board={s.board}
        byId={s.byId}
        sessions={s.sessions}
        attention={s.attention}
        orchestrator={typeof s.info?.config?.orchestrator === "string" ? s.info.config.orchestrator : null}
        now={Date.now()}
        api={api}
        toast={(text, o) => toastFn(text, o)}
        store={localStorage}
        activeTaskId={routeOf().task}
        onOpenTask={(id) => go(`${base}?t=${encodeURIComponent(id)}`)}
        onOpenSession={(name) => go(`#/c/${ch}/team?s=${encodeURIComponent(name)}`)}
        onCompose={(opts) =>
          openCompose({ mode: "task", ...(opts.phase !== undefined ? { phase: opts.phase } : {}) })
        }
        onNavigate={(v) => go(`#/c/${ch}/work/${v}`)}
        reloadBoard={() => store.loadBoard().catch(() => {})}
        touchAttention={() => store.attChanged()}
      />
    );
  },
  knowledge: () => {
    const id = routeOf().sub[0];
    return <Knowledge id={id ? Number(id) : undefined} store={store} />;
  },
  settings: () => (
    <Settings notify={{ on: () => live.notifyOn(), toggle: () => live.toggleNotify() }} store={store} />
  ),
};

function paintSignedOut(): void {
  if (signedOutPainted) return;
  signedOutPainted = true;
  live.disconnect();
  paint();
}

function page(): ComponentChildren {
  if (signedOutPainted) return <SignedOut />;
  if (failedCh && parseHash(location.hash, (k, fb) => readPref(localStorage, k, fb)).ch === failedCh)
    return <NoChannel ch={failedCh} />;
  const s = store.getState();
  const base = pathOf(location.hash);
  return (
    <>
      <App
        pages={pages}
        onCompose={(prefill) => openCompose(prefill)}
        onPalette={openPalette}
        onHelp={openHelp}
        loadChannels={() => void store.loadChannels()}
      />
      <CmdPalette
        open={palette.open}
        onClose={closePalette}
        onCompose={(prefill) => openCompose(prefill)}
        onHelp={openHelp}
        notify={{ on: () => live.notifyOn(), toggle: () => live.toggleNotify() }}
        store={store}
      />
      <HelpDialog open={help.open} onClose={closeHelp} />
      <CmdKeys
        paletteOpen={palette.open}
        openPalette={openPalette}
        closePalette={closePalette}
        openHelp={openHelp}
        store={store}
      />
      {/* the task drawer rides every destination: the router's ?t=<id> opens it (app.js openTask) */}
      <TaskDrawer
        id={routeOf().task}
        ch={s.ch}
        api={api}
        now={Date.now()}
        board={s.board}
        byId={s.byId}
        sessions={s.sessions}
        views={s.info?.views ?? []}
        toast={(text, o) => toastFn(text, o)}
        copy={createCopy((text, o) => toastFn(text, o))}
        store={localStorage}
        live={store}
        onClose={() => go(base)}
        onOpenTask={(id) => go(`${base}?t=${encodeURIComponent(id)}`)}
        onOpenSession={(name) => go(`#/c/${s.ch ?? ""}/team?s=${encodeURIComponent(name)}`)}
        reloadBoard={() => store.loadBoard().catch(() => {})}
        touchAttention={() => store.attChanged()}
      />
      {/* the session drawer rides beside it: the router's ?s=<name> opens it, and a task in the
          same address wins (the shell lets the task drawer win over the session drawer) */}
      <SessionDrawer
        name={routeOf().task ? null : routeOf().sess}
        ch={s.ch}
        api={api}
        now={Date.now()}
        sessions={s.sessions}
        board={s.board}
        byId={(id) => s.byId.get(id)}
        timeline={s.timeline}
        replies={s.replies}
        costOf={(n) => (s.extras?.ch === s.ch ? s.extras?.obs?.cost?.[n] : undefined)}
        toast={(text, o) => toastFn(text, o)}
        onSent={onComposeSent}
        onOpenTask={(id) => go(`${base}?t=${encodeURIComponent(id)}`)}
        onClose={() => go(base)}
      />
      <ComposeDialog
        open={compose.open}
        onClose={closeCompose}
        options={compose.options}
        ch={s.ch ?? ""}
        sessions={s.sessions?.sessions ?? []}
        board={s.board}
        byId={(id) => s.byId.get(id)}
        api={api}
        onSent={onComposeSent}
        toast={(text, o) => toastFn(text, o)}
        timeline={s.timeline}
      />
    </>
  );
}

function paint(): void {
  const value: HuddleContextValue = {
    state: store.getState(),
    api,
    now: Date.now(),
    updatedAt,
    go,
    act,
    toast: (text, o) => toastFn(text, o),
    copy: createCopy((text, o) => toastFn(text, o)),
  };
  render(
    <ToastProvider>
      <ToastBridge />
      <HuddleProvider value={value}>{page()}</HuddleProvider>
    </ToastProvider>,
    root,
  );
}

// every store change moves the rail footer's "updated Xs ago"; the 15 s repaint tick does not
let updatedAt = Date.now();
store.subscribe(() => {
  updatedAt = Date.now();
  paint();
});
window.addEventListener("hashchange", () => {
  void syncChannel();
  paint();
});
setInterval(paint, 15_000); // relative times stay live (app.js's 15 s tick)

void syncChannel().finally(paint);
