/**
 * Chart geometry as pure math plus tiny svg node trees. Series go through Catmull-Rom → cubic Bézier so the
 * line is smooth without overshooting negative; the fill is a fading gradient; gridlines are muted hairlines.
 * No external chart library — everything here is plain arithmetic.
 */

import type { RequestRecord, Tokens } from "../shared/model.ts";
import { RANGE_MS, type Range, TOKEN_KINDS } from "./palette.ts";
import { el, type UINode } from "./types.ts";

export type Point = { x: number; y: number };

/** Sum a metric per bucket over the window ending at `now`; index 0 is the oldest bucket. */
export function bucketizeRequests(
  requests: RequestRecord[],
  range: Range,
  now: number,
  pick: (r: RequestRecord) => number = () => 1,
  buckets = 60,
): number[] {
  const windowMs = RANGE_MS[range];
  const start = now - windowMs;
  const width = windowMs / buckets;
  const values = new Array<number>(buckets).fill(0);
  for (const request of requests) {
    if (request.ts < start || request.ts > now) continue;
    const index = Math.min(buckets - 1, Math.floor((request.ts - start) / width));
    values[index] = (values[index] ?? 0) + pick(request);
  }
  return values;
}

/** Per-bucket totals of each token kind over the window, in TOKEN_KINDS order (input, output, cache r/w). */
export function bucketizeTokenKinds(
  requests: RequestRecord[],
  range: Range,
  now: number,
  buckets = 60,
): number[][] {
  return TOKEN_KINDS.map((kind) =>
    bucketizeRequests(requests, range, now, (r) => r.tokens[kind.key as keyof Tokens], buckets),
  );
}

/** Catmull-Rom control points converted to a smooth cubic Bézier path. */
export function catmullRomPath(points: Point[]): string {
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
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
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

/** Vertical position of a value: 3px headroom at the top, the baseline at the bottom edge. */
function scaleY(value: number, max: number, height: number): number {
  return height - (value / max) * (height - 4);
}

/** Muted horizontal gridlines at quarters plus a firmer baseline. */
function gridlines(width: number, height: number): UINode[] {
  return [0, 0.25, 0.5, 0.75].map((fraction) => {
    const y = fraction === 0 ? height - 0.5 : scaleY(fraction, 1, height) + 0.5;
    return {
      tag: "line",
      cls: fraction === 0 ? "chart-axis" : "chart-grid",
      attrs: { x1: "0", x2: String(width), y1: y.toFixed(1), y2: y.toFixed(1) },
    };
  });
}

/**
 * The plot svg stretches to its box (preserveAspectRatio none, non-scaling strokes), so the axis labels live
 * outside it as plain text that never distorts: the max above-left, time marks along the bottom.
 */
function framed(frame: Frame, plot: UINode[], defs: UINode[] = []): UINode {
  const svg: UINode = {
    tag: "svg",
    cls: "chart",
    attrs: {
      viewBox: `0 0 ${frame.width} ${frame.height}`,
      width: "100%",
      height: String(frame.height),
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    },
    children: [...defs, ...gridlines(frame.width, frame.height), ...plot],
  };
  const children: UINode[] = [];
  if (frame.yLabel !== null && frame.yLabel !== undefined) {
    children.push({ tag: "span", cls: "chart-ymax", text: frame.yLabel });
  }
  children.push(svg);
  const marks = frame.xLabels ?? [];
  if (marks.length > 0) {
    children.push(
      el(
        "div",
        "chart-x",
        marks.map(
          (mark): UINode => ({
            tag: "span",
            cls: mark.at <= 0 ? "chart-mark mark-start" : mark.at >= 1 ? "chart-mark mark-end" : "chart-mark",
            text: mark.text,
            attrs: { style: `left:${(mark.at * 100).toFixed(1)}%` },
          }),
        ),
      ),
    );
  }
  return el("div", "chart-frame", children);
}

/** An area chart: muted gridlines, smooth line, gradient fill. All svg geometry, labels outside. */
export function areaChart(options: ChartOptions): UINode {
  const { values, width, height, color, gradientId } = options;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points: Point[] = values.map((value, index) => ({ x: index * step, y: scaleY(value, max, height) }));
  const line = catmullRomPath(points);
  const area = line === "" ? "" : `${line} L ${width} ${height} L 0 ${height} Z`;
  const gradient: UINode = {
    tag: "defs",
    children: [
      {
        tag: "linearGradient",
        attrs: { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" },
        children: [
          { tag: "stop", attrs: { offset: "0%", "stop-color": color, "stop-opacity": "0.3" } },
          { tag: "stop", attrs: { offset: "100%", "stop-color": color, "stop-opacity": "0" } },
        ],
      },
    ],
  };
  return framed(
    options,
    [
      { tag: "path", d: area, attrs: { fill: `url(#${gradientId})` } },
      { tag: "path", d: line, cls: "chart-line", attrs: { stroke: color } },
    ],
    [gradient],
  );
}

export type StackedOptions = Frame & {
  /** bottom-to-top series; every values array has the same length */
  series: { values: number[]; color: string }[];
};

/** A path that walks `points` backwards, continuing the current subpath (its leading M becomes an L). */
function reversedContinuation(points: Point[]): string {
  const path = catmullRomPath([...points].reverse());
  return path === "" ? "" : `L${path.slice(1)}`;
}

/**
 * Stacked areas: each band sits on the running total of the bands below it, with a smooth top edge, a
 * translucent fill and a crisp stroke. Same frame, gridlines and labels as areaChart.
 */
export function stackedAreaChart(options: StackedOptions): UINode {
  const { series, width, height } = options;
  const length = series[0]?.values.length ?? 0;
  const totals = Array.from({ length }, (_, index) =>
    series.reduce((acc, band) => acc + (band.values[index] ?? 0), 0),
  );
  const max = Math.max(...totals, 1);
  const step = length > 1 ? width / (length - 1) : 0;
  const running = new Array<number>(length).fill(0);
  let below: Point[] = running.map((_, index) => ({ x: index * step, y: height }));
  const bands: UINode[] = [];
  const lines: UINode[] = [];
  for (const band of series) {
    band.values.forEach((value, index) => {
      running[index] = (running[index] ?? 0) + value;
    });
    const top: Point[] = running.map((value, index) => ({ x: index * step, y: scaleY(value, max, height) }));
    const edge = catmullRomPath(top);
    if (edge !== "") {
      bands.push({
        tag: "path",
        cls: "chart-band",
        d: `${edge} ${reversedContinuation(below)} Z`,
        attrs: { fill: band.color },
      });
      lines.push({ tag: "path", cls: "chart-line", d: edge, attrs: { stroke: band.color } });
    }
    below = top;
  }
  return framed(options, [...bands, ...lines]);
}

/** Index of the bucket a pointer x falls in, or null when outside. */
export function nearestIndex(values: number[], x: number, width: number): number | null {
  if (values.length === 0 || width <= 0) return null;
  const step = width / values.length;
  const index = Math.floor(x / step);
  if (index < 0 || index >= values.length) return null;
  return index;
}

/** One horizontal stacked bar as plain divs (models tab); segments are proportional to the max. */
export function stackedBar(segments: { value: number; color: string }[], max: number): UINode {
  const children: UINode[] = [];
  for (const segment of segments) {
    const share = max > 0 ? Math.min(100, (segment.value / max) * 100) : 0;
    if (share <= 0) continue;
    children.push({
      tag: "div",
      cls: "bar-seg",
      attrs: { style: `width:${share.toFixed(2)}%;background:${segment.color}` },
    });
  }
  return el("div", "bar-track", children.length === 0 ? [el("div", "bar-empty")] : children);
}
