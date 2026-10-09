/**
 * The charts as Preact components. The geometry is chart.ts's pure math; this file draws the same svg the
 * legacy node trees built: the frame, gridlines, gradient, stacked bands and the models-tab bar.
 */

import type { VNode } from "preact";
import {
  type ChartOptions,
  catmullRomPath,
  type Frame,
  type Point,
  plotBounds,
  reversedContinuation,
  type StackedOptions,
  scaleY,
} from "../chart.ts";

/** Muted horizontal gridlines at quarters plus a firmer baseline. */
function gridlines(width: number, height: number): VNode[] {
  return [0, 0.25, 0.5, 0.75].map((fraction) => {
    const y = fraction === 0 ? height - 0.5 : scaleY(fraction, 1, height) + 0.5;
    return (
      <line
        key={fraction}
        x1="0"
        x2={String(width)}
        y1={y.toFixed(1)}
        y2={y.toFixed(1)}
        class={fraction === 0 ? "chart-axis" : "chart-grid"}
      />
    );
  });
}

/**
 * The plot svg stretches to its box (preserveAspectRatio none, non-scaling strokes), so the axis labels live
 * outside it as plain text that never distorts: the max above-left, time marks along the bottom.
 */
function framed(frame: Frame, plot: VNode[], defs: VNode[] = []): VNode {
  const marks = frame.xLabels ?? [];
  return (
    <div class="chart-frame">
      {frame.yLabel !== null && frame.yLabel !== undefined ? (
        <span class="chart-ymax">{frame.yLabel}</span>
      ) : null}
      <svg
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        width="100%"
        height={String(frame.height)}
        preserveAspectRatio="none"
        aria-hidden="true"
        class="chart"
      >
        {[...defs, ...gridlines(frame.width, frame.height), ...plot]}
      </svg>
      {marks.length > 0 && (
        <div class="chart-x">
          {marks.map((mark) => (
            <span
              key={`${mark.at} ${mark.text}`}
              style={`left:${(mark.at * 100).toFixed(1)}%`}
              class={
                mark.at <= 0 ? "chart-mark mark-start" : mark.at >= 1 ? "chart-mark mark-end" : "chart-mark"
              }
            >
              {mark.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** An area chart: muted gridlines, smooth line, gradient fill. All svg geometry, labels outside. */
export function AreaChart(options: ChartOptions): VNode {
  const { values, width, height, color, gradientId } = options;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points: Point[] = values.map((value, index) => ({ x: index * step, y: scaleY(value, max, height) }));
  const line = catmullRomPath(points, plotBounds(height));
  const area = line === "" ? "" : `${line} L ${width} ${height} L 0 ${height} Z`;
  return framed(
    options,
    [<path fill={`url(#${gradientId})`} d={area} />, <path stroke={color} class="chart-line" d={line} />],
    [
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={color} stop-opacity="0.3" />
          <stop offset="100%" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>,
    ],
  );
}

/** Stacked areas: each band sits on the running total of the bands below it, with a smooth top edge, a
 * translucent fill and a crisp stroke. Same frame, gridlines and labels as AreaChart. */
export function StackedAreaChart(options: StackedOptions): VNode {
  const { series, width, height } = options;
  // the plot is as wide as the longest band; an empty leading band must not shrink it
  const length = series.reduce((longest, band) => Math.max(longest, band.values.length), 0);
  const totals = Array.from({ length }, (_, index) =>
    series.reduce((acc, band) => acc + (band.values[index] ?? 0), 0),
  );
  const max = Math.max(...totals, 1);
  const step = length > 1 ? width / (length - 1) : 0;
  const running = new Array<number>(length).fill(0);
  const bounds = plotBounds(height);
  let below: Point[] = running.map((_, index) => ({ x: index * step, y: height }));
  const bands: VNode[] = [];
  const lines: VNode[] = [];
  for (const band of series) {
    if (band.values.length === 0) continue; // nothing to draw, and it adds nothing to the stack
    band.values.forEach((value, index) => {
      running[index] = (running[index] ?? 0) + value; // missing values count as 0
    });
    const top: Point[] = running.map((value, index) => ({ x: index * step, y: scaleY(value, max, height) }));
    const edge = catmullRomPath(top, bounds);
    if (edge !== "") {
      bands.push(
        <path fill={band.color} class="chart-band" d={`${edge} ${reversedContinuation(below, bounds)} Z`} />,
      );
      lines.push(<path stroke={band.color} class="chart-line" d={edge} />);
    }
    below = top;
  }
  return framed(options, [...bands, ...lines]);
}

/** One segment of StackedBar: a measured value and its fill color. */
export type BarSegment = { value: number; color: string };

/** One horizontal stacked bar as plain divs (models tab); segments are proportional to the max. */
export function StackedBar({ segments, max }: { segments: BarSegment[]; max: number }): VNode {
  const children: VNode[] = [];
  for (const segment of segments) {
    const share = max > 0 ? Math.min(100, (segment.value / max) * 100) : 0;
    if (share <= 0) continue;
    children.push(<div style={`width:${share.toFixed(2)}%;background:${segment.color}`} class="bar-seg" />);
  }
  return <div class="bar-track">{children.length === 0 ? <div class="bar-empty" /> : children}</div>;
}
