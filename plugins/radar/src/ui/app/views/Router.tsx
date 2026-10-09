/**
 * The router view: one panel per provider plugin over the last 24 hours, the newest router events, and the
 * model advisor's cautious verdict.
 */

import type { AdvisorReport } from "../../../cost/advisor.ts";
import type { ProviderHealth } from "../../../router/health.ts";
import { ROUTER_EVENT_KINDS, type RouterEventKind } from "../../../shared/model.ts";
import { pluginLabel } from "../../../shared/provider.ts";
import { fmtAgo, fmtCount, fmtNum, fmtUsd } from "../../fmt.ts";
import { STATUS_COLOR, type StatusTone } from "../../palette.ts";
import { AreaChart } from "../Chart.tsx";
import { useApp } from "../context.ts";
import { Icon } from "../Icon.tsx";
import { EmptyState, ModelChip, Panel } from "../kit.tsx";

const ROUTER_META: Record<RouterEventKind, { label: string; one: string; tone: StatusTone }> = {
  fallback: { label: "Fallbacks", one: "fell back to Anthropic", tone: "warn" },
  refusal: { label: "Refusals", one: "refused a request", tone: "err" },
  rate_limited: { label: "Rate limits", one: "rate limited", tone: "warn" },
  budget_stop: { label: "Budget stops", one: "stopped at a budget", tone: "err" },
  restart: { label: "Restarts", one: "restarted", tone: "info" },
};

/** One provider's panel: a badge per event kind, the 24-hour rate chart, and when it last fired. */
function ProviderCard({ provider }: { provider: ProviderHealth }) {
  const { now } = useApp();
  const total = provider.series.reduce((a, b) => a + b, 0);
  const last =
    provider.lastAt === null
      ? "No events"
      : `Last ${fmtAgo(provider.lastAt, now)}${provider.lastReason === null ? "" : `: ${provider.lastReason}`}`;
  return (
    <Panel icon="route" title={pluginLabel(provider.plugin)} subtitle={`${fmtCount(total, "event")} in 24 h`}>
      <div class="grid gap-4">
        <div class="flex flex-wrap gap-1.5">
          {ROUTER_EVENT_KINDS.map((kind) => {
            const count = provider.counts[kind];
            const tone = count > 0 ? ROUTER_META[kind].tone : "idle";
            return (
              <span
                key={kind}
                class={`badge ${count > 0 ? (tone === "err" ? "badge-error badge-soft" : tone === "warn" ? "badge-warning badge-soft" : "badge-info badge-soft") : "badge-ghost"}`}
                title={ROUTER_META[kind].one}
              >
                {`${ROUTER_META[kind].label} ${fmtNum(count)}`}
              </span>
            );
          })}
        </div>
        <div class="rate-chart">
          <AreaChart
            values={provider.series}
            width={520}
            height={90}
            color="var(--series-4)"
            gradientId={`router-${provider.plugin.replace(/[^a-z0-9]/gi, "")}`}
            xLabels={[
              { text: "24 h ago", at: 0 },
              { text: "now", at: 1 },
            ]}
            yLabel={`${fmtNum(Math.max(...provider.series, 0))} per hour max`}
          />
        </div>
        <p class="text-meta text-base-content/60">{last}</p>
      </div>
    </Panel>
  );
}

/** The model advisor's panel: how many subagent runs look flash-sized and what they would have saved. */
function AdvisorCard({ report }: { report: AdvisorReport }) {
  return (
    <Panel icon="sparkle" title="Model advisor" subtitle="Main-model subagent runs that look flash-sized">
      {report.candidates === 0 ? (
        <EmptyState
          title={
            report.runsChecked === 0
              ? "No subagent runs on a main model yet"
              : "Every run looked like it needed its model"
          }
          hint={`${fmtCount(report.runsChecked, "run")} checked. A run counts only when it made at most 12 requests, wrote under 8k tokens and used nothing but read-only tools.`}
          icon="sparkle"
        />
      ) : (
        <>
          <p class="flex flex-wrap items-baseline gap-x-3">
            <span class="num text-3xl leading-none font-semibold">{fmtNum(report.candidates)}</span>
            <span class="text-sm text-base-content/60">
              {`of ${fmtCount(report.runsChecked, "run")} look flash-sized${report.savingUsd === null ? "" : `, est. saving ${fmtUsd(report.savingUsd)}`}`}
            </span>
          </p>
          <div class="mt-4 divide-y divide-base-content/8">
            {report.byModel.map((row) => (
              <div
                class="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 py-3.5 first:pt-0 last:pb-0"
                key={row.model}
                data-advisor-row
              >
                <span class="text-sm font-medium">
                  <ModelChip model={row.model} />
                </span>
                <span class="text-sm text-base-content/70">
                  {fmtCount(row.runs, "run")}
                  {row.flash !== null && (
                    <>
                      {", could run on "}
                      <ModelChip model={row.flash} />
                    </>
                  )}
                </span>
                <span class="num ml-auto text-sm font-semibold">
                  {row.costUsd !== null && row.flashCostUsd !== null
                    ? `${fmtUsd(row.costUsd)} → ${fmtUsd(row.flashCostUsd)}`
                    : "unpriced"}
                </span>
              </div>
            ))}
          </div>
          <p class="mt-4 text-meta text-base-content/60">
            A hint, not a verdict: few requests, little output and only read-only tools suggest the smaller
            model would have done. Claude models are counted without a figure.
          </p>
        </>
      )}
    </Panel>
  );
}

/** One recent router event: what fired, why, on which model, and when. */
function RouterEventRow({
  event,
  at,
}: {
  event: { plugin: string; event: RouterEventKind; reason: string; model: string | null; ts: number };
  at: string;
}) {
  const tone = ROUTER_META[event.event].tone;
  return (
    <li class="list-row">
      <span
        class="inline-grid size-8 shrink-0 place-items-center rounded-field"
        style={`color:${STATUS_COLOR[tone]};background:color-mix(in srgb, ${STATUS_COLOR[tone]} 15%, transparent)`}
        aria-hidden="true"
      >
        <Icon name="route" class="icon" />
      </span>
      <div class="min-w-0">
        <p class="m-0 text-sm font-medium">{`${pluginLabel(event.plugin)} ${ROUTER_META[event.event].one}`}</p>
        {event.reason !== "" && <p class="m-0 text-sm text-base-content/70">{event.reason}</p>}
        {event.model !== null && (
          <p class="m-0 mt-0.5">
            <ModelChip model={event.model} />
          </p>
        )}
      </div>
      <span class="text-meta text-base-content/60 whitespace-nowrap">{at}</span>
    </li>
  );
}

/** The router tab: provider health, recent events, and the advisor — or loading notes while they arrive. */
export function RouterView() {
  const { state, now } = useApp();
  const health = state.router;
  const providers = health?.providers ?? [];
  const top =
    health === null ? (
      <Panel icon="route" title="Router health">
        <p class="text-sm text-base-content/60">Loading router events…</p>
      </Panel>
    ) : providers.length === 0 ? (
      <Panel icon="route" title="Router health" subtitle="Last 24 hours">
        <EmptyState
          title="No router events yet"
          hint="When a provider plugin's router falls back to Anthropic, refuses a request, hits a rate limit, stops at a budget or restarts, it shows up here per provider."
          icon="route"
        />
      </Panel>
    ) : (
      <div class="grid gap-5 lg:grid-cols-2">
        {providers.map((provider) => (
          <ProviderCard key={provider.plugin} provider={provider} />
        ))}
      </div>
    );
  const recent = (health?.recent ?? []).slice(0, 20);
  return (
    <div class="grid gap-5">
      {top}
      {recent.length > 0 && (
        <Panel icon="clock" title="Recent router events" subtitle="Newest first">
          <ul class="list">
            {recent.map((event, i) => (
              <RouterEventRow
                key={`${event.ts}/${event.plugin}/${event.event}/${i}`}
                event={event}
                at={fmtAgo(event.ts, now)}
              />
            ))}
          </ul>
        </Panel>
      )}
      {state.advisor === null ? (
        <Panel icon="sparkle" title="Model advisor" subtitle="Main-model subagent runs that look flash-sized">
          <p class="text-sm text-base-content/60">Looking at recent runs…</p>
        </Panel>
      ) : (
        <AdvisorCard report={state.advisor} />
      )}
    </div>
  );
}
