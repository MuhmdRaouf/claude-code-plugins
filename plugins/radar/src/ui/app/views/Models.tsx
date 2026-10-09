/**
 * The models tab: one ranked row per model with its requests bar next to the token-kind bar, the upstream
 * endpoints, and the request-rate chart for the selected window — all over the picked sessions and the
 * range, the scope the tab fetches /api/models with.
 */

import type { VNode } from "preact";
import { type ModelRow, type Tokens, totalTokens, type UpstreamRow } from "../../../shared/model.ts";
import { bucketPlan, rangeToHash } from "../../../shared/time-range.ts";
import { bucketizeRange, windowLabels } from "../../chart.ts";
import { bucketWord, costText, fmtCount, fmtDuration, fmtNum, fmtTokens } from "../../fmt.ts";
import { providerColor, TOKEN_KINDS } from "../../palette.ts";
import { flowSource, modelsScopeKey, selectedIds, visibleRequests } from "../../state.ts";
import { AreaChart, StackedBar } from "../Chart.tsx";
import { useApp } from "../context.ts";
import { Icon } from "../Icon.tsx";
import { Code, EmptyState, ModelChip, Panel } from "../kit.tsx";

/** The model's token bar: one segment per token kind, coloured by kind, against the view's biggest total. */
export function tokenBar(tokens: Tokens, max: number): VNode {
  return (
    <StackedBar
      segments={TOKEN_KINDS.map((kind) => ({ value: tokens[kind.key], color: kind.color }))}
      max={max}
    />
  );
}

/** The legend for the token bars: one swatch + label per token kind, in TOKEN_KINDS order. */
function TokenLegend() {
  return (
    <ul class="flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Token kinds">
      {TOKEN_KINDS.map((kind) => (
        <li class="flex items-center gap-1.5 text-meta" key={kind.key}>
          <span
            class="inline-block size-2.5 rounded-full"
            style={`background:${kind.color}`}
            aria-hidden="true"
          />
          <span>{kind.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** One ranked model row: name, provider, request facts, and the requests bar next to the token bar. */
function ModelRankRow({
  row,
  maxRequests,
  maxTokens,
}: {
  row: ModelRow;
  maxRequests: number;
  maxTokens: number;
}) {
  return (
    <div class="grid gap-2.5 py-4 first:pt-0 last:pb-0">
      <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        <span class="text-sm font-medium" data-rank-name>
          <ModelChip model={row.model} />
        </span>
        <span class="flex items-center gap-1.5 text-meta text-base-content/70" data-rank-provider>
          <span
            class="inline-block size-2 rounded-full"
            style={`background:${providerColor(row.provider)}`}
            aria-hidden="true"
          />
          <span>{row.provider}</span>
        </span>
        <span class="text-sm text-base-content/70" data-rank-meta>
          {`${fmtCount(row.requests, "request")}, median ${fmtDuration(row.latencyP50)}, ${costText(row.costUsd)}`}
        </span>
        <span class="num ml-auto text-sm font-semibold" data-rank-total>
          {fmtTokens(totalTokens(row.tokens))}
        </span>
        {row.errors > 0 && <span class="badge badge-error badge-soft">{fmtNum(row.errors)} failed</span>}
      </div>
      <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5" data-bar-pair>
        <span class="text-meta text-base-content/60" data-bar-label>
          Requests
        </span>
        <StackedBar
          segments={[{ value: row.requests, color: providerColor(row.provider) }]}
          max={maxRequests}
        />
        <span class="text-meta text-base-content/60" data-bar-label>
          Tokens
        </span>
        {tokenBar(row.tokens, maxTokens)}
      </div>
    </div>
  );
}

/** One ranked upstream row: its host (the wire's own name, "" included), request facts, and one bar
 *  in the shared upstream colour. */
function UpstreamRankRow({ row, maxUpstream }: { row: UpstreamRow; maxUpstream: number }) {
  return (
    <div class="grid gap-2 py-4 first:pt-0 last:pb-0">
      <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        <Code text={row.host} class="font-medium" data-rank-name />
        <span class="text-sm text-base-content/70" data-rank-meta>
          {`${fmtCount(row.requests, "request")}, ${costText(row.costUsd)}`}
        </span>
        <span class="num ml-auto text-sm font-semibold" data-rank-total>
          {fmtTokens(totalTokens(row.tokens))}
        </span>
      </div>
      <StackedBar segments={[{ value: row.requests, color: "var(--series-8)" }]} max={maxUpstream} />
    </div>
  );
}

/** The tab before its scoped fetch answers, or the failure that leaves it nothing to draw. */
function WaitingPanel() {
  const { state } = useApp();
  return (
    <Panel icon="cpu" title="Models">
      {state.modelsError !== null ? (
        <div role="alert" class="alert alert-error">
          <Icon name="alert" class="icon" />
          <span>{`The model tables did not answer (${state.modelsError}). Refresh to try again.`}</span>
        </div>
      ) : (
        <EmptyState
          title="Waiting for model totals"
          hint="They arrive once the tab's own fetch answers for the picked sessions and range."
          icon="cpu"
        />
      )}
    </Panel>
  );
}

/** The request-rate chart: the history answer for the range, else memory. A history range with no
 *  answer yet (or a failed one) draws the loading or error state, never the in-memory slice — memory
 *  cannot answer a window that size, and a near-empty plot from it would read as a quiet range. With
 *  sessions picked the history answer still counts every session, so the subtitle says so instead of
 *  letting the chart quietly widen. */
function RateCard() {
  const { state, now } = useApp();
  const { from, to, history } = flowSource(state, now);
  const fetched = history && state.flow?.key === rangeToHash(state.range) ? state.flow.series : null;
  const plan = bucketPlan(from, to);
  const counts =
    fetched !== null
      ? fetched.requests
      : history
        ? null
        : bucketizeRange(visibleRequests(state), from, to, plan.buckets);
  const everySession = history && selectedIds(state).length > 0;
  return (
    <Panel
      icon="activity"
      title="Request rate"
      subtitle={`Requests per bucket, ${bucketWord(fetched?.bucketMs ?? plan.bucketMs)} per bar${everySession ? ", every session" : ""}`}
    >
      <div class="rate-chart">
        {counts === null ? (
          state.flowError !== null ? (
            <div role="alert" class="alert alert-error">
              <Icon name="alert" class="icon" />
              <span>
                History did not answer for this range ({state.flowError}). Narrow the range or check the
                history store.
              </span>
            </div>
          ) : (
            <div class="skeleton h-[7.5rem] w-full" role="status" aria-label="Loading request rate" />
          )
        ) : (
          <AreaChart
            values={counts}
            width={720}
            height={120}
            color="var(--series-2)"
            gradientId="rate-gradient"
            xLabels={windowLabels(from, to, now)}
            yLabel={`${fmtNum(Math.max(...counts, 0))} max`}
          />
        )}
      </div>
    </Panel>
  );
}

/** The models tab: models ranked by requests, the upstream endpoints, and the request-rate chart — all
 *  three over the same scope every other view reads (the picked sessions and the range). The rankings
 *  come from the tab's own scoped fetch, never the snapshot's fleet-wide copy the tools tab shows. */
export function ModelsView() {
  const { state } = useApp();
  const held = state.modelsScoped?.key === modelsScopeKey(state) ? state.modelsScoped.data : null;
  if (held === null) return <WaitingPanel />;
  const models = held;
  const maxTokens = Math.max(...models.models.map((m) => totalTokens(m.tokens)), 1);
  const maxRequests = Math.max(...models.models.map((m) => m.requests), 1);
  const ranked = [...models.models].sort((a, b) => b.requests - a.requests);
  const modelCard = (
    <Panel
      icon="cpu"
      title="Models"
      subtitle={`${fmtCount(ranked.length, "model")}, tokens by kind`}
      actions={<TokenLegend />}
    >
      {ranked.length === 0 ? (
        <EmptyState
          title="No model requests yet"
          hint="Each model shows up here after its first request."
          icon="cpu"
        />
      ) : (
        <div class="divide-y divide-base-content/8">
          {ranked.map((row) => (
            <ModelRankRow key={row.model} row={row} maxRequests={maxRequests} maxTokens={maxTokens} />
          ))}
        </div>
      )}
    </Panel>
  );

  const maxUpstream = Math.max(...models.upstreams.map((u) => u.requests), 1);
  const upstreams = [...models.upstreams].sort((a, b) => b.requests - a.requests);
  const upstreamCard = (
    <Panel icon="arrows" title="Upstreams" subtitle={fmtCount(models.upstreams.length, "endpoint")}>
      {upstreams.length === 0 ? (
        <EmptyState
          title="No upstreams recorded"
          hint="Hosts appear once a session reports where it sends requests."
          icon="arrows"
        />
      ) : (
        <div class="divide-y divide-base-content/8">
          {upstreams.map((row) => (
            <UpstreamRankRow key={row.upstream} row={row} maxUpstream={maxUpstream} />
          ))}
        </div>
      )}
    </Panel>
  );

  return (
    <div class="grid gap-5">
      {modelCard}
      <div class="grid gap-5 lg:grid-cols-2">
        {upstreamCard}
        <RateCard />
      </div>
    </div>
  );
}
