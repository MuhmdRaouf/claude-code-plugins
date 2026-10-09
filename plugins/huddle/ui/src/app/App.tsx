// App.tsx — the shell: a full-height rail on the left (the logo and channel switcher on top, the
// destinations with their counts as a daisyUI menu, the members with their live dots below, the
// theme, help and version at the bottom), a daisyUI drawer that carries the same rail below the
// lg breakpoint, and the main area: the shell paints every destination's PageIntro (icon, title,
// one plain sentence on what the page shows, and the page's own actions) over the page the
// `pages` registry names, whose content starts directly with its panels.

import { type MenuItem, PopMenu } from "@muhmdraouf/ui/menu.tsx";
import { PageIntro, Panel } from "@muhmdraouf/ui/page.tsx";
import type { Stamp } from "@muhmdraouf/ui/time.ts";
import type { ComponentChildren, ComponentType, JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ComposeOptions } from "../compose/drafts.ts";
import { Icon, type IconName, Logo } from "../icons.tsx";
import { Avatar, Time } from "../kit.tsx";
import { FIN, SSTM, STATM, sessionStatus, type Task, taskState } from "../status.ts";
import { readPref, writePref } from "../storage.ts";
import type { HuddleState, LiveStatus, PlanStep } from "../store.ts";
import { useHuddle } from "./context.tsx";
import { IntroCtx } from "./intro.tsx";
import { channelHref, DESTS, type Dest, parseHash, pathOf, sessHref } from "./router.ts";
import { applyTheme, currentTheme, setTheme, THEMES, type ThemePref } from "./theme.ts";

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

/** A board step as the status model reads it (status.ts's Task); an unnamed status counts as open. */
const asTask = (s: PlanStep): Task => ({
  status: s.status ?? "todo",
  ...(s.blocked_by ? { blocked_by: s.blocked_by } : {}),
});

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

/** Is this session the channel's orchestrator? */
const isOrch = (name: string, state: HuddleState): boolean =>
  !!name && state.info?.config?.orchestrator === name;

/** The counts the rail labels read: the Inbox badge, the online sessions, the open tasks. */
export type NavCounts = { n: number; sessions: number; open: number };

/** The screen-reader tail of a rail entry: how much waits there. */
function srLine(k: string, c: NavCounts): string {
  if (k === "inbox") return c.n ? `, ${c.n} need${c.n === 1 ? "s" : ""} you` : ", all clear";
  if (k === "team") return `, ${c.sessions} online`;
  if (k === "work") return `, ${c.open} open tasks`;
  return "";
}

/** The right-aligned count of a rail entry; a zero draws nothing. */
function countBadge(k: string, c: NavCounts): JSX.Element | null {
  if (k === "inbox")
    return c.n ? (
      <span class="badge badge-error badge-sm ml-auto" aria-hidden="true">
        {c.n}
      </span>
    ) : null;
  if (k === "team")
    return c.sessions ? (
      <span class="tnum muted ml-auto text-xs" aria-hidden="true">
        {c.sessions}
      </span>
    ) : null;
  if (k === "work")
    return c.open ? (
      <span class="tnum muted ml-auto text-xs" aria-hidden="true">
        {c.open}
      </span>
    ) : null;
  return null;
}

/** The live pill: a daisyUI badge with a status dot — pulsing green when live, amber while
 *  reconnecting, quiet while connecting. */
export function LivePill({ live }: { live: LiveStatus }): JSX.Element {
  const t =
    live === "live"
      ? "Live updates: on"
      : live === "offline"
        ? "Live updates: reconnecting"
        : "Live updates: connecting";
  const word = live === "live" ? "Live" : live === "offline" ? "Reconnecting" : "Connecting…";
  const cls =
    live === "live"
      ? "badge badge-soft badge-success gap-1.5"
      : live === "offline"
        ? "badge badge-soft badge-warning gap-1.5"
        : "badge badge-ghost gap-1.5";
  const dot =
    live === "live"
      ? "status status-success animate-pulse"
      : live === "offline"
        ? "status status-warning"
        : "status status-neutral";
  return (
    <span id="ldot" class={cls} role="img" aria-label={t} title={t}>
      <span class={dot} aria-hidden="true" />
      <span>{word}</span>
    </span>
  );
}

/** One segmented bar: done · doing · waiting · blocked · to do; a zero never draws. The label
 *  goes into the accessible name when it is wanted. */
export function ProgressBar({
  steps,
  label = true,
}: {
  steps: readonly PlanStep[];
  label?: boolean;
}): JSX.Element {
  const total = steps.length || 1;
  const n = (k: "done" | "doing" | "waiting" | "blocked"): number =>
    steps.filter((s) =>
      k === "done" ? s.status !== undefined && FIN.has(s.status) : taskState(asTask(s)) === k,
    ).length;
  const seg = (
    [
      ["done", "c-good"],
      ["doing", "c-yellow"],
      ["waiting", "c-peach"],
      ["blocked", "c-red"],
    ] as const
  )
    .map(([k, cl]) => ({ k, cl, n: n(k) }))
    .filter((x) => x.n > 0);
  const txt = `${seg
    .map((x) => `${x.n} ${x.k === "done" ? "done" : STATM[x.k].l.toLowerCase()}`)
    .join(", ")}, ${steps.length} in all`;
  return (
    <div class="segbar" role="img" aria-label={`${label ? "Progress: " : ""}${txt}`} title={txt}>
      {seg.map((x) => (
        <i key={x.k} class={`segbar-seg ${x.cl}`} style={`width:${((x.n / total) * 100).toFixed(3)}%`} />
      ))}
    </div>
  );
}

/** The member dot's daisyUI status colour: the session's derived status. Working glows. */
function dotClass(status: string): string {
  if (status === "working") return "status status-success neon-dot";
  if (status === "waiting") return "status status-warning";
  if (status === "blocked") return "status status-error";
  if (status === "paused") return "status status-secondary";
  return "status status-neutral";
}

/** The channel switcher: the channel's name on a button, the other channels and Home under it. */
function ChannelSwitcher(): JSX.Element {
  const { state, go } = useHuddle();
  const [open, setOpen] = useState(false);
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const chname = state.info?.config?.title || state.ch || "";
  const chans = (state.channels ?? []).filter((c) => c.name !== state.ch);
  const items: MenuItem[] = [
    ...chans.map((c) => ({
      label: c.title || c.name,
      icon: <Icon name="hash" />,
      run: () => go(channelHref(c.name)),
    })),
    { label: "All channels", icon: <Icon name="layers" />, run: () => go("#/") },
  ];
  return (
    <span id="chbox" class="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        ref={setBtn}
        id="chbtn"
        class="btn btn-ghost h-8 min-w-0 max-w-[44vw] gap-1.5 px-2 font-semibold sm:max-w-44"
        aria-haspopup="menu"
        aria-expanded="false"
        onClick={() => setOpen(true)}
      >
        <span class="truncate">{chname}</span>
        <svg
          class="muted size-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && btn ? <PopMenu anchor={btn} items={items} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

/** The theme menu's button and pop-up (the rail's bottom row and the mobile bar share it). */
function ThemeMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const [theme, setThemeState] = useState<ThemePref>(() => currentTheme(localStorage));

  // the palette choice goes on <html> right away, the way index.html's inline script did at boot
  useEffect(() => {
    applyTheme(currentTheme(localStorage), window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);

  // the palette follows the system while "System" is the choice
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (): void => {
      if (currentTheme(localStorage) === "system") applyTheme("system", mq.matches);
    };
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const pick = (t: ThemePref): void => {
    setTheme(localStorage, t, window.matchMedia("(prefers-color-scheme: dark)").matches);
    setThemeState(t);
  };

  const row = THEMES.find((x) => x[0] === theme) ?? (["system", "System", "monitor"] as const);
  const items: MenuItem[] = THEMES.map(([k, l, ic]) => ({
    label: l,
    icon: <Icon name={ic} />,
    checked: theme === k,
    run: () => pick(k),
  }));
  return (
    <>
      <button
        type="button"
        ref={setBtn}
        id="theme"
        class="btn btn-ghost btn-square btn-sm"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={`Theme: ${row[1]}`}
        title={`Theme: ${row[1]}`}
        onClick={() => setOpen(true)}
      >
        <Icon name={row[2]} />
      </button>
      {open && btn ? <PopMenu anchor={btn} items={items} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The rail: the channel switcher and live pill on top, the destinations as a daisyUI menu, the
 *  members with their live dots, and the plan's progress plus the theme row at the bottom. */
function Rail({
  dest,
  c,
  onCompose,
  onNavigate,
  onPalette,
  onHelp,
}: {
  dest: Dest;
  c: NavCounts;
  onCompose?: ComposeOpen | undefined;
  onNavigate?: (() => void) | undefined;
  onPalette?: (() => void) | undefined;
  onHelp?: (() => void) | undefined;
}): JSX.Element {
  const { state } = useHuddle();
  const ch = state.ch;
  const steps = state.board?.steps ?? [];
  const done = steps.filter((s) => s.status !== undefined && FIN.has(s.status)).length;
  const tops = (state.sessions?.sessions ?? []).filter((s) => s.state !== "left" && !s.parent);
  const p = pathOf(location.hash);
  const byId = (id: string): Task | null => {
    const s = state.byId.get(id);
    return s ? asTask(s) : null;
  };
  const close = (): void => onNavigate?.();
  const link = (href: string, current: boolean, children: ComponentChildren): JSX.Element => (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={close}
      class={current ? "aura aura-glow aura-sm menu-active neon-text text-primary" : undefined}
    >
      {children}
    </a>
  );
  return (
    <aside
      id="side"
      class="flex h-full min-h-0 w-80 shrink-0 flex-col gap-4 overflow-y-auto bg-base-200 p-4"
      aria-label="Channel"
    >
      <div class="flex items-center gap-2 px-1">
        <button
          type="button"
          class="btn btn-primary flex-1"
          onClick={() => {
            close();
            onCompose?.();
          }}
          disabled={!onCompose}
        >
          <Icon name="msg" class="size-4" />
          New message
          <kbd class="kbd kbd-sm ml-1">C</kbd>
        </button>
        <button
          type="button"
          id="palbtn"
          class="btn btn-ghost btn-square btn-sm"
          aria-label="Search or run a command"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={() => onPalette?.()}
        >
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>
      </div>
      <nav aria-label="Destinations">
        <ul class="menu menu-lg w-full gap-0.5 p-0">
          {link(
            channelHref(ch ?? "", "/overview"),
            dest === "overview",
            <>
              <Icon name="columns" />
              Overview
              <span class="sr-only">: the channel at a glance</span>
            </>,
          )}
          {link(
            channelHref(ch ?? "", "/today"),
            dest === "today",
            <>
              <Icon name="clock" />
              Today
              <span class="sr-only">: what got done, per session</span>
            </>,
          )}
          {DESTS.map(([k, l, ic]) =>
            link(
              channelHref(ch ?? "", `/${k}`),
              dest === k,
              <>
                <span class={k === "inbox" && c.n ? "text-error" : ""}>
                  <Icon name={ic} />
                </span>
                {l}
                <span class="sr-only">{srLine(k, c)}</span>
                {countBadge(k, c)}
              </>,
            ),
          )}
        </ul>
      </nav>
      {tops.length ? (
        <section aria-labelledby="sb-team" class="min-h-0">
          <h2 id="sb-team" class="menu-title px-1 pt-0">
            Members
          </h2>
          <ul class="list w-full text-sm" aria-label="Members in the channel">
            {tops.map((s) => {
              const st = sessionStatus(s, byId);
              const m = SSTM[st];
              return (
                <li key={s.name}>
                  <a
                    class="list-row items-center gap-2.5 py-1.5"
                    href={sessHref(ch ?? "", p, s.name)}
                    title={m.l}
                    onClick={close}
                  >
                    <Avatar name={s.name} />
                    <span class="min-w-0 flex-1 truncate text-base">{s.name}</span>
                    <span class={`${dotClass(st)} shrink-0`} aria-hidden="true" />
                    <span class="sr-only">: {m.l}</span>
                    {isOrch(s.name, state) ? (
                      <span class="muted shrink-0" title="Orchestrator">
                        <Icon name="baton" class="size-3.5" />
                        <span class="sr-only">, orchestrator</span>
                      </span>
                    ) : null}
                    {s.holds_turn ? (
                      <span class="muted shrink-0" title="Holds the turn">
                        <Icon name="turn" class="size-3.5" />
                        <span class="sr-only">, holds the turn</span>
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <div class="mt-auto flex flex-col gap-3">
        {steps.length ? (
          <section class="flex flex-col gap-1.5 px-1" aria-label="Progress">
            <ProgressBar steps={steps} />
            <span class="hint tnum">
              {done} of {steps.length} tasks done
            </span>
          </section>
        ) : null}
        <div class="flex items-center gap-1 border-t hairline pt-2">
          <a
            class="btn btn-ghost btn-square btn-sm"
            href={channelHref(ch ?? "", "/settings")}
            aria-label="Settings"
            aria-current={dest === "settings" ? "page" : undefined}
            onClick={close}
          >
            <Icon name="sliders" />
          </a>
          <button
            type="button"
            id="help"
            class="btn btn-ghost btn-square btn-sm max-lg:hidden"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            onClick={() => onHelp?.()}
          >
            <svg
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 17h8M10 13h4" />
            </svg>
          </button>
          <span class="flex-1" />
          <VersionChip />
        </div>
      </div>
    </aside>
  );
}

/** Reads the server's version once for the rail's chip; "v0.0.1" stands in until it answers. */
function VersionChip(): JSX.Element {
  const [v, setV] = useState("v0.0.1");
  useEffect(() => {
    let on = true;
    fetch("/health")
      .then((r) => r.json())
      .then((h: { version?: string }) => {
        if (on && h.version) setV(`v${h.version}`);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  return (
    <span class="badge badge-ghost badge-sm tnum" id="ver">
      {v}
    </span>
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

/** The page this browser gets when its sign-in has ended: how to get a new link, two copyable
 *  commands, the server's version. */
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
              Get a new sign-in link from any session in this huddle, then open it here.
            </p>
            <CmdField id="so-c" label="In a Claude session" cmd="/huddle:open" />
            <CmdField id="so-t" label="Or in a terminal" cmd="huddle open" />
            <CopyButton
              text="/huddle:open"
              done="Copied: paste it into a Claude session"
              class="btn btn-primary h-10 w-full text-sm"
            >
              <Icon name="copy" />
              Copy /huddle:open
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

/** The shell over the current hash: the rail (as a drawer below lg), the mobile bar, and the
 *  destination's page. `onCompose` opens the composer from the rail's button and the C key,
 *  `onPalette` the command palette from the rail's search and ⌘K, `onHelp` the shortcuts. */
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
  const online = (state.sessions?.sessions ?? []).filter((s) => s.state !== "left").length;
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
      <div class="drawer-content flex h-dvh min-h-0 flex-col bg-base-300">
        {/* the top bar: brand, switcher, live pill, palette, theme, shortcuts — the rail keeps the destinations */}
        <header class="navbar glass sticky top-0 z-30 h-16 shrink-0 rounded-none px-6">
          <label
            for="rail-drawer"
            class="btn btn-ghost btn-square lg:hidden"
            aria-label="Open the channel rail"
          >
            <svg
              class="size-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </label>
          <a class="flex shrink-0 items-center gap-2" href="#/" aria-label="Huddle: all channels">
            <Logo class="logo-glow size-10 shrink-0" />
            <span class="text-xl font-semibold neon-text">Huddle</span>
          </a>
          <ChannelSwitcher />
          <span class="flex-1" />
          <LivePill live={state.live} />
          <ThemeMenu />
        </header>
        <div class="neon-line shrink-0" aria-hidden="true" />
        {main}
      </div>
      <div class="drawer-side z-40">
        <label for="rail-drawer" aria-label="Close the channel rail" class="drawer-overlay" />
        <Rail
          dest={route.dest}
          c={counts}
          onCompose={onCompose}
          onNavigate={() => setRailOpen(false)}
          onPalette={onPalette}
          onHelp={onHelp}
        />
      </div>
    </div>
  );
}
