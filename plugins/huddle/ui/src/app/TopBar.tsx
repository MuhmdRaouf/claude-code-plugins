// TopBar.tsx — the glass bar over the neon line: the brand on the left (the huddle mark, the
// glowing word, the version) beside the open channel's name and its online count, and the
// controls on the right — the palette key, the live pill, the inbox bell with its needs-you
// count, the theme menu and the shortcuts key. Below lg the hamburger slides the rail in.

import { type MenuItem, PopMenu } from "@muhmdraouf/ui/menu.tsx";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon, Logo } from "../icons.tsx";
import type { LiveStatus } from "../store.ts";
import { applyTheme, currentTheme, setTheme, THEMES, type ThemePref } from "./theme.ts";

/** Reads the server's version once for the brand's badge; "0.0.1" stands in until /health answers. */
export function useVersion(): string {
  const [v, setV] = useState("0.0.1");
  useEffect(() => {
    let on = true;
    fetch("/health")
      .then((r) => r.json())
      .then((h: { version?: string }) => {
        if (on && h.version) setV(h.version);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  return v;
}

/** The brand: the huddle mark at 40px with a primary bloom, the glowing word, the version. */
export function Brand(): JSX.Element {
  const v = useVersion();
  return (
    <a class="flex min-w-0 shrink-0 items-center gap-3" href="#/" aria-label="Huddle: all channels">
      <Logo class="size-10 shrink-0 drop-shadow-[0_0_0.75rem_var(--glow-primary)]" />
      <span class="neon-text text-xl font-semibold">Huddle</span>
      <span class="badge badge-ghost badge-sm tnum max-sm:hidden">{`v${v}`}</span>
    </a>
  );
}

/** The open channel's word beside the brand: its name and how many sessions are online. */
export function ChannelWord({ name, count }: { name: string | null; count: number }): JSX.Element | null {
  if (name === null) return null;
  return (
    <span class="flex min-w-0 items-center gap-2 text-sm text-base-content/60" data-channel-word="">
      <span class="truncate">{name}</span>
      <span class="num badge badge-ghost badge-sm shrink-0" title="Sessions online in this channel">
        {count}
      </span>
    </span>
  );
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
    <span id="ldot" class={`shrink-0 ${cls}`} role="img" aria-label={t} title={t}>
      <span class={dot} aria-hidden="true" />
      <span class="max-md:hidden">{word}</span>
    </span>
  );
}

/** The inbox bell: an error-coloured count while anything needs the owner, one click to the Inbox. */
export function InboxBell({
  n,
  href,
  onNavigate,
}: {
  n: number;
  href: string;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  return (
    <a
      href={href}
      class="btn btn-ghost btn-square shrink-0"
      aria-label={n > 0 ? `Inbox, ${n} need${n === 1 ? "" : "s"} you` : "Inbox"}
      title="Inbox"
      onClick={() => onNavigate?.()}
    >
      <span class="indicator">
        {n > 0 && <span class="indicator-item badge badge-error badge-sm tnum">{n}</span>}
        <Icon name="bell" class="size-4.5" />
      </span>
    </a>
  );
}

/** The theme menu: the current palette's icon on the button, the three choices under it. */
export function ThemeMenu(): JSX.Element {
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

  const row = THEMES.find((x) => x[0] === theme) ?? THEMES[0];
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
        class="btn btn-ghost btn-square btn-sm shrink-0"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={`Theme: ${row?.[1] ?? "System"}`}
        title={`Theme: ${row?.[1] ?? "System"}`}
        onClick={() => setOpen(true)}
      >
        <Icon name={row?.[2] ?? "monitor"} />
      </button>
      {open && btn ? <PopMenu anchor={btn} items={items} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The whole top bar: the hamburger below lg, brand, channel word, controls, and the neon line. */
export function TopBar({
  channel,
  online,
  live,
  inbox,
  inboxHref,
  onPalette,
  onHelp,
  onNavigate,
}: {
  /** The open channel's name, null on the channels page. */
  channel: string | null;
  /** How many sessions are online in it (the count beside the name). */
  online: number;
  live: LiveStatus;
  /** How many inbox items need the owner (the bell's badge). */
  inbox: number;
  inboxHref: string;
  onPalette?: (() => void) | undefined;
  onHelp?: (() => void) | undefined;
  /** Runs after a link navigates, so the mobile drawer closes with it. */
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  return (
    <header data-scope-header class="glass sticky top-0 z-30 rounded-none">
      <div class="navbar h-16 min-h-16 gap-3 px-4 max-sm:px-3 sm:px-6">
        <div class="navbar-start w-auto min-w-0 flex-1 gap-2 px-0">
          <label
            for="rail-drawer"
            aria-label="Open the channel rail"
            class="btn btn-ghost btn-square shrink-0 lg:hidden"
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
          <Brand />
          <ChannelWord name={channel} count={online} />
        </div>
        <div class="navbar-end w-auto shrink-0 gap-1 px-0">
          <button
            type="button"
            id="palbtn"
            class="btn btn-ghost btn-square btn-sm shrink-0"
            aria-label="Search or run a command"
            aria-keyshortcuts="Meta+K Control+K"
            title="Search or run a command (⌘K)"
            onClick={() => onPalette?.()}
          >
            <Icon name="search" class="size-4.5" />
          </button>
          <LivePill live={live} />
          <InboxBell n={inbox} href={inboxHref} onNavigate={onNavigate} />
          <ThemeMenu />
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm shrink-0"
            aria-label="Keyboard shortcuts"
            aria-keyshortcuts="?"
            title="Keyboard shortcuts (?)"
            onClick={() => onHelp?.()}
          >
            <span class="text-base">?</span>
          </button>
        </div>
      </div>
      <div class="neon-line" aria-hidden="true" />
    </header>
  );
}
