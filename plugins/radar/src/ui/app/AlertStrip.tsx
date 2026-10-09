/**
 * The strip above the summary: the three loudest alerts with where they happened, a count, and a way to the
 * full list. Renders nothing while there is nothing to look at; the alerts tab reuses AlertRow.
 */

import type { Alert, AlertKind } from "../../alerts/engine.ts";
import { costText, fmtAgo, fmtCount, fmtNum } from "../fmt.ts";
import type { IconName } from "../icons.ts";
import { alertLabel, STATUS_COLOR, type StatusTone } from "../palette.ts";
import { useApp } from "./context.ts";
import { Icon } from "./Icon.tsx";
import { Badge, IconTile, Panel } from "./kit.tsx";

export const ALERT_ICON: Record<AlertKind, IconName> = {
  stuck: "timer",
  loop: "repeat",
  retry_storm: "wifiOff",
  context: "gauge",
  budget: "dollar",
};

/** Where an alert happened: the project and agent, the session id when the project is unknown, or the router. */
export function alertWhere(alert: Alert): string {
  if (alert.sessionId === "") return alert.kind === "budget" ? "All sessions" : "Router";
  const project = alert.project === "" ? alert.sessionId.slice(0, 8) : alert.project;
  return alert.agentId === null ? project : `${project}, ${alert.agentId.slice(0, 12)}`;
}

/** The daisyUI alert classes the row's severity reads as: errors in error colour, the rest in warning. */
export function alertClasses(tone: StatusTone): string {
  return `alert alert-soft ${tone === "err" ? "alert-error" : "alert-warning"}`;
}

/** One alert: a daisyUI alert row — the kind badge and detail, the where/since/cost facts, and a dismiss
 *  button. */
export function AlertRow({ alert }: { alert: Alert }) {
  const { now, act } = useApp();
  const tone: StatusTone = alert.severity === "err" ? "err" : "warn";
  return (
    <li role="alert" class={`${alertClasses(tone)} items-start`}>
      <IconTile name={ALERT_ICON[alert.kind]} color={STATUS_COLOR[tone]} sm />
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <Badge text={alertLabel(alert.kind)} tone={tone} />
          <span class="min-w-0 truncate text-sm">{alert.detail}</span>
        </div>
        <div class="flex flex-wrap gap-x-3.5 text-meta text-base-content/70">
          <span>{alertWhere(alert)}</span>
          <span>{`since ${fmtAgo(alert.since, now)}`}</span>
          {alert.costUsd !== null && <span>{costText(alert.costUsd)}</span>}
        </div>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-sm shrink-0"
        data-action="dismiss-alert"
        data-value={alert.id}
        aria-label={`Dismiss: ${alert.detail}`}
        onClick={() => act("dismiss-alert", alert.id)}
      >
        <Icon name="close" />
        <span>Dismiss</span>
      </button>
    </li>
  );
}

/** The overview's alert strip: the first three alerts, their count, and a button to the alerts tab. */
export function AlertStrip() {
  const { state, act } = useApp();
  if (state.alerts.length === 0) return null;
  const shown = state.alerts.slice(0, 3);
  const more = state.alerts.length - shown.length;
  return (
    <Panel
      icon="bell"
      title="Needs a look"
      subtitle={fmtCount(state.alerts.length, "active alert")}
      actions={
        <button
          type="button"
          class="btn btn-sm"
          data-action="tab"
          data-value="alerts"
          onClick={() => act("tab", "alerts")}
        >
          <span>{more > 0 ? `All ${fmtNum(state.alerts.length)} alerts` : "Alerts"}</span>
        </button>
      }
    >
      <ul class="grid gap-2">
        {shown.map((alert) => (
          <AlertRow key={alert.id} alert={alert} />
        ))}
      </ul>
    </Panel>
  );
}
