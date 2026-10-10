// App.tsx — the shell: the glass top bar over the neon line (TopBar), the grouped destination
// tabs, the channel rail beside the page (Rail; a drawer below lg), and every destination's
// PageIntro (icon, title, one plain sentence on what the page shows, and the page's own actions)
// over the page the `pages` registry names, whose content starts directly with its panels. The
// signed-out and no-channel pages stand alone.

import { PageIntro, Panel } from "@muhmdraouf/ui/page.tsx";
import type { Stamp } from "@muhmdraouf/ui/time.ts";
import type { ComponentChildren, ComponentType, JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ComposeOptions } from "../compose/drafts.ts";
import { Icon, type IconName, Logo } from "../icons.tsx";
import { Time } from "../kit.tsx";
import { FIN } from "../status.ts";
import { readPref, writePref } from "../storage.ts";
import type { HuddleState } from "../store.ts";
import { useHuddle } from "./context.tsx";
import { IntroCtx } from "./intro.tsx";
import { Rail } from "./Rail.tsx";
import { channelHref, type Dest, parseHash } from "./router.ts";
import { TopBar } from "./TopBar.tsx";

/** What a page registry holds: one component per destination, picked by name. */
export type Pages = Record<string, ComponentType>;

/** What the composer needs from the shell: open it, with a prefill when the caller has one. */
export type ComposeOpen = (prefill?: ComposeOptions) => void;

/** The label a destination shows when its page is missing (Home's is the channels page itself). */
const LABELS: Record<Dest, string> = {
  home: "Channels",
  overview: "Overview",
  today: "Today",
  inbox: "Inbox",
  team: "Team",
  work: "Work",
  knowledge: "Knowledge",
  settings: "Settings",
};

/** What each destination shows and does there: the intro the shell paints above every page, so
 *  a page starts with its panels and never paints a title of its own. */
const DEST_INTRO: Record<Dest, { icon: IconName; label: string; description: ComponentChildren }> = {
  home: {
    icon: "layers",
    label: "Channels",
    description: "Each channel is one team of sessions. The ones that need you come first.",
  },
  overview: {
    icon: "activity",
    label: "Overview",
    description: "The channel at a glance: the plan, the team and what needs you.",
  },
  today: {
    icon: "clock",
    label: "Today",
    description: "What each session got done, what is stuck and what still waits for an answer.",
  },
  inbox: {
    icon: "inbox",
    label: "Inbox",
    description:
      "Only what needs you: questions, approvals, paused sessions, blocked tasks and Radar's alerts. Answer or dismiss a card and it leaves the list.",
  },
  team: {
    icon: "users",
    label: "Team",
    description: "Who is in, what each is doing, and everything that happened.",
  },
  work: {
    icon: "list",
    label: "Work",
    description:
      "Every task the plan carries, as a list, board, graph or map. Filter them, change a status, or open a task to work it.",
  },
  knowledge: {
    icon: "book",
    label: "Knowledge",
    description: "What the sessions learned and shared, so nobody pays for it twice.",
  },
  settings: {
    icon: "sliders",
    label: "Settings",
    description:
      "The channel's identity, turn and repo, and how this browser hears that a session needs you.",
  },
};

/** The three tab groups under the top bar: the channel's pages, the work pages, and the system's.
 *  Radar's NAV_GROUPS, with Huddle's destinations. */
const NAV_GROUPS: { label: string; tabs: Exclude<Dest, "home">[] }[] = [
  { label: "Channel", tabs: ["overview", "today", "inbox", "team"] },
  { label: "Work", tabs: ["work", "knowledge"] },
  { label: "System", tabs: ["settings"] },
];

/** The Inbox badge over the paint's snapshot: the attention items plus the extras' needs — the
 *  same count the store's inboxCount() computes, read here from state alone. */
export function inboxOf(state: HuddleState): number {
  const a = state.attention;
  const att = a
    ? (a.asks?.length ?? 0) + (a.gates?.length ?? 0) + (a.paused?.length ?? 0) + (a.blocked?.length ?? 0)
    : 0;
  const x = state.extras;
  const needs = x && x.ch === state.ch ? x.approvals.length + (x.obs?.alerts?.length ?? 0) : 0;
  return att + needs;
}

/** The counts the tabs read: the Inbox needs-you badge, the online sessions, the open tasks. */
export type NavCounts = { n: number; sessions: number; open: number };

/** The count a tab carries: the Inbox's needs-you in error red, the Team's online sessions and
 *  Work's open tasks in quiet grey; zero draws nothing. */
function tabBadge(dest: Exclude<Dest, "home">, c: NavCounts): JSX.Element | null {
  if (dest === "inbox") return c.n > 0 ? <span class="badge badge-error badge-sm tnum">{c.n}</span> : null;
  const n = dest === "team" ? c.sessions : dest === "work" ? c.open : 0;
  return n > 0 ? <span class="num badge badge-ghost badge-sm">{n}</span> : null;
}

/** One tab: its icon, its label, the counts that follow it (the inbox needs-you badge, the team's
 *  online sessions, the work open tasks), and the active tab's glow. */
function ViewTab({
  dest,
  counts,
  active,
  onNavigate,
}: {
  dest: Exclude<Dest, "home">;
  counts: NavCounts;
  active: boolean;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  const { state, go } = useHuddle();
  const ch = state.ch ?? "";
  const meta = DEST_INTRO[dest];
  return (
    <button
      type="button"
      role="tab"
      data-dest={dest}
      class={
        active ? "tab tab-active h-10 gap-2 px-4 text-[0.9375rem]" : "tab h-10 gap-2 px-4 text-[0.9375rem]"
      }
      aria-selected={active ? "true" : "false"}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        go(channelHref(ch, `/${dest}`));
        onNavigate?.();
      }}
    >
      <Icon name={meta.icon} class="size-4.5" />
      <span>{meta.label}</span>
      {tabBadge(dest, counts)}
    </button>
  );
}

/** The rows of tab groups under the top bar: three daisyUI tabs boxes with a gap, the active tab
 *  glowing. The ids are the destinations, the address moves by hash. */
function ViewTabs({
  dest,
  counts,
  onNavigate,
}: {
  dest: Dest;
  counts: NavCounts;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  return (
    <div class="flex w-full flex-wrap gap-3 px-4 pt-4 sm:px-6" data-view-tabs="">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} role="tablist" aria-label={group.label} class="tabs tabs-box">
          {group.tabs.map((k) => (
            <ViewTab key={k} dest={k} counts={counts} active={dest === k} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The placeholder for a destination no page is registered for yet. */
export function ComingSoon({ label }: { label: string }): JSX.Element {
  return (
    <div class="mx-auto max-w-3xl py-6">
      <div class="flex flex-col items-center gap-2 rounded-box border border-dashed border-base-content/20 px-6 py-10 text-center text-sm muted">
        <b class="text-base font-semibold text-base-content">{label}</b>
        <p>Coming soon.</p>
      </div>
    </div>
  );
}

/** The channel the address names does not exist. */
export function NoChannel({ ch }: { ch: string }): JSX.Element {
  return (
    <div class="mx-auto flex max-w-lg flex-col items-center gap-2 rounded-box border border-dashed border-base-content/20 px-6 py-20 text-center text-sm muted">
      <Icon name="hash" class="size-8" />
      <h1 class="text-xl font-semibold tracking-tight text-base-content">No channel “{ch}”</h1>
      <p>
        A session's first <code>join</code> creates a channel, or you can create one on the{" "}
        <a class="link link-primary" href="#/">
          channels page
        </a>
        .
      </p>
    </div>
  );
}

/** A read-only command with a copy button at the end. */
function CmdField({ id, label, cmd }: { id: string; label: string; cmd: string }): JSX.Element {
  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium" id={`${id}-l`}>
        {label}
      </span>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the cmd field's labelled box */}
      <div
        class="flex h-10 items-center gap-2.5 rounded-lg border border-base-content/15 bg-base-200 pr-1 pl-3"
        aria-labelledby={`${id}-l`}
      >
        <span class="muted">
          <Icon name="terminal" />
        </span>
        <code class="min-w-0 flex-1 truncate text-sm">{cmd}</code>
        <CopyButton text={cmd} done="" ariaLabel={`Copy ${cmd}`} />
      </div>
    </div>
  );
}

/** A copy button that flashes a check and a word for a moment when the copy landed. */
function CopyButton({
  text,
  done,
  ariaLabel,
  class: c = "btn btn-ghost btn-square btn-sm muted",
  children,
}: {
  text: string;
  done: string;
  ariaLabel?: string | undefined;
  class?: string | undefined;
  children?: ComponentChildren;
}): JSX.Element {
  const [hit, setHit] = useState(false);
  useEffect(() => {
    if (!hit) return;
    const t = setTimeout(() => setHit(false), 1600);
    return () => clearTimeout(t);
  }, [hit]);
  const copy = (): void => {
    navigator.clipboard?.writeText(text).then(
      () => setHit(true),
      () => {},
    );
  };
  return (
    <button type="button" class={c} aria-label={ariaLabel} onClick={copy}>
      {hit ? (
        <>
          <Icon name="check" />
          {done}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** The page this browser gets when its sign-in has ended: how to get a new link — /huddle:setup
 *  in a Claude session, or `huddle open` in a terminal — and the server's version. */
export function SignedOut(): JSX.Element {
  const [ver, setVer] = useState("Huddle");
  useEffect(() => {
    document.title = "Huddle: signed out";
    fetch("/health")
      .then((r) => r.json())
      .then((h: { version?: string }) => {
        if (h.version) setVer(`Huddle v${h.version}`);
      })
      .catch(() => {});
  }, []);
  return (
    <main class="grid min-h-dvh place-items-center bg-base-200 p-4">
      <div class="flex w-full max-w-md flex-col gap-8">
        <div class="flex flex-col items-center gap-3 text-center">
          <Logo />
          <h1 class="text-3xl font-bold tracking-tight">Huddle</h1>
          <p class="text-[15px] muted">Sign in to see your channels and sessions</p>
        </div>
        <Panel class="w-full" label="How to sign back in">
          <div class="flex flex-col gap-5">
            <div class="alert alert-warning alert-soft text-sm" role="status">
              <span class="shrink-0">
                <Icon name="logout" />
              </span>
              <span>
                <b class="font-semibold" id="so-h">
                  Signed out.
                </b>{" "}
                <span class="muted">
                  This browser's sign-in ended: Huddle was set up again, its member was removed, or the link
                  expired.
                </span>
              </span>
            </div>
            <p class="text-sm muted">
              Run <code>/huddle:setup</code> in any session of this huddle — or <code>huddle open</code> in a
              terminal — for a new sign-in link, then open it here.
            </p>
            <CmdField id="so-c" label="In a Claude session" cmd="/huddle:setup" />
            <CmdField id="so-t" label="Or in a terminal" cmd="huddle open" />
            <CopyButton
              text="/huddle:setup"
              done="Copied: paste it into a Claude session"
              class="btn btn-primary h-10 w-full text-sm"
            >
              <Icon name="copy" />
              Copy /huddle:setup
            </CopyButton>
          </div>
        </Panel>
        <p class="muted text-center text-xs">{ver}</p>
      </div>
    </main>
  );
}

/** The C keyboard shortcut: opens the composer over the open channel, unless the keystroke was
 *  typing into a field or the focus sits inside a dialog. */
function useComposeKey(onCompose: ComposeOpen | undefined, ch: string | null): void {
  useEffect(() => {
    if (!onCompose || !ch) return;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one guard per way the keystroke must not compose
    const on = (e: KeyboardEvent): void => {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      onCompose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onCompose, ch]);
}

/** The sentence under a destination's title: Overview speaks with the channel's own words when
 *  it has them, Settings carries the channel's facts, the rest come straight from the table. */
function introDescription(dest: Dest, state: HuddleState, ch: string | null, now: number): ComponentChildren {
  if (dest === "overview") {
    const d = state.info?.config?.description;
    if (typeof d === "string" && d) return d;
    return DEST_INTRO.overview.description;
  }
  if (dest === "settings") {
    const c = (state.info?.config ?? {}) as { created_at?: Stamp | null };
    const st = (state.info?.stats ?? {}) as { events?: number; tasks?: number; knowledge?: number };
    return (
      <>
        Channel <code>{ch}</code>, created <Time ts={c.created_at ?? null} now={now} />. {st.events ?? 0}{" "}
        events, {st.tasks ?? 0} tasks, {st.knowledge ?? 0} knowledge entries.
      </>
    );
  }
  return DEST_INTRO[dest].description;
}

/** The shell over the current hash: the top bar, the grouped tabs, the rail (a drawer below lg)
 *  and the destination's page. `onCompose` opens the composer from the C key, `onPalette` the
 *  command palette from the bar's search key and ⌘K, `onHelp` the shortcuts. */
export function App({
  pages,
  onCompose,
  onPalette,
  onHelp,
  loadChannels,
}: {
  pages: Pages;
  onCompose?: ComposeOpen | undefined;
  onPalette?: (() => void) | undefined;
  onHelp?: (() => void) | undefined;
  /** Refills the channel list the switcher and the palette offer (the store's loadChannels). */
  loadChannels?: (() => void) | undefined;
}): JSX.Element {
  const { state, now } = useHuddle();
  const [hash, setHash] = useState(location.hash);
  const [railOpen, setRailOpen] = useState(false);
  // the page-wide controls the open page handed up, kept with the destination that named them
  const [introActs, setIntroActs] = useState<{ dest: Dest; render: () => ComponentChildren } | null>(null);

  // the shell follows the address bar
  useEffect(() => {
    const on = (): void => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const route = useMemo(() => parseHash(hash, (k, fb) => readPref(localStorage, k, fb)), [hash]);

  // an alias or an unknown destination rewrites the address to the canonical form
  useEffect(() => {
    if (route.replace) history.replaceState(null, "", route.replace);
  }, [route.replace]);

  // the preferences an alias carried land in this browser's settings before any view reads them
  useEffect(() => {
    for (const [k, v] of Object.entries(route.prefs)) writePref(localStorage, k, v);
  }, [route]);

  // C opens the composer, unless the keystroke was typing in a field or inside a dialog
  useComposeKey(onCompose, state.ch);

  // the channel list feeds the switcher and the palette: one read per page load, and again
  // whenever the open channel changes (a freshly created channel joins the list this way)
  useEffect(() => {
    loadChannels?.();
  }, [loadChannels, state.ch]);

  const n = inboxOf(state);
  const chname = state.info?.config?.title || state.ch;
  useEffect(() => {
    document.title = `${n ? `(${n}) ` : ""}${state.ch ? `${chname} · ` : ""}Huddle`;
  }, [n, chname, state.ch]);

  const steps = state.board?.steps ?? [];
  const roster = state.sessions?.sessions ?? [];
  const online = roster.filter((s) => s.state !== "left").length;
  const open = steps.filter((s) => !FIN.has(s.status ?? "todo")).length;
  const counts: NavCounts = { n, sessions: online, open };
  const ch = state.ch;

  const Page = pages[route.dest];
  const meta = DEST_INTRO[route.dest];

  // the hand pages register their page-wide controls through, tagged with the destination
  const takeIntro = useCallback(
    (render: () => ComponentChildren): void => {
      setIntroActs({ dest: route.dest, render });
    },
    [route.dest],
  );
  const introActions = introActs && introActs.dest === route.dest ? introActs.render() : null;

  const close = useCallback(() => setRailOpen(false), []);

  const body = Page ? <Page /> : route.dest === "home" ? null : <ComingSoon label={LABELS[route.dest]} />;
  const main = (
    <main id="main" tabindex={-1} class="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none">
      {body !== null || route.dest !== "home" ? (
        <div class="mx-auto flex w-full max-w-[1600px] min-w-0 flex-col px-4 py-6 sm:px-6 lg:px-8">
          <PageIntro
            icon={<Icon name={meta.icon} />}
            title={meta.label}
            description={introDescription(route.dest, state, ch, now)}
            actions={introActions}
          />
          <IntroCtx.Provider value={{ take: takeIntro }}>{body}</IntroCtx.Provider>
        </div>
      ) : null}
    </main>
  );

  // the channels page stands alone: no rail, no tabs
  if (!ch) {
    return <div class="flex h-dvh flex-col bg-base-300">{main}</div>;
  }

  return (
    <div class="drawer lg:drawer-open">
      <input
        id="rail-drawer"
        type="checkbox"
        class="drawer-toggle"
        checked={railOpen}
        onChange={(e) => setRailOpen(e.currentTarget.checked)}
      />
      <div class="drawer-content flex h-dvh min-h-0 flex-col">
        <TopBar
          channel={chname ?? null}
          online={online}
          live={state.live}
          inbox={n}
          inboxHref={channelHref(ch, "/inbox")}
          onPalette={onPalette}
          onHelp={onHelp}
          onNavigate={close}
        />
        <ViewTabs dest={route.dest} counts={counts} onNavigate={close} />
        {main}
      </div>
      <div class="drawer-side z-40">
        <label for="rail-drawer" aria-label="Close the channel rail" class="drawer-overlay" />
        <Rail onHelp={onHelp} onNavigate={close} />
      </div>
    </div>
  );
}
