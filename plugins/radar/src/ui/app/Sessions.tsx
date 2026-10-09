/**
 * The rail: the Live/History tabs (one tab stop, the arrow keys switch), the repo and text filters in one
 * row, then the tab's list. Live is exactly the open main sessions — no tree, no jobs: a card's agents
 * live on the session page's Agents tab. History keeps the ended sessions grouped by day. Clicking a
 * card toggles its session in or out of the picked set; the "All sessions" card clears it.
 */

import type { SessionListItem } from "../../store/store.ts";
import { fmtNum, fmtTokens, fmtUsd } from "../fmt.ts";
import { useApp } from "./context.ts";
import { HistoryRail, sessionCount } from "./History.tsx";
import { Icon } from "./Icon.tsx";
import { EmptyState } from "./kit.tsx";
import { cardKeys, cardOfSession, clearOnX, SessionCard } from "./SessionCard.tsx";

/** A session radar only saw through a provider plugin: jobs carry a plugin id and no transcript of their own. */
export function isJob(item: SessionListItem): boolean {
  return item.external || item.id.includes(":");
}

/** Live sessions first, then most recently active first — the order the rail shows. */
export function orderedSessions(items: SessionListItem[]): SessionListItem[] {
  return [...items].sort((a, b) => Number(b.live) - Number(a.live) || b.lastAt - a.lastAt);
}

/** Every session's tokens together: what the "All sessions" card shows. */
export function sessionsTotal(items: SessionListItem[]): number {
  return items.reduce((acc, s) => acc + s.tokens, 0);
}

/** Every session's estimated cost together; unpriced sessions add nothing. */
export function sessionsCost(items: SessionListItem[]): number {
  return items.reduce((acc, s) => acc + (s.costUsd ?? 0), 0);
}

/** The open main sessions only: the registry's live entries, never jobs or ended sessions. */
export function liveSessions(items: SessionListItem[]): SessionListItem[] {
  return orderedSessions(items.filter((item) => item.live && !isJob(item)));
}

/** The rail's Live/History segmented control: daisyUI's tabs-box at large size, one tab stop,
 *  ArrowLeft/Right switch. */
export function PanelTabs({ live, history }: { live: number; history: number | null }) {
  const { state, act } = useApp();
  const tabs = [
    { id: "live", label: "Live", count: live },
    { id: "history", label: "History", count: history },
  ] as const;
  return (
    <div
      role="tablist"
      aria-label="Sessions panel"
      class="tabs tabs-box tabs-lg w-full"
      data-key="panel-tabs"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = event.key === "ArrowRight" ? "history" : "live";
        act("panel", next);
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-value]");
        buttons[next === "live" ? 0 : 1]?.focus();
      }}
    >
      {tabs.map((tab) => {
        const on = state.sessionsPanel === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            class={on ? "tab tab-active gap-2" : "tab gap-2"}
            tabIndex={on ? 0 : -1}
            data-action="panel"
            data-value={tab.id}
            aria-selected={on ? "true" : "false"}
            onClick={() => act("panel", tab.id)}
          >
            <span>{tab.label}</span>
            {tab.count !== null && (
              <span class={`num badge badge-sm ${on ? "badge-primary badge-soft" : "badge-ghost"}`}>
                {fmtNum(tab.count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The repo and text filters in one row, both at full field size; on Live they narrow the cards in
 *  memory, on History the query. */
export function RailFilters({ repos }: { repos: { repo: string; count: number }[] }) {
  const { state, act } = useApp();
  const history = state.sessionsPanel === "history";
  const input = history ? state.historyInput : state.liveInput;
  const repo = history ? (state.historyRepo ?? "") : (state.liveRepo ?? "");
  return (
    <div class="flex items-center gap-2" data-key="rail-filters">
      <label class="input min-w-0 flex-1 items-center gap-2">
        <Icon name="search" class="size-4 shrink-0 text-base-content/50" />
        <input
          type="search"
          class="min-w-0 grow bg-transparent outline-none"
          placeholder="Filter sessions"
          aria-label="Filter sessions"
          data-key={history ? "history-search" : "live-search"}
          value={input}
          onInput={(event) => act(history ? "history-input" : "live-input", event.currentTarget.value)}
        />
      </label>
      <select
        class="select w-32 shrink-0"
        aria-label="Filter by repository"
        data-key={history ? "history-repo" : "live-repo"}
        value={repo}
        onChange={(event) => act(history ? "history-repo" : "live-repo", event.currentTarget.value)}
      >
        <option value="">All repos</option>
        {repos.map((entry) => (
          <option key={entry.repo} value={entry.repo}>
            {entry.count > 0 ? `${entry.repo} (${entry.count})` : entry.repo}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The repos the live cards run in, alphabetically; the counts are the cards that carry them. */
export function liveRepos(items: SessionListItem[]): { repo: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const repo = item.repo ?? item.cwd;
    if (repo === null) continue;
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts].map(([repo, count]) => ({ repo, count })).sort((a, b) => a.repo.localeCompare(b.repo));
}

/** One line of card text matches when the reader's filter text appears in its name, repo or branch. */
export function matches(item: SessionListItem, text: string): boolean {
  if (text === "") return true;
  const needle = text.toLowerCase();
  const haystack = [item.name, item.project, item.repo, item.cwd, item.branch]
    .filter((part) => part !== null)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/** The "All sessions" card: the fleet in one row, tokens and cost together. It wears the aura while
 *  nothing is picked — it is the view then — and sits plain once the reader narrows to a set. */
function AllSessionsCard({ sessions, selected }: { sessions: SessionListItem[]; selected: boolean }) {
  const { act } = useApp();
  const card = (
    <button
      type="button"
      data-card=""
      data-action="session"
      data-value=""
      aria-pressed={selected ? "true" : "false"}
      onClick={() => act("session", "")}
      onKeyDown={(event) => cardKeys(event, event.currentTarget)}
      aria-label="All sessions, view every session"
      class="card w-full cursor-pointer flex-col gap-3 rounded-box bg-base-100/60 p-4 text-left hover:bg-base-100"
    >
      <span class="flex min-w-0 items-center gap-2.5">
        <Icon name="layers" class="size-4.5 shrink-0 text-base-content/60" />
        <span class="min-w-0 flex-1 truncate text-base font-semibold">All sessions</span>
        <span class="num shrink-0 text-[0.9375rem] font-medium" title="Tokens across every session">
          {fmtTokens(sessionsTotal(sessions))}
        </span>
        {sessionsCost(sessions) > 0 && (
          <span class="num shrink-0 text-[0.9375rem] font-medium" title="Estimated cost at list price">
            {fmtUsd(sessionsCost(sessions))}
          </span>
        )}
      </span>
    </button>
  );
  return selected ? (
    <div class="aura aura-catppuccin aura-sm block w-full [--tw-duration:16s] [&>*]:!bg-base-100">{card}</div>
  ) : (
    card
  );
}

/** The live tab: the fleet card, then one card per open session, narrowed by the rail's filters. */
export function LiveRail() {
  const { state, act } = useApp();
  const cards = liveSessions(state.sessions).filter(
    (item) =>
      (state.liveRepo === null || (item.repo ?? item.cwd) === state.liveRepo) &&
      matches(item, state.liveInput),
  );
  if (state.sessions.length === 0) {
    return (
      <EmptyState
        title="No sessions yet"
        hint="Start a Claude Code session and it shows up here within a second."
        icon="layers"
      />
    );
  }
  const nothingPicked = state.selected.length === 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the rail's X clears the picked set; the list itself is not a control
    <div
      class="flex flex-col gap-2"
      data-key="sessions"
      data-card-list=""
      onKeyDown={clearOnX(() => act("clearSelection"))}
    >
      <AllSessionsCard sessions={state.sessions} selected={nothingPicked} />
      {cards.map((item) => (
        <SessionCard
          key={item.id}
          session={cardOfSession(item)}
          selected={state.selected.includes(item.id)}
          onSelect={(id) => act("session", id)}
        />
      ))}
      {cards.length === 0 && (
        <EmptyState
          title="Nothing open matches"
          hint="No open session runs in that repo or matches that text; clear the filter or start one."
          icon="layers"
        />
      )}
      {nothingPicked && <span class="sr-only">Viewing every session. Press X to clear the selection.</span>}
    </div>
  );
}

/** The whole rail body: the tabs, the filters, then the tab's list with its empty states. */
export function Sessions() {
  const { state } = useApp();
  const live = liveSessions(state.sessions).length;
  // the badge reads right from the first snapshot: the store's ended-session count until the tab has
  // loaded its own page, then the page's sessions — the Unattached group it ends with is not one.
  // Roots still null means "nothing loaded yet", so with no count either the badge stays hidden
  // instead of reading 0.
  const history =
    state.historyRoots !== null ? sessionCount(state.historyRoots) : (state.historyStats?.roots ?? null);
  return (
    <div class="flex flex-col gap-4" data-key="rail">
      <PanelTabs live={live} history={history} />
      <RailFilters
        repos={
          state.sessionsPanel === "history"
            ? (state.historyRepos ?? []).map((entry) => ({ repo: entry.repo, count: entry.roots }))
            : liveRepos(liveSessions(state.sessions))
        }
      />
      {state.sessionsPanel === "history" ? <HistoryRail /> : <LiveRail />}
    </div>
  );
}
