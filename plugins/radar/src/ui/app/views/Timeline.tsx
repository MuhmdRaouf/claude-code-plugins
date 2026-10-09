/**
 * The timeline view: every visible event on a daisyUI timeline — the event's icon in its tone on the
 * spine, what happened and where on one side, when on the other — newest first.
 */

import type { EventRecord } from "../../../shared/model.ts";
import { fmtCount, sessionName } from "../../fmt.ts";
import { eventMeta, STATUS_COLOR } from "../../palette.ts";
import { type ClientState, visibleEvents } from "../../state.ts";
import { useApp } from "../context.ts";
import { Icon } from "../Icon.tsx";
import { Code, EmptyState, Panel } from "../kit.tsx";
import { timeText } from "../table.tsx";

function nameOfSession(state: ClientState, id: string | null): string {
  if (id === null) return "No session";
  const item = state.sessions.find((s) => s.id === id);
  return item === undefined ? id.slice(0, 8) : sessionName(item);
}

/** One event on the timeline: icon on the spine, what happened to the right, when on the left. */
function TimelineRow({ event, first, last }: { event: EventRecord; first: boolean; last: boolean }) {
  const { state, now } = useApp();
  const meta = eventMeta(event.kind);
  const session = nameOfSession(state, event.sessionId);
  const when = timeText(state, event.ts, now);
  return (
    <li>
      {!first && <hr class="bg-base-content/15" />}
      <div class="timeline-middle">
        <span
          class="inline-grid size-8 place-items-center rounded-field"
          style={`color:${STATUS_COLOR[meta.tone]};background:color-mix(in srgb, ${STATUS_COLOR[meta.tone]} 15%, transparent)`}
          aria-hidden="true"
        >
          <Icon name={meta.icon} class="icon" />
        </span>
      </div>
      {!last && <hr class="bg-base-content/15" />}
      <div class="timeline-end min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-2.5">
          <span class="text-sm font-medium" title={event.kind} data-kind-label>
            {meta.label}
          </span>
          {event.label !== null && event.label !== "" && (
            <span class="text-sm text-base-content/80" data-event-label>
              {event.label}
            </span>
          )}
        </div>
        <div
          class="mt-0.5 flex flex-wrap items-center gap-x-3 text-meta text-base-content/60"
          data-event-where
        >
          <span>{session}</span>
          {event.sessionId !== null && (
            <Code text={event.sessionId.slice(0, 8)} class="text-base-content/60" />
          )}
          <Code text={event.agentId ?? "main"} class="text-base-content/60" />
        </div>
      </div>
      <time
        class="timeline-start hidden md:block text-meta text-base-content/60 whitespace-nowrap"
        title={when.title}
        datetime={new Date(event.ts).toISOString()}
      >
        {when.text}
      </time>
    </li>
  );
}

/** The timeline tab: every event in the view, newest first, on one spine. */
export function TimelineView() {
  const { state } = useApp();
  const total = visibleEvents(state);
  // the newest 200: a huge session must not sink the page under rows
  const events = total.slice(0, 200);
  return (
    <Panel icon="history" title="Timeline" subtitle={`${fmtCount(total.length, "event")}, newest first`}>
      {events.length === 0 ? (
        <EmptyState
          title="Nothing has happened yet"
          hint="Sessions starting, agents spawning, compactions and errors land here in order as they happen."
          icon="history"
        />
      ) : (
        <ol class="timeline timeline-vertical timeline-compact" aria-label="Events, newest first">
          {events.map((event, index) => (
            <TimelineRow
              key={`${event.ts}/${event.kind}/${event.sessionId}/${index}`}
              event={event}
              first={index === 0}
              last={index === events.length - 1}
            />
          ))}
        </ol>
      )}
    </Panel>
  );
}
