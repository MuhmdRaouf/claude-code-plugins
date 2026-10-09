/**
 * The alerts tab: every active alert as a row, an all-clear when there are none, and how each kind is
 * detected plus what dismissing means.
 */

import type { AlertKind } from "../../../alerts/engine.ts";
import { fmtCount } from "../../fmt.ts";
import { alertLabel } from "../../palette.ts";
import { ALERT_ICON, AlertRow } from "../AlertStrip.tsx";
import { useApp } from "../context.ts";
import { Icon } from "../Icon.tsx";
import { EmptyState, Panel } from "../kit.tsx";

const HOW_ALERTS_WORK: [AlertKind, string][] = [
  [
    "stuck",
    "A live session in the middle of a turn with no model request, tool result or agent event for 10 minutes (30 while a tool is still running). Never raised while Claude Code waits for you: a finished turn, an interruption or a permission prompt all count as waiting.",
  ],
  [
    "loop",
    "The same tool called with the same input 5 times in a row by one agent, the last in the past 30 minutes.",
  ],
  [
    "retry_storm",
    "5 or more rate limits or server errors (429, 5xx) within 2 minutes for one session or router.",
  ],
  [
    "context",
    "An agent's last request used 85% of its context window (200k, or 1M once a session shows it has one), with no compaction since.",
  ],
  ["budget", "A budget reaching 80% of its limit for this period, and again at 100%."],
];

/** The whole alerts tab: the active list (or an all-clear) and the plain-language explanation of each kind. */
export function AlertsView() {
  const { state } = useApp();
  const list =
    state.alerts.length === 0 ? (
      <EmptyState
        title="All clear"
        hint="Nothing looks stuck, looping, throttled, full or over budget right now."
        icon="check"
      />
    ) : (
      <ul class="grid gap-2">
        {state.alerts.map((alert) => (
          <AlertRow key={alert.id} alert={alert} />
        ))}
      </ul>
    );
  return (
    <div class="grid gap-5">
      <Panel icon="bell" title="Alerts" subtitle={fmtCount(state.alerts.length, "active alert")}>
        {list}
      </Panel>
      <Panel
        icon="alert"
        title="How alerts work"
        subtitle="Defaults chosen so an idle session never raises one"
      >
        <dl class="grid gap-x-5 gap-y-3 max-sm:grid-cols-1 sm:grid-cols-[max-content_1fr]">
          {HOW_ALERTS_WORK.flatMap(([kind, text]) => [
            <dt class="flex items-center gap-2 text-sm font-semibold" key={`${kind}-term`}>
              <Icon name={ALERT_ICON[kind]} class="icon text-base-content/60" />
              <span>{alertLabel(kind)}</span>
            </dt>,
            <dd class="m-0 text-sm text-base-content/70" key={`${kind}-text`}>
              {text}
            </dd>,
          ])}
        </dl>
        <p class="mt-4 mb-0 text-meta text-base-content/60">
          Dismissing hides that one occurrence; the same thing happening again raises a new alert. Desktop
          notifications go out for budgets, stuck sessions and loops (turn them off in Settings).
        </p>
      </Panel>
    </div>
  );
}
