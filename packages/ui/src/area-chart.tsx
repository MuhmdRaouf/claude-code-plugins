// area-chart.tsx — the activity chart: a smooth area per series over one window, a dashed grid at the
// quarters, axis labels, and a crosshair with a tooltip that follows the pointer. An all-zero window draws
// the grid and a centred note instead. Port of core.js areaChart as a component: the redraw handle becomes
// props, the imperative tip becomes render. The path math — the Catmull-Rom spline with its control points
// clamped inside the plot, and the 1/2/5 axis maxima — is copied from the radar dashboard's pure chart math
// (plugins/radar/src/ui/chart.ts); importing across plugins is not allowed, so the arithmetic lives here.

import type { JSX, TargetedPointerEvent, VNode } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

/** One drawn line over the window: its values and an optional tint class for a second line. */
export type ChartSeries = {
  values: readonly number[];
  tint?: string | undefined;
};

/** An x/y pair in svg units. */
export type Point = { x: number; y: number };

/** The plot's y bounds: the grid's top edge and the baseline. */
export type PlotBounds = { top: number; bottom: number };

/** The smallest of 1/2/5 × 10ᵏ that reaches `v`, so axis maxima read as round numbers; 1 for v ≤ 0. */
export function nice(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  if (p >= v) return p;
  if (2 * p >= v) return 2 * p;
  if (5 * p >= v) return 5 * p;
  return 10 * p;
}

/**
 * Catmull-Rom control points as a smooth cubic Bézier path. With `bounds`, a control point never leaves the
 * plot: the raw spline overshoots past the top or under the baseline right before a sudden rise or after a
 * spike, which read as the chart leaving its frame.
 */
export function spline(points: readonly Point[], bounds?: PlotBounds): string {
  const clampY = (y: number): number =>
    bounds === undefined ? y : Math.min(bounds.bottom, Math.max(bounds.top, y));
  const first = points[0];
  if (first === undefined) return "";
  let d = `M${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i] ?? first;
    const p1 = points[i] ?? first;
    const p2 = points[i + 1] ?? first;
    const p3 = points[i + 2] ?? p2;
    d +=
      `C${(p1.x + (p2.x - p0.x) / 6).toFixed(1)} ${clampY(p1.y + (p2.y - p0.y) / 6).toFixed(1)}` +
      ` ${(p2.x - (p3.x - p1.x) / 6).toFixed(1)} ${clampY(p2.y - (p3.y - p1.y) / 6).toFixed(1)}` +
      ` ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/** What the chart shows: the series, its size, its labels and how a hovered bin explains itself. */
export type AreaChartProps = {
  series: readonly ChartSeries[];
  /** The chart's aria-label, for the screen-reader picture of it */
  label?: string | undefined;
  /** Height in svg px (220); the width comes from the box, or `w` until the box has one (600) */
  h?: number | undefined;
  w?: number | undefined;
  /** The centred text for an all-zero window; "No data yet" otherwise */
  note?: string | undefined;
  /** How a y grid value prints; the plain number otherwise */
  yfmt?: ((v: number) => string) | undefined;
  /** The x labels, spread over the bins: index 0 hugs the left, the last the right */
  axis?: readonly string[] | undefined;
  /** The tooltip's rows for a hovered bin; the bin index otherwise */
  tip?: ((i: number) => readonly string[]) | undefined;
  class?: string | undefined;
};

const MARGIN = { left: 38, right: 10, top: 10, bottom: 18 } as const;
const QUARTERS = [0.25, 0.5, 0.75, 1] as const;

/** One grid row: a dashed line at a quarter of the range and its printed value on the left. */
function GridRow({
  f,
  y,
  left,
  width,
  text,
}: {
  f: number;
  y: number;
  left: number;
  width: number;
  text: string;
}): VNode {
  return (
    <g key={f}>
      <line class="hr-chart-grid" x1={left} x2={left + width} y1={y} y2={y} />
      <text class="hr-chart-axis" x={left - 6} y={y + 3} text-anchor="end">
        {text}
      </text>
    </g>
  );
}

/** One series: the gradient or tinted fill under its line and the line itself — or a lone dot for a single bin. */
function SeriesShape({
  tint,
  first,
  pts,
  baseline,
}: {
  tint: string | undefined;
  first: boolean;
  pts: readonly Point[];
  baseline: number;
}): VNode {
  const from = pts[0];
  const last = pts.at(-1);
  if (from === undefined || last === undefined) return <g />;
  // a single bin has no line to draw: the lone dot stands for the whole series
  const line = pts.length < 2 ? "" : spline(pts, { top: MARGIN.top, bottom: baseline });
  if (line === "") {
    return (
      <circle
        cx={from.x}
        cy={from.y}
        r={3}
        style="fill:var(--primary);stroke:var(--panel);stroke-width:1.5"
      />
    );
  }
  return (
    <g>
      <path
        class={`hr-chart-fill${first ? " grad" : ""}${tint ? ` ${tint}` : ""}`}
        d={`${line}L${last.x.toFixed(1)} ${baseline}L${from.x.toFixed(1)} ${baseline}Z`}
      />
      <path class={`hr-chart-line${tint ? ` ${tint}` : ""}`} d={line} />
    </g>
  );
}

/**
 * The area chart. The svg takes the width of its box (`w` until the box has one) and `h` its height;
 * hovering a bin shows the crosshair, a dot per series and the tooltip's rows.
 */
export function AreaChart(props: AreaChartProps): JSX.Element {
  const { series, label, note, yfmt, axis, tip, class: c } = props;
  const h = props.h ?? 220;
  const svg = useRef<SVGSVGElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => props.w ?? 600);
  const [hover, setHover] = useState<number | null>(null);

  // the box decides the width; a chart that mounts before its box has one keeps `w`
  useEffect(() => {
    const cw = svg.current?.clientWidth ?? 0;
    if (cw > 0) setWidth(cw);
  }, []);

  const W = width;
  const { left: L, top: T } = MARGIN;
  const iw = Math.max(10, W - L - MARGIN.right);
  const ih = Math.max(10, h - T - MARGIN.bottom);
  const n = Math.max(1, ...series.map((s) => s.values.length));
  const xAt = (i: number): number => L + (n > 1 ? (i * iw) / (n - 1) : iw / 2);
  const ymax = nice(Math.max(1, ...series.flatMap((s) => s.values.map(Number))));
  const yOf = (v: number): number => T + ih * (1 - Math.min(Number(v) || 0, ymax) / ymax);
  const total = series.reduce((a, s) => a + s.values.reduce((x2, y2) => x2 + Number(y2), 0), 0);
  const empty = total <= 0;

  // the tooltip hugs the crosshair: right of it, above the first series' dot, never outside the chart
  useLayoutEffect(() => {
    const el = tipEl.current;
    if (!el || hover === null) return;
    const r = svg.current?.getBoundingClientRect();
    const v0 = series[0]?.values[hover];
    const py = v0 === undefined ? T : yOf(v0);
    el.style.left = `${Math.max(0, Math.min((r?.width ?? 0) - el.offsetWidth - 2, xAt(hover) + 12))}px`;
    el.style.top = `${Math.max(0, py - el.offsetHeight - 10)}px`;
    // the geometry the tip hangs on moves with the data; only a new hover needs a new pin
  }, [hover]);

  const onMove = (e: TargetedPointerEvent<SVGSVGElement>): void => {
    if (empty) return;
    const r = e.currentTarget.getBoundingClientRect();
    const step = n > 1 ? iw / (n - 1) : iw;
    setHover(Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - L) / step))));
  };

  return (
    <div class="relative">
      <svg
        ref={svg}
        class={c}
        width={W}
        height={h}
        viewBox={`0 0 ${W} ${h}`}
        role={label ? "img" : undefined}
        aria-label={label}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {QUARTERS.map((f) => (
          <GridRow
            key={f}
            f={f}
            y={T + ih * (1 - f)}
            left={L}
            width={iw}
            text={(yfmt ?? String)(+(ymax * f).toFixed(2))}
          />
        ))}
        {(axis ?? []).map((s, i) => (
          <text
            class="hr-chart-axis"
            key={`${i} ${s}`}
            x={xAt(i)}
            y={h - 4}
            text-anchor={i <= 0 ? "start" : i >= n - 1 ? "end" : "middle"}
          >
            {s}
          </text>
        ))}
        {empty ? (
          <text class="hr-chart-axis" x={W / 2} y={T + ih / 2} text-anchor="middle">
            {note ?? "No data yet"}
          </text>
        ) : (
          <g>
            <defs>
              <linearGradient id="hr-chart-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style="stop-color:var(--primary);stop-opacity:0.25" />
                <stop offset="1" style="stop-color:var(--primary);stop-opacity:0" />
              </linearGradient>
            </defs>
            {series.map((sr, si) => (
              <SeriesShape
                key={si}
                tint={sr.tint}
                first={si === 0}
                pts={sr.values.map((v, i) => ({ x: xAt(i), y: yOf(v) }))}
                baseline={T + ih}
              />
            ))}
            {hover !== null ? (
              <g>
                <line class="hr-chart-cross" x1={xAt(hover)} x2={xAt(hover)} y1={T} y2={T + ih} />
                {series.map((sr, si) => (
                  <circle
                    key={si}
                    r={3.5}
                    cx={xAt(hover).toFixed(1)}
                    cy={yOf(sr.values[hover] ?? 0).toFixed(1)}
                    style="stroke:var(--panel);stroke-width:1.5"
                  />
                ))}
              </g>
            ) : null}
          </g>
        )}
      </svg>
      {hover !== null && !empty ? (
        <div ref={tipEl} class="hr-chart-tip absolute z-10">
          {(tip ? tip(hover) : [String(hover)]).map((row, ri) => (
            <p key={`${ri} ${row}`} class={ri === 0 ? "text-faint" : undefined}>
              {row}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
