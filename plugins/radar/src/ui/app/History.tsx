/**
 * The rail's History tab: the ended sessions grouped by day under sticky headers — Today, Yesterday,
 * Mon 6 Oct — plus one Unattached group for the traffic no session claimed. The same session cards the
 * live tab shows, a root whose subagents are still running badging them; picking one turns the main pane
 * into that session's page.
 */

import { OUTSIDE_SESSION, UNATTACHED_NAME } from "../../shared/model.ts";
import { fmtCount } from "../fmt.ts";
import { type HistoryRoot, rootName } from "../state.ts";
import { useApp } from "./context.ts";
import { EmptyState } from "./kit.tsx";
import { type CardSession, clearOnX, liveSubagents, modelsOf, SessionCard } from "./SessionCard.tsx";

/** A history root no session owns: the unattached traffic, grouped on its own at the end. */
export function isUnattached(root: HistoryRoot): boolean {
  return root.sessionId === OUTSIDE_SESSION || root.name === UNATTACHED_NAME;
}

/** The page's session count: the roots themselves — the Unattached roll-up group the route appends is
 *  a job aggregate, not a session, so the badge and the sr-only line leave it out. */
export function sessionCount(roots: HistoryRoot[]): number {
  return roots.filter((root) => !isUnattached(root)).length;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** The words a day group is headed by: Today, Yesterday, else "Mon 6 Oct". */
export function dayLabel(ts: number, now: number): string {
  const date = new Date(ts);
  const today = new Date(now);
  if (sameDay(date, today)) return "Today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** The local day a timestamp falls on, as the groups' key. */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** One day group: its sticky header's words and the roots that ran that day, in the order given. */
export type DayGroup = { key: string; label: string; roots: HistoryRoot[] };

/** The rail's history groups, oldest label last: one per day, then Unattached when there is any. */
export function historyGroups(roots: HistoryRoot[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  const unattached: HistoryRoot[] = [];
  for (const root of roots) {
    if (isUnattached(root)) {
      unattached.push(root);
      continue;
    }
    const ts = root.startedAt ?? root.lastAt;
    const key = dayKey(ts);
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, label: dayLabel(ts, now), roots: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.roots.push(root);
  }
  if (unattached.length > 0) {
    groups.push({ key: "unattached", label: UNATTACHED_NAME, roots: unattached });
  }
  return groups;
}

/** A history root as a rail card: its own name, the tree's cost, its models — no live badge unless a
 *  subagent of it is still running, and no now line or context gauge, which only a live session has.
 *  `liveNodes` counts the root's own main node, so the badge shows the live count minus that one: the
 *  badge speaks about subagents, and hides when none is left. */
export function cardOfRoot(root: HistoryRoot): CardSession {
  return {
    id: root.id,
    name: rootName(root) ?? root.id,
    repo: root.repo ?? root.cwd,
    cwd: root.cwd,
    branch: root.branch,
    status: root.liveNodes > 0 ? "working" : null,
    live: root.liveNodes > 0,
    costUsd: root.costUsd ?? null,
    models: modelsOf(root.activity),
    liveAgents: liveSubagents(root.liveNodes, root.liveNodes > 0),
    agentCount: root.nodes,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    lastAt: root.lastAt,
    now: null,
    context: null,
    activity: root.activity,
  };
}

/** Skeleton cards shaped like the rail's cards, shown while the first history page is on its way. */
export function RailListSkeleton() {
  return (
    <div class="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((card) => (
        <div key={card} class="skeleton h-24 w-full" />
      ))}
    </div>
  );
}

/** The words the history list starts with while its page is away, or when it came back empty. */
function HistoryPlaceholder({ roots }: { roots: HistoryRoot[] | null }) {
  const { state } = useApp();
  if (roots === null) {
    return state.historyRootsLoading ? (
      <RailListSkeleton />
    ) : (
      <EmptyState
        title="No history loaded"
        hint="Sessions land here once they end; open the History tab again to read the store."
        icon="history"
      />
    );
  }
  return (
    <EmptyState
      title="Nothing in history here"
      hint={
        state.historyRootsError !== null
          ? state.historyRootsError
          : "Sessions land here once they end; adjust the search or the repo."
      }
      icon="history"
    />
  );
}

/** The history tab's list: sticky day groups of cards, the Unattached group, and the next page. */
export function HistoryRail() {
  const { state, now, act } = useApp();
  const roots = state.historyRoots;
  const groups = roots === null ? [] : historyGroups(roots, now);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the rail's X clears the picked set; the list itself is not a control
    <div
      class="flex flex-col gap-2"
      data-key="history"
      data-card-list=""
      onKeyDown={clearOnX(() => act("clearSelection"))}
    >
      {(roots === null || roots.length === 0) && <HistoryPlaceholder roots={roots} />}
      {groups.map((group) => (
        <section key={group.key} class="flex flex-col gap-2" data-day={group.key}>
          <h3 class="sticky top-0 z-10 -mx-4 bg-base-200 px-4 py-1 text-meta font-medium text-base-content/60">
            {group.label}
          </h3>
          {group.roots.map((root) => {
            const picked = state.historyScope?.rootId === root.id && state.historyScope.nodeId === null;
            return (
              <SessionCard
                key={root.id}
                session={cardOfRoot(root)}
                selected={picked}
                onSelect={(id) => {
                  // a second click on the picked root leaves the scope again (the old breadcrumb's way out)
                  if (picked) act("scope-clear");
                  else act("scope", JSON.stringify({ rootId: id, nodeId: null }));
                }}
              />
            );
          })}
        </section>
      ))}
      {roots !== null && roots.length > 0 && state.historyNext !== null && (
        <button type="button" class="btn btn-sm" data-action="more-roots" onClick={() => act("more-roots")}>
          {state.historyRootsLoading ? "Loading…" : "Load more"}
        </button>
      )}
      {roots !== null && roots.length > 0 && (
        <p class="sr-only">{fmtCount(sessionCount(roots), "session in history")}</p>
      )}
    </div>
  );
}
