/**
 * The dashboard's top bar, one daisyUI navbar under a neon line: the glowing brand on the left, the
 * selection bar in the middle (every session, or the picked ones as removable badges), and the range,
 * the live word, the alerts bell, the theme dropdown and the shortcuts key on the right. Below lg the
 * hamburger slides the sessions rail in.
 */

import { VERSION } from "../../shared/version.ts";
import { fmtNum } from "../fmt.ts";
import type { IconName } from "../icons.ts";
import { selectedIds, type ThemePref } from "../state.ts";
import { useApp } from "./context.ts";
import { Icon } from "./Icon.tsx";
import { TimeRange } from "./TimeRange.tsx";

/** The hamburger that opens the rail on screens the rail does not fit beside. `lg:hidden` is the only
 *  display word it carries — the utility layer beats every component's `display`, so the button stays
 *  hidden on wide screens whatever the btn classes ask for. */
function RailOpener() {
  return (
    <label for="radar-rail" aria-label="Open the sessions rail" class="btn btn-ghost btn-square lg:hidden">
      <Icon name="menu" class="size-4.5" />
    </label>
  );
}

/** The brand: the radar mark at 40px with a primary bloom, the glowing word, the version beside it. */
export function Brand() {
  return (
    <span class="flex min-w-0 items-center gap-3" data-brand="">
      <Icon
        name="logo"
        class="size-10 shrink-0 drop-shadow-[0_0_0.75rem_var(--glow-primary)]"
        label="Radar"
      />
      <span class="neon-text text-xl font-semibold">Radar</span>
      <span class="badge badge-ghost badge-sm max-sm:hidden">{`v${VERSION}`}</span>
    </span>
  );
}

/** How many sessions the reader could pick from: everything the store knows. */
function sessionCount(sessions: { id: string }[]): number {
  return sessions.length;
}

/** The bar's word while nothing is picked: the fleet, quietly, with its size. */
function AllSessionsWord({ count }: { count: number }) {
  return (
    <span class="flex min-w-0 items-center gap-2 text-sm text-base-content/60" data-selection-bar="">
      <span class="truncate">All sessions</span>
      <span class="num badge badge-ghost badge-sm shrink-0">{fmtNum(count)}</span>
    </span>
  );
}

/** The bar while sessions are picked: "Viewing", one badge per pick (first three, then +N), and Clear.
 *  A pick the session list has not seen yet still shows, named by its id. */
function PickedWords() {
  const { state, act } = useApp();
  const nameOf = (id: string): string => {
    const item = state.sessions.find((session) => session.id === id);
    return item === undefined ? id : (item.name ?? item.project ?? id);
  };
  const liveOf = (id: string): boolean => state.sessions.find((session) => session.id === id)?.live === true;
  const picks = selectedIds(state);
  const shown = picks.slice(0, 3);
  const rest = picks.slice(3);
  return (
    <span class="flex min-w-0 items-center gap-2" data-selection-bar="">
      <span class="hidden shrink-0 text-sm text-base-content/60 md:inline">Viewing</span>
      {shown.map((id) => {
        const name = nameOf(id);
        return (
          <span key={id} class="badge badge-soft badge-primary badge-lg min-w-0 max-w-56 gap-2" title={name}>
            <span
              class={`status shrink-0 ${liveOf(id) ? "status-success" : "status-neutral"}`}
              aria-hidden="true"
            />
            <span class="min-w-0 truncate">{name}</span>
            <button
              type="button"
              class="-mr-1 cursor-pointer opacity-70 hover:opacity-100"
              aria-label={`Stop viewing ${name}`}
              data-action="session"
              data-value={id}
              onClick={() => act("session", id)}
            >
              <Icon name="close" class="size-3.5" />
            </button>
          </span>
        );
      })}
      {rest.length > 0 && (
        <span class="badge badge-lg badge-ghost shrink-0" title={rest.map(nameOf).join(", ")}>
          {`+${fmtNum(rest.length)}`}
        </span>
      )}
      <button
        type="button"
        class="btn btn-ghost btn-sm shrink-0"
        aria-label="View all sessions"
        data-action="clearSelection"
        onClick={() => act("clearSelection")}
      >
        Clear
      </button>
    </span>
  );
}

/** The navbar's middle: every session, or the picked ones as one badge each with an × to drop it. */
function SelectionBar() {
  const { state } = useApp();
  return selectedIds(state).length === 0 ? (
    <AllSessionsWord count={sessionCount(state.sessions)} />
  ) : (
    <PickedWords />
  );
}

/** The live word: a glowing success dot while the stream is up, a warning "Reconnecting" while not. */
export function LiveStatus() {
  const { state } = useApp();
  if (state.connected) {
    return (
      <span class="flex shrink-0 items-center gap-2 text-sm" title="Connected to the radar server">
        <span class="status status-success text-success neon-dot" aria-hidden="true" />
        <span class="max-md:hidden">Live</span>
      </span>
    );
  }
  return (
    <span
      class="flex shrink-0 items-center gap-2 text-warning text-sm"
      title="The live stream is down and reconnects on its own"
    >
      <span class="status status-warning" aria-hidden="true" />
      <span class="max-md:hidden">Reconnecting</span>
    </span>
  );
}

/** The alerts bell: an error-coloured indicator badge with the count, one click to the Alerts tab. */
export function AlertsButton() {
  const { state, act } = useApp();
  const alerts = state.alerts.length;
  return (
    <button
      type="button"
      class="btn btn-ghost btn-square"
      aria-label={alerts > 0 ? `Alerts, ${fmtNum(alerts)} open` : "Alerts"}
      title="Alerts"
      data-action="tab"
      data-value="alerts"
      onClick={() => act("tab", "alerts")}
    >
      <span class="indicator">
        {alerts > 0 && <span class="indicator-item badge badge-error badge-sm">{fmtNum(alerts)}</span>}
        <Icon name="bell" class="size-4.5" />
      </span>
    </button>
  );
}

/** The theme choices: System (default), Mocha (dark), Latte (light); the values are the controller's. */
const THEME_CHOICES: { id: ThemePref; label: string; icon: IconName }[] = [
  { id: "system", label: "System", icon: "monitor" },
  { id: "dark", label: "Mocha (dark)", icon: "moon" },
  { id: "light", label: "Latte (light)", icon: "sun" },
];

/** The one theme control: a dropdown whose button carries the current choice's icon; the time-format
 *  choice rides along, the only place that reads times across the app is set. */
export function ThemeDropdown() {
  const { state, act } = useApp();
  const current = THEME_CHOICES.find((choice) => choice.id === state.theme) ?? THEME_CHOICES[0];
  return (
    <details class="dropdown dropdown-end" data-theme-dropdown="">
      <summary class="btn btn-ghost btn-square" aria-label={`Theme: ${current?.label ?? "System"}`}>
        <Icon name={current?.icon ?? "monitor"} class="size-4.5" />
      </summary>
      <div class="dropdown-content z-40 mt-2 flex w-52 flex-col gap-3 rounded-box border hairline bg-base-100 p-3 shadow-lg">
        <ul class="menu w-full p-0" aria-label="Theme">
          {THEME_CHOICES.map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                class={state.theme === choice.id ? "menu-active" : ""}
                aria-current={state.theme === choice.id ? "true" : undefined}
                data-action="theme"
                data-value={choice.id}
                onClick={() => act("theme", choice.id)}
              >
                <Icon name={choice.icon} class="size-4.5" />
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
        <label class="grid gap-1">
          <span class="text-meta text-base-content/60">Time format</span>
          <select
            class="select w-full"
            aria-label="Time format"
            value={state.timeMode}
            onChange={(event) => act("time-mode", event.currentTarget.value)}
          >
            <option value="relative">Relative (3m ago)</option>
            <option value="absolute">Clock (12:04:31)</option>
          </select>
        </label>
      </div>
    </details>
  );
}

/** The shortcuts a reader can press anywhere; the list under the ? button and the rail's Shortcuts. */
const SHORTCUTS: { keys: string[]; text: string }[] = [
  { keys: ["R"], text: "Refresh now" },
  { keys: ["J"], text: "Newer request" },
  { keys: ["K"], text: "Previous request" },
  { keys: ["Esc"], text: "Close the request details" },
  { keys: ["↑", "↓"], text: "Walk the session cards" },
  { keys: ["Space", "Enter"], text: "Toggle a session in the view" },
  { keys: ["X"], text: "Clear the selection" },
];

/** Open the shortcuts dialog from anywhere (the ? button, the rail footer). */
export function openShortcuts(): void {
  const dialog = document.getElementById("radar-shortcuts");
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

/** The keyboard shortcuts, a daisyUI modal on a native dialog: Esc and the backdrop close it. */
export function ShortcutsModal() {
  return (
    <dialog id="radar-shortcuts" class="modal" aria-label="Keyboard shortcuts">
      <div class="modal-box max-w-md">
        <h2 class="text-lg font-semibold">Keyboard shortcuts</h2>
        <ul class="list mt-3">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.text} class="list-row items-center py-1">
              <span class="flex shrink-0 gap-1">
                {shortcut.keys.map((key) => (
                  <kbd key={key} class="kbd kbd-sm">
                    {key}
                  </kbd>
                ))}
              </span>
              <span class="list-col-grow text-sm">{shortcut.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="submit" aria-label="Close the shortcuts">
          close
        </button>
      </form>
    </dialog>
  );
}

/** The whole top bar: brand, selection, controls, and the neon line under it. */
export function ScopeHeader() {
  return (
    <header data-scope-header class="glass sticky top-0 z-30">
      <div class="navbar h-16 min-h-16 gap-3 px-6 max-sm:px-4">
        <div class="navbar-start w-auto min-w-0 grow-0 gap-2 px-0">
          <RailOpener />
          <Brand />
        </div>
        <div class="navbar-center min-w-0 flex-1 justify-start px-0">
          <SelectionBar />
        </div>
        <div class="navbar-end w-auto grow-0 gap-1 px-0">
          <TimeRange />
          <LiveStatus />
          <AlertsButton />
          <ThemeDropdown />
          <button
            type="button"
            class="btn btn-ghost btn-square"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={openShortcuts}
          >
            <span class="text-base">?</span>
          </button>
        </div>
      </div>
      <div class="neon-line" aria-hidden="true" />
      <ShortcutsModal />
    </header>
  );
}
