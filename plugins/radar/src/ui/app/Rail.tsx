/**
 * The sessions rail: the Live/History tabs, the filters and the cards scrolling in a 24rem column on
 * base-200, and a quiet footer with the connection line and the Shortcuts key. Always open from lg;
 * below it, the top bar's hamburger slides it in.
 */

import { fmtAgo } from "../fmt.ts";
import { useApp } from "./context.ts";
import { openShortcuts } from "./ScopeHeader.tsx";
import { Sessions } from "./Sessions.tsx";

/** Skeleton blocks shaped like the rail's tabs, filters and cards, shown until the first snapshot arrives. */
function RailSkeleton() {
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" aria-hidden="true">
      <div class="skeleton h-11 w-full" />
      <div class="skeleton h-10 w-full" />
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} class="skeleton h-28 w-full" />
      ))}
    </div>
  );
}

/** The rail's bottom: the connection line (the live word and the last update), and the Shortcuts key. */
export function RailFooter() {
  const { state, now } = useApp();
  const updated = state.updatedAt === null ? null : fmtAgo(state.updatedAt, now);
  return (
    <div class="flex items-center justify-between gap-2 border-t hairline p-4" data-rail-footer="">
      {state.connected ? (
        state.catchingUp ? (
          <span
            class="flex min-w-0 items-center gap-2 text-sm text-base-content/70"
            title="The server is still reading its backlog; the lists fill in as it goes"
          >
            <span class="status status-info shrink-0" aria-hidden="true" />
            <span class="truncate">Catching up</span>
          </span>
        ) : (
          <span
            class="flex min-w-0 items-center gap-2 text-sm text-base-content/70"
            title="Connected to the radar server"
          >
            <span class="status status-success text-success neon-dot shrink-0" aria-hidden="true" />
            <span class="truncate">{updated === null ? "Connected" : `Connected, updated ${updated}`}</span>
          </span>
        )
      ) : (
        <span
          class="flex min-w-0 items-center gap-2 text-warning text-sm"
          title="The live stream is down and reconnects on its own"
        >
          <span class="status status-warning shrink-0" aria-hidden="true" />
          <span class="truncate">Reconnecting…</span>
        </span>
      )}
      <button type="button" class="btn btn-ghost btn-sm shrink-0" onClick={openShortcuts}>
        Shortcuts
      </button>
    </div>
  );
}

/** The rail: exactly 24rem, pinned from both sides so the drawer cannot shrink or stretch it, the card
 *  list scrolling on its own while the footer stays put. */
export function Rail() {
  const { state } = useApp();
  return (
    <aside
      aria-label="Sessions rail"
      class="sticky top-0 flex h-dvh w-96 min-w-96 max-w-96 shrink-0 flex-col bg-base-200"
    >
      {state.summary === null ? (
        <RailSkeleton />
      ) : (
        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          <Sessions />
        </div>
      )}
      <RailFooter />
    </aside>
  );
}
