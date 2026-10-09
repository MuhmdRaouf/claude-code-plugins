// Team.tsx — the Team page: the roster (the turn banner, the sessions with their subagents, the
// ones that left folded away) over the activity feed with its two filters — the topic family and
// the session — and the reply path into the composer. The filters stay per channel in this
// browser's settings ("tlf:<ch>", "tls:<ch>").

import { Panel } from "@muhmdraouf/ui/page.tsx";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useHuddle } from "../app/context.tsx";
import { IntroActions } from "../app/intro.tsx";
import { parseHash } from "../app/router.ts";
import type { ComposeOptions } from "../compose/drafts.ts";
import { Empty, Skeleton } from "../kit.tsx";
import { readPref, type Storage, writePref } from "../storage.ts";
import type { FeedEvent, PlanStep } from "../store.ts";
import { onlineCount, Roster } from "../team/Roster.tsx";
import { Timeline, type TimelineFilter } from "../team/Timeline.tsx";

/** The feed's topic families, in strip order. */
const FAMILIES: readonly (readonly [string, string])[] = [
  ["all", "All"],
  ["msg", "Messages"],
  ["task", "Tasks"],
  ["kb", "Knowledge"],
  ["control", "Turns"],
  ["session", "Sessions"],
];

/** The filters this browser kept for the channel; the defaults where it kept none. */
export function readTeamFilter(store: Storage, ch: string | null): TimelineFilter {
  return {
    family: readPref(store, ch ? `tlf:${ch}` : "tlf", "all"),
    session: readPref(store, ch ? `tls:${ch}` : "tls", ""),
  };
}

/** Keeps the filters for the channel. */
export function writeTeamFilter(store: Storage, ch: string, f: TimelineFilter): void {
  writePref(store, `tlf:${ch}`, f.family);
  writePref(store, `tls:${ch}`, f.session);
}

/** The feed's "N new": how many events landed while the reader was away from the bottom, and
 *  the word the feed's scroll gives back (true again clears the count). */
function useNewFeed(
  timeline: readonly FeedEvent[] | null | undefined,
  ch: string | null,
): {
  newCount: number;
  onAtBottom: (at: boolean) => void;
  home: () => void;
} {
  const [newCount, setNewCount] = useState(0);
  const atBottom = useRef(true);
  const seen = useRef(0);
  // primitives, not the array: the store appends into the same timeline array in place, and the
  // channel in the key re-seeds the count when another channel's page arrives
  const lastSeq = timeline?.at(-1)?.seq ?? 0;
  const feedLen = timeline?.length ?? 0;
  useEffect(() => {
    if (!timeline) return;
    if (atBottom.current) {
      seen.current = lastSeq;
      setNewCount(0);
      return;
    }
    setNewCount(timeline.filter((e) => (e.seq ?? 0) > seen.current).length);
  }, [ch, lastSeq, feedLen]);
  return {
    newCount,
    onAtBottom: (at) => {
      atBottom.current = at;
      if (at) {
        seen.current = timeline?.at(-1)?.seq ?? 0;
        setNewCount(0);
      }
    },
    home: () => {
      atBottom.current = true;
      setNewCount(0);
    },
  };
}

/** The Team page's props: where a Reply goes, the older-page loader, and the storage the filters
 *  keep to. */
export type TeamProps = {
  /** Opens the composer, as the answer to one ask (the feed's Reply button). */
  onCompose?: ((o: ComposeOptions) => void) | undefined;
  /** Loads the page of events before the feed's first one. */
  onOlder?: (() => void) | undefined;
  /** Site storage; the page's localStorage when omitted. */
  prefs?: Storage | undefined;
};

/** The Team page over the store's roster and timeline. */
export function Team({ onCompose, onOlder, prefs = localStorage }: TeamProps = {}): JSX.Element | null {
  const { state, now } = useHuddle();
  const ch = state.ch;
  const [filter, setFilter] = useState<TimelineFilter>(() => readTeamFilter(prefs, ch));
  const feed = useNewFeed(state.timeline, ch);

  // a new channel starts from the filters this browser kept for it, reading at the bottom
  useEffect(() => {
    setFilter(readTeamFilter(prefs, ch));
    feed.home();
  }, [prefs, ch]);

  if (!ch) return null;
  const roster = state.sessions?.sessions ?? [];
  const steps = state.board?.steps ?? [];
  const byId = new Map<string, PlanStep>(steps.map((s) => [s.id, s]));
  // the server always carries `start` (null when the channel has no turn), so only a non-empty
  // string says the channel takes turns
  const start = state.sessions?.config?.start ?? state.info?.config?.start;
  const hasTurn = typeof start === "string" && start.length > 0;
  const turnHolder = hasTurn ? (state.sessions?.turn?.holder ?? null) : undefined;
  const orchestrator =
    typeof state.info?.config?.orchestrator === "string" ? state.info.config.orchestrator : null;
  const names = new Set(roster.map((s) => s.name));
  // the fixed "You" option already speaks for the owner
  const speakers = [...new Set((state.timeline ?? []).map((e) => e.from).filter((n): n is string => !!n))]
    .filter((n) => n !== "owner" && (!names.has(n) || !n.includes(".")))
    .sort();
  const write = (f: TimelineFilter): void => {
    writeTeamFilter(prefs, ch, f);
    setFilter(f);
  };
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <IntroActions>
        <span class="badge badge-ghost badge-sm tnum">{onlineCount(roster)} online</span>
      </IntroActions>
      {!state.sessions ? (
        <Skeleton rows={4} class="h-16" />
      ) : (
        <Panel title="Sessions" label="Sessions">
          <Roster
            sessions={roster}
            taskById={(id) => byId.get(id)}
            now={now}
            orchestrator={orchestrator}
            costOf={(name) => (state.extras?.ch === ch ? state.extras?.obs?.cost?.[name] : undefined)}
            onOpen={(name) => {
              location.hash = `#/c/${ch}/team?s=${encodeURIComponent(name)}`;
            }}
            turnHolder={turnHolder}
            activeName={parseHash(location.hash, (k, fb) => readPref(prefs, k, fb)).sess}
            connectHref={`#/c/${ch}/settings`}
          />
        </Panel>
      )}
      <Panel
        title="Activity"
        label="Activity"
        actions={
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: the filter strip's group role */}
            <div class="join join-sm" role="group" aria-label="Filter the feed">
              {FAMILIES.map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  class={`btn join-item btn-sm${filter.family === k ? " btn-primary" : ""}`}
                  data-f={k}
                  aria-pressed={filter.family === k}
                  onClick={() => write({ ...filter, family: k })}
                >
                  {l}
                </button>
              ))}
            </div>
            <label class="sr-only" for="tls">
              Whose events
            </label>
            <select
              id="tls"
              class="select select-sm w-auto"
              value={filter.session}
              onChange={(e) => write({ ...filter, session: e.currentTarget.value })}
            >
              <option value="">Everyone</option>
              <option value="owner">You</option>
              {speakers.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </>
        }
        flush={state.timeline !== null}
      >
        {state.timeline ? (
          <Timeline
            events={state.timeline}
            replies={state.replies}
            now={now}
            filter={filter}
            taskById={(id) => byId.get(id)}
            onOpenTask={(id) => {
              location.hash = `#/c/${ch}/work?t=${encodeURIComponent(id)}`;
            }}
            onReply={(seq) => onCompose?.({ reply: seq })}
            onOlder={onOlder}
            newCount={feed.newCount}
            onAtBottom={feed.onAtBottom}
            knowledgeHref={(n) => `#/c/${ch}/knowledge/${n}`}
          />
        ) : (
          <Empty text="The feed has not loaded yet" icon="activity" />
        )}
      </Panel>
    </div>
  );
}
