/**
 * Chart geometry as pure math, shared by the Preact charts. Series go through Catmull-Rom → cubic Bézier so
 * the line is smooth without overshooting negative. No external chart library — everything here is plain
 * arithmetic; app/Chart.tsx turns it into svg.
 */

import type { RequestRecord, Tokens } from "../shared/model.ts";
import { stampOf } from "../shared/time-range.ts";
import { TOKEN_KINDS } from "./palette.ts";

export type Point = { x: number; y: number };

/** The same count over an explicit window: index 0 is `from`, the window's right edge
 *  clamps into the last bucket, and a degenerate window reads as all zeros. */
export function bucketizeRange(
  requests: RequestRecord[],
  from: number,
  to: number,
  buckets = 60,
  pick: (r: RequestRecord) => number = () => 1,
): number[] {
  const values = new Array<number>(buckets).fill(0);
  const width = (to - from) / buckets;
  if (!(width > 0)) return values;
  for (const request of requests) {
    if (request.ts < from || request.ts > to) continue;
    const index = Math.min(buckets - 1, Math.floor((request.ts - from) / width));
    values[index] = (values[index] ?? 0) + pick(request);
  }
  return values;
}

/** Per-bucket token kinds over an explicit window, in TOKEN_KINDS order (input, output, cache r/w). */
export function bucketizeTokenKindsRange(
  requests: RequestRecord[],
  from: number,
  to: number,
  buckets = 60,
): number[][] {
  return TOKEN_KINDS.map((kind) =>
    bucketizeRange(requests, from, to, buckets, (r) => r.tokens[kind.key as keyof Tokens] ?? 0),
  );
}

/** Share of prompt tokens served from cache: cache reads over everything the model read. */
export function cacheHitRate(tokens: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null {
  const read = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return read === 0 ? null : tokens.cacheRead / read;
}

/** A span in compact words: "45 s", "5 min", "3 h", "7 d" — the axis and tooltip's time grammar. */
export function spanWord(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

/** How far back an open-ended window reaches, in words: minutes under the hour, hours under two days
 *  ("24 h" reads better than "1 d"), days beyond. */
export function agoWord(ms: number): string {
  if (ms < 3_600_000 || ms >= 48 * 3_600_000) return spanWord(ms);
  return `${Math.round(ms / 3_600_000)} h`;
}

/** The x-axis labels a chart carries for its resolved window: how far back (or the start's stamp) at the left
 *  edge, the end (or "now") at the right, and the midpoint once the span is long enough to read it. */
export function windowLabels(from: number, to: number, now: number): ChartLabel[] {
  const span = to - from;
  if (!(span > 0)) return [];
  const endsNow = to >= now;
  const marks: ChartLabel[] = [
    { text: endsNow ? `${agoWord(span)} ago` : stampOf(from, new Date(now).getFullYear()), at: 0 },
    { text: endsNow ? "now" : stampOf(to, new Date(now).getFullYear()), at: 1 },
  ];
  if (span >= 6 * 3_600_000) {
    const middle = endsNow ? agoWord(span / 2) : stampOf(from + span / 2, new Date(now).getFullYear());
    marks.splice(1, 0, { text: middle, at: 0.5 });
  }
  return marks;
}

/** The y range a chart may draw in: the headroom top, the baseline at the bottom edge. */
export type PlotBounds = { top: number; bottom: number };

/** Headroom above the tallest value, in svg units. */
const PLOT_TOP = 4;

/** The plot's y bounds for a frame of this height. */
export function plotBounds(height: number): PlotBounds {
  return { top: PLOT_TOP, bottom: height };
}

/**
 * Catmull-Rom control points converted to a smooth cubic Bézier path. With `bounds`, control-point y values
 * are clamped to the plot: the raw spline overshoots past the top or under the baseline right before a sudden
 * rise, which read as the chart leaving its frame.
 */
export function catmullRomPath(points: Point[], bounds?: PlotBounds): string {
  const clampY = (y: number): number =>
    bounds === undefined ? y : Math.min(bounds.bottom, Math.max(bounds.top, y));
  if (points.length === 0) return "";
  if (points.length === 1) {
    const only = points[0] as Point;
    return `M ${only.x.toFixed(1)} ${only.y.toFixed(1)}`;
  }
  const first = points[0] as Point;
  let d = `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) continue;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

export type ChartLabel = { text: string; at: number };

export type Frame = {
  width: number;
  height: number;
  /** x-axis labels pinned to fractions of the width (0 = left edge, 1 = right edge) */
  xLabels?: ChartLabel[];
  /** y-axis top label (the max); hidden when null */
  yLabel?: string | null;
};

export type ChartOptions = Frame & {
  values: number[];
  color: string;
  /** unique id for the gradient definition (two charts on a page need different ids) */
  gradientId: string;
};

export type StackedOptions = Frame & {
  /** bottom-to-top series; a band counts as 0 wherever it has no value */
  series: { values: number[]; color: string }[];
};

/** Vertical position of a value: 3px headroom at the top, the baseline at the bottom edge. */
export function scaleY(value: number, max: number, height: number): number {
  return height - (value / max) * (height - 4);
}

/** A path that walks `points` backwards, continuing the current subpath (its leading M becomes an L). */
export function reversedContinuation(points: Point[], bounds: PlotBounds): string {
  const path = catmullRomPath([...points].reverse(), bounds);
  return path === "" ? "" : `L${path.slice(1)}`;
}

/** Index of the bucket a pointer x falls in, or null when outside. */
export function nearestIndex(values: number[], x: number, width: number): number | null {
  if (values.length === 0 || width <= 0) return null;
  const step = width / values.length;
  const index = Math.floor(x / step);
  if (index < 0 || index >= values.length) return null;
  return index;
}
