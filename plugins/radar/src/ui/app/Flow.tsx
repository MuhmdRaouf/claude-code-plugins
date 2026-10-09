/**
 * The token-flow panel: the counted-up total for the view, a legend per token kind, the cache note, the
 * range control, and the stacked chart with a crosshair and a per-kind tooltip under the pointer. The
 * range decides where the numbers come from — the requests in memory for a short open-ended span,
 * /api/history/flow for anything longer or with a fixed end — and dragging across the plot zooms to the
 * dragged span.
 */

import { useState } from "preact/hooks";
import {
  bucketPlan,
  PRESETS,
  type TimeRange as RangeSpec,
  rangeLabel,
  rangeToHash,
} from "../../shared/time-range.ts";
import { bucketizeTokenKindsRange, cacheHitRate, nearestIndex, windowLabels } from "../chart.ts";
import { bucketWord, fmtClock, fmtNum, fmtPercent, fmtTokens } from "../fmt.ts";
import { TOKEN_KINDS } from "../palette.ts";
import { type ClientState, flowSource, selectedSession, visibleRequests } from "../state.ts";
import { StackedAreaChart } from "./Chart.tsx";
import { useApp } from "./context.ts";
import { useTween } from "./hooks.ts";
import { Icon } from "./Icon.tsx";
import { Panel } from "./kit.tsx";
import { TimeRange } from "./TimeRange.tsx";

/** A chart frame's numbers: the window it draws and the width of one bar. */
type Span = { from: number; to: number; bucketMs: number };

/** The plot's height: 18rem of chart inside the panel. */
const PLOT_HEIGHT = 270;

/** The four kind series the card draws, in TOKEN_KINDS order; `series === null` means "not here yet". */
function flowData(state: ClientState, now: number): { series: number[][] | null; span: Span } {
  const { from, to, history } = flowSource(state, now);
  const plan = bucketPlan(from, to);
  const fetched = history && state.flow?.key === rangeToHash(state.range) ? state.flow.series : null;
  if (fetched !== null) {
    return {
      series: TOKEN_KINDS.map((kind) => fetched.kinds[kind.key] ?? []),
      span: { from: fetched.from, to: fetched.to, bucketMs: fetched.bucketMs },
    };
  }
  if (history) return { series: null, span: { from, to, bucketMs: plan.bucketMs } };
  return {
    series: bucketizeTokenKindsRange(visibleRequests(state), from, to, plan.buckets),
    span: { from, to, bucketMs: plan.bucketMs },
  };
}

/** The window totals per kind (legend and cache note), all zeros while nothing has arrived. */
function totalsOf(series: number[][] | null): number[] {
  return (series ?? []).map((values) => values.reduce((acc, value) => acc + value, 0));
}

/** The selected range as the headline names it: "the last 6 hours", or "this range" once it is custom
 *  (or all time, where the picker beside it already says so). */
export function rangePhrase(range: RangeSpec): string {
  if (range.preset === null || range.preset === "all") return "this range";
  const label = PRESETS.find((entry) => entry.key === range.preset)?.label;
  return label === undefined ? "this range" : `the ${label.toLowerCase()}`;
}

/** Requests across the selected range: the history answer's counts, else the requests in memory inside the
 *  window. Null while the range runs on the history route and its answer has not arrived (or failed). */
export function requestsInRange(state: ClientState, now: number): number | null {
  const { from, to, history } = flowSource(state, now);
  const fetched = history && state.flow?.key === rangeToHash(state.range) ? state.flow.series : null;
  if (fetched !== null) return fetched.requests.reduce((acc, value) => acc + value, 0);
  if (history) return null;
  return visibleRequests(state).filter((request) => request.ts >= from && request.ts <= to).length;
}

/** The headline's number and its words. The range's own total — the session's when one is picked and the
 *  requests in memory can answer the range; a picked session's stored total, labelled all time, when only
 *  the history route could (it answers every session, not this one). Null while that answer is on its way. */
function heroOf(
  state: ClientState,
  now: number,
  series: number[][] | null,
): { value: number | null; unit: string } {
  const scope = selectedSession(state);
  const history = flowSource(state, now).history;
  if (scope !== null && history) {
    return { value: scope.tokens, unit: "tokens in this session, all time" };
  }
  const noun = rangePhrase(state.range);
  const unit = scope === null ? `tokens in ${noun}` : `tokens in this session, ${noun.replace(/^the /, "")}`;
  const value = series === null ? null : totalsOf(series).reduce((acc, value) => acc + value, 0);
  return { value, unit };
}

type Tip = { index: number; x: number; top: number; height: number };

/** A drag across the plot: where it started and now (client x), and the svg box it moves in. */
type Drag = { startX: number; x: number; left: number; width: number };

/** Where the tooltip sits: right of the pointer, or left of it when it would run off the window. */
function tipLeft(x: number, width: number): number {
  const left = x + 14 + width > window.innerWidth ? x - 14 - width : x + 14;
  return Math.max(8, left);
}

function ChartTip({ tip, series, ts }: { tip: Tip; series: number[][]; ts: number }) {
  const total = series.reduce((acc, values) => acc + (values[tip.index] ?? 0), 0);
  return (
    <>
      <div
        class="chart-tip"
        style={{ display: "block", left: `${tipLeft(tip.x, 190)}px`, top: `${tip.top + 8}px` }}
      >
        <div class="tip-head">{`${fmtClock(ts)}  ${fmtTokens(total)} tokens`}</div>
        {TOKEN_KINDS.map((kind, k) => (
          <div key={kind.label} class="tip-line">
            <span class="swatch" style={{ background: kind.color }} />
            <span>{kind.label}</span>
            <span class="tip-value">{fmtNum(series[k]?.[tip.index] ?? 0)}</span>
          </div>
        ))}
      </div>
      <div
        class="chart-cross"
        style={{ display: "block", left: `${tip.x}px`, top: `${tip.top}px`, height: `${tip.height}px` }}
      />
    </>
  );
}

/** The chart area: hover crosshair + tooltip, drag to zoom to the dragged span, double-click to zoom out.
 *  A `null` series renders a skeleton (or the history failure) in the chart's place. */
function FlowPlot({ series, span }: { series: number[][] | null; span: Span }) {
  const { state, now, act } = useApp();
  const [tip, setTip] = useState<Tip | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const first = series?.[0] ?? [];
  const label = rangeLabel(state.range, now);

  const svgRectOf = (event: PointerEvent): DOMRect | null => {
    const svg = (event.currentTarget as HTMLElement).querySelector("svg");
    return svg === null ? null : svg.getBoundingClientRect();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const rect = svgRectOf(event);
    if (rect === null) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setTip(null);
    setDrag({ startX: event.clientX, x: event.clientX, left: rect.left, width: rect.width });
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (drag !== null) {
      setDrag({ ...drag, x: event.clientX });
      return;
    }
    const rect = svgRectOf(event);
    if (rect === null) return;
    const index = nearestIndex(first, event.clientX - rect.left, rect.width);
    setTip(index === null ? null : { index, x: event.clientX, top: rect.top, height: rect.height });
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (drag === null) return;
    setDrag(null);
    if (svgRectOf(event) === null) return;
    const x0 = Math.min(drag.startX, drag.x) - drag.left;
    const x1 = Math.max(drag.startX, drag.x) - drag.left;
    if (x1 - x0 < 4 || drag.width <= 0) return; // a click, not a selection
    const lo = span.from + (x0 / drag.width) * (span.to - span.from);
    const hi = span.from + (x1 / drag.width) * (span.to - span.from);
    act("range-custom", `from=${Math.round(lo)}&to=${Math.round(hi)}`);
  };

  const peak = Math.max(
    ...first.map((_, index) => (series ?? []).reduce((acc, values) => acc + (values[index] ?? 0), 0)),
    0,
  );

  return (
    <div
      class="relative touch-none"
      role="img"
      aria-label={`Stacked token chart for the ${label}`}
      data-role="flow-plot"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        setTip(null);
        setDrag(null);
      }}
      onDblClick={() => act("range-reset")}
    >
      {series === null ? (
        state.flowError !== null ? (
          <div role="alert" class="alert alert-error">
            <Icon name="alert" class="icon" />
            <span>
              History did not answer for this range ({state.flowError}). Narrow the range or check the history
              store.
            </span>
          </div>
        ) : (
          <div class="skeleton h-[18rem] w-full" role="status" aria-label="Loading token flow" />
        )
      ) : (
        <StackedAreaChart
          series={TOKEN_KINDS.map((kind, index) => ({ values: series[index] ?? [], color: kind.color }))}
          width={720}
          height={PLOT_HEIGHT}
          xLabels={windowLabels(span.from, span.to, now)}
          yLabel={peak > 0 ? `${fmtTokens(peak)} per ${bucketWord(span.bucketMs)}` : null}
        />
      )}
      {drag !== null && (
        <div
          class="pointer-events-none absolute inset-y-0 bg-base-content/10"
          style={{
            left: `${Math.min(drag.startX, drag.x) - drag.left}px`,
            width: `${Math.abs(drag.x - drag.startX)}px`,
          }}
        />
      )}
      {tip !== null && (
        <ChartTip tip={tip} series={series ?? []} ts={span.from + tip.index * span.bucketMs} />
      )}
    </div>
  );
}

/** One figure that follows the fetch: its value once the series answers, a skeleton while it runs (never
 *  a zero, which would read as a quiet range), a dash when history did not answer. */
function FlowFigure({
  ready,
  failed,
  text,
  skeleton,
}: {
  ready: boolean;
  failed: boolean;
  text: string;
  skeleton: string;
}) {
  if (ready) return <>{text}</>;
  if (failed) return <>–</>;
  return <span class={`skeleton inline-block ${skeleton}`} aria-hidden="true" />;
}

/** The panel's left column: the range's headline total, the per-kind legend and the cache note. */
function FlowSummary({
  series,
  failed,
  hero,
  tweened,
  windowTotals,
  hit,
  label,
}: {
  series: number[][] | null;
  failed: boolean;
  hero: { value: number | null; unit: string };
  tweened: number;
  windowTotals: number[];
  hit: number | null;
  label: string;
}) {
  return (
    <div class="grid content-start gap-4">
      <div>
        <span class="block text-3xl leading-tight font-semibold num" data-role="hero-value">
          <FlowFigure
            ready={hero.value !== null}
            failed={failed}
            text={fmtTokens(tweened)}
            skeleton="h-9 w-28"
          />
        </span>
        <span class="mt-1 block text-sm text-base-content/60">{hero.unit}</span>
      </div>
      <ul class="grid gap-2" aria-label={`Tokens in the ${label}`}>
        {TOKEN_KINDS.map((kind, index) => (
          <li key={kind.label} class="flex items-center gap-2 text-sm">
            <span
              class="inline-block size-2.5 shrink-0 rounded-full"
              style={`background:${kind.color}`}
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate">{kind.label}</span>
            <span class="num text-base-content/80" data-legend-value>
              <FlowFigure
                ready={series !== null}
                failed={failed}
                text={fmtTokens(windowTotals[index] ?? 0)}
                skeleton="h-4 w-12"
              />
            </span>
          </li>
        ))}
      </ul>
      <p class="text-sm text-base-content/60">
        {series !== null
          ? hit === null
            ? "No cache reads in this window"
            : `${fmtPercent(hit)} of prompt tokens came from cache`
          : !failed && <span class="skeleton inline-block h-4 w-44" aria-hidden="true" />}
      </p>
    </div>
  );
}

export function Flow() {
  const { state, now, act } = useApp();
  const label = rangeLabel(state.range, now);
  const { series, span } = flowData(state, now);
  const windowTotals = totalsOf(series);
  const hit = cacheHitRate({
    input: windowTotals[0] ?? 0,
    cacheRead: windowTotals[2] ?? 0,
    cacheWrite: windowTotals[3] ?? 0,
  });
  const hero = heroOf(state, now, series);
  const tweened = useTween(hero.value ?? 0);
  return (
    <Panel
      icon="coins"
      title="Token flow"
      subtitle={`${label}, ${bucketWord(span.bucketMs)} per bar`}
      actions={
        <>
          {state.range.preset === null && (
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => act("range-reset")}>
              Reset to last 1 hour
            </button>
          )}
          <TimeRange />
        </>
      }
    >
      <div class="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <FlowSummary
          series={series}
          failed={state.flowError !== null}
          hero={hero}
          tweened={tweened}
          windowTotals={windowTotals}
          hit={hit}
          label={label}
        />
        <FlowPlot series={series} span={span} />
      </div>
    </Panel>
  );
}
