// Rail.tsx — the channel rail: the channel switcher and the filter on top, one card per session
// in the channel (its status dot, its name, what it is doing and when, its subagents and its
// open asks for the owner), and the footer's connection line with the Shortcuts key. A 24rem
// column on base-200, always open from lg; below it the top bar's hamburger slides it in.

import { type MenuItem, PopMenu } from "@muhmdraouf/ui/menu.tsx";
import { type Stamp, timeAgo } from "@muhmdraouf/ui/time.ts";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import { type SessionStatus, SSTM, sessionStatus, type Task, type TaskLookup } from "../status.ts";
import type { ChannelSummary, HuddleState, PlanStep, RosterSession } from "../store.ts";
import { useHuddle } from "./context.tsx";
import { channelHref, pathOf, sessHref } from "./router.ts";

/** The daisyUI status class of a derived session state: working lights green and pings, waiting
 *  warns, blocked reads red, paused sits mauve, idle and left (offline) stay quiet. */
export function statusDot(status: SessionStatus): string {
  if (status === "working") return "status-success";
  if (status === "waiting") return "status-warning";
  if (status === "blocked") return "status-error";
  if (status === "paused") return "status-secondary";
  return "status-neutral";
}

/** The word a card's dot speaks: the status table's, with left read as offline. */
export function statusWord(status: SessionStatus): string {
  return status === "left" ? "Offline" : SSTM[status].l;
}

/** Looks a plan step up by id; the doing line reads its id and title. */
export type StepLookup = (id: string) => PlanStep | null | undefined;

/** What a session is doing right now: its step's id and title, else its own words, else its
 *  role. `at` is its last sign of life, for the "· 2m ago" tail. */
export function doingOf(s: RosterSession, stepById: StepLookup): { text: string; at: Stamp | null } {
  const step = s.step ? stepById(s.step) : null;
  if (step) return { text: [step.id, step.title].filter(Boolean).join(" "), at: s.last_seen ?? null };
  const own = String(s.task ?? "").trim();
  if (own && !/^(joined|resumed|left)$/.test(own)) return { text: own, at: s.last_seen ?? null };
  return { text: s.role || "No task yet", at: s.last_seen ?? null };
}

/** Does a session's card match the rail's filter text? Its name, role and own words. */
export function cardMatches(s: RosterSession, text: string): boolean {
  if (text === "") return true;
  const needle = text.toLowerCase();
  const haystack = [s.name, s.role, s.task, s.step].filter((p) => typeof p === "string").join(" ");
  return haystack.toLowerCase().includes(needle);
}

/** The sessions that get a card: the top-level ones still in the channel, their subagents
 *  counted on the card instead of listed under it. */
export function cardSessions(sessions: readonly RosterSession[] | null | undefined): RosterSession[] {
  const list = sessions ?? [];
  const names = new Set(list.map((s) => s.name));
  return list.filter((s) => s.state !== "left" && (!s.parent || !names.has(s.parent)));
}

/** How many subagents are still in the channel under one session. */
export function subCount(sessions: readonly RosterSession[] | null | undefined, name: string): number {
  return (sessions ?? []).filter((s) => s.parent === name && s.state !== "left").length;
}

/** How many open questions a session has for the owner: its asks in the attention snapshot. */
export function asksFor(state: HuddleState, name: string): number {
  return (state.attention?.asks ?? []).filter((a) => a.from === name).length;
}

/** How many sessions of a channel summary are online, when the channel list carried them. */
export function onlineIn(c: ChannelSummary): number | null {
  return Array.isArray(c.sessions) ? c.sessions.length : null;
}

/** The board as the status model reads it: a step's id to its task, a missing status "to do". */
export function taskLookupOf(state: HuddleState): TaskLookup {
  return (id: string): Task | null => {
    const step = state.byId.get(id);
    if (!step) return null;
    return { status: step.status ?? "todo", ...(step.blocked_by ? { blocked_by: step.blocked_by } : {}) };
  };
}

/** The channel switcher: the open channel's name on the button, the other channels with their
 *  online counts and All channels under it. */
function ChannelSwitcher({ onNavigate }: { onNavigate?: (() => void) | undefined }): JSX.Element {
  const { state, go } = useHuddle();
  const [open, setOpen] = useState(false);
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const chname = state.info?.config?.title || state.ch || "";
  const chans = (state.channels ?? []).filter((c) => c.name !== state.ch);
  const items: MenuItem[] = [
    ...chans.map((c) => {
      const n = onlineIn(c);
      return {
        label: c.title || c.name,
        icon: <Icon name="hash" />,
        ...(n !== null ? { badge: <span class="tnum text-xs">{n}</span> } : {}),
        run: () => {
          go(channelHref(c.name));
          onNavigate?.();
        },
      } satisfies MenuItem;
    }),
    {
      label: "All channels",
      icon: <Icon name="layers" />,
      run: () => {
        go("#/");
        onNavigate?.();
      },
    },
  ];
  return (
    <span id="chbox" class="flex min-w-0 items-center">
      <button
        type="button"
        ref={setBtn}
        id="chbtn"
        class="btn btn-ghost h-10 w-full min-w-0 justify-between gap-2 px-3 text-left font-semibold"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={`Channel: ${chname}`}
        onClick={() => setOpen(true)}
      >
        <span class="flex min-w-0 items-center gap-2">
          <Icon name="hash" class="size-4 shrink-0 text-base-content/50" />
          <span class="truncate">{chname}</span>
        </span>
        <Icon name="down" class="size-4 shrink-0 text-base-content/50" />
      </button>
      {open && btn ? <PopMenu anchor={btn} items={items} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

/** One session card: the status dot and name over the doing line with its ago tail, then the
 *  subagent count and the asks badge. One button per card: clicking opens the session drawer. */
function RailCard({
  s,
  subs,
  asks,
  onOpen,
}: {
  s: RosterSession;
  subs: number;
  asks: number;
  onOpen: (name: string) => void;
}): JSX.Element {
  const { state, now } = useHuddle();
  const st = sessionStatus(s, taskLookupOf(state));
  const word = statusWord(st);
  const doing = doingOf(s, (id) => state.byId.get(id));
  return (
    <button
      type="button"
      data-card=""
      data-sess={s.name}
      aria-label={`${s.name}, ${word.toLowerCase()}`}
      title={`${s.name} — ${word}`}
      onClick={() => onOpen(s.name)}
      class="card w-full cursor-pointer flex-col gap-2 rounded-box bg-base-100/60 p-3.5 text-left hover:bg-base-100"
    >
      <span class="flex min-w-0 items-center gap-2.5">
        {st === "working" ? (
          <span class="inline-grid shrink-0 *:[grid-area:1/1]" aria-hidden="true" title={word}>
            <span class="status status-lg status-success motion-safe:animate-ping" />
            <span class="status status-lg status-success text-success neon-dot" />
          </span>
        ) : (
          <span class={`status status-lg shrink-0 ${statusDot(st)}`} aria-hidden="true" title={word} />
        )}
        <span class="sr-only">{word}</span>
        <span class="min-w-0 truncate text-[0.9375rem] font-semibold">{s.name}</span>
        {asks > 0 && (
          <span
            class="badge badge-error badge-sm shrink-0 tnum"
            title={`${asks} open question${asks === 1 ? "" : "s"} for you`}
          >
            {asks}
          </span>
        )}
        {subs > 0 && (
          <span class="num ml-auto shrink-0 text-xs text-base-content/60" title="Subagents working under it">
            {subs} sub{subs === 1 ? "" : "s"}
          </span>
        )}
      </span>
      <span class="flex min-w-0 items-center gap-1.5 text-sm">
        <span class="min-w-0 truncate text-base-content/80" title={doing.text}>
          {doing.text}
        </span>
        {doing.at !== null && (
          <span class="num shrink-0 text-xs text-base-content/60">· {timeAgo(doing.at, now)}</span>
        )}
      </span>
      {s.role ? (
        <span class="badge badge-outline border-base-content/15 text-base-content/70 min-w-0 max-w-full gap-1.5 text-xs font-normal">
          <span class="min-w-0 truncate">{s.role}</span>
        </span>
      ) : null}
    </button>
  );
}

/** Skeleton blocks shaped like the switcher, the filter and the cards, shown until the roster
 *  arrives. */
function RailSkeleton(): JSX.Element {
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" aria-hidden="true">
      <div class="skeleton h-10 w-full" />
      <div class="skeleton h-10 w-full" />
      {[0, 1, 2, 3].map((row) => (
        <div key={row} class="skeleton h-24 w-full" />
      ))}
    </div>
  );
}

/** The rail's bottom: the connection line (the live word and the last change) and the Shortcuts
 *  key. */
export function RailFooter({ onHelp }: { onHelp?: (() => void) | undefined }): JSX.Element {
  const { state, now, updatedAt } = useHuddle();
  return (
    <div class="flex items-center justify-between gap-2 border-t hairline p-4" data-rail-footer="">
      {state.live === "live" ? (
        <span
          class="flex min-w-0 items-center gap-2 text-sm text-base-content/70"
          title="Connected to the huddle server"
        >
          <span class="status status-success text-success neon-dot shrink-0" aria-hidden="true" />
          <span class="truncate">{`Connected, updated ${timeAgo(updatedAt, now)}`}</span>
        </span>
      ) : state.live === "offline" ? (
        <span
          class="flex min-w-0 items-center gap-2 text-warning text-sm"
          title="The live stream is down and reconnects on its own"
        >
          <span class="status status-warning shrink-0" aria-hidden="true" />
          <span class="truncate">Reconnecting…</span>
        </span>
      ) : (
        <span
          class="flex min-w-0 items-center gap-2 text-sm text-base-content/70"
          title="Connecting to the huddle server"
        >
          <span class="status status-neutral shrink-0" aria-hidden="true" />
          <span class="truncate">Connecting…</span>
        </span>
      )}
      <button type="button" class="btn btn-ghost btn-sm shrink-0" onClick={() => onHelp?.()}>
        Shortcuts
      </button>
    </div>
  );
}

/** The rail: switcher and filter on top, the session cards scrolling in the middle, the
 *  connection line pinned to the bottom. */
export function Rail({
  onHelp,
  onNavigate,
}: {
  onHelp?: (() => void) | undefined;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  const { state, go } = useHuddle();
  const [filter, setFilter] = useState("");
  // a channel switch clears the filter: the cards it narrowed are not the ones ahead
  useEffect(() => setFilter(""), [state.ch]);
  const ch = state.ch;
  const tops = cardSessions(state.sessions?.sessions);
  const cards = tops.filter((s) => cardMatches(s, filter));
  const open = (name: string): void => {
    if (ch) go(sessHref(ch, pathOf(location.hash), name));
    onNavigate?.();
  };
  return (
    <aside
      id="side"
      aria-label="Channel rail"
      class="sticky top-0 flex h-dvh w-96 min-w-96 max-w-96 shrink-0 flex-col bg-base-200"
    >
      {state.sessions === null ? (
        <RailSkeleton />
      ) : (
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <ChannelSwitcher onNavigate={onNavigate} />
          <label class="input w-full items-center gap-2" data-key="rail-filter">
            <Icon name="search" class="size-4 shrink-0 text-base-content/50" />
            <input
              type="search"
              class="min-w-0 grow bg-transparent outline-none"
              placeholder="Filter sessions"
              aria-label="Filter sessions"
              data-key="rail-filter-input"
              value={filter}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </label>
          <section class="flex flex-col gap-2" data-card-list="" aria-label="Sessions in the channel">
            {cards.map((s) => (
              <RailCard
                key={s.name}
                s={s}
                subs={subCount(state.sessions?.sessions, s.name)}
                asks={asksFor(state, s.name)}
                onOpen={open}
              />
            ))}
            {cards.length === 0 && (
              <p class="flex flex-col items-center gap-1.5 rounded-box border border-dashed border-base-content/20 px-6 py-8 text-center text-sm">
                <span class="text-base-content">
                  <Icon name="users" class="size-6" />
                </span>
                <span class="font-medium">{tops.length ? "Nothing matches" : "Nobody has joined yet"}</span>
                <span class="muted">
                  {tops.length
                    ? "No session matches that text; clear the filter."
                    : "Connect a session in Settings and it shows up here."}
                </span>
              </p>
            )}
          </section>
        </div>
      )}
      <RailFooter onHelp={onHelp} />
    </aside>
  );
}
