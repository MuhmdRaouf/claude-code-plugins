/**
 * The one memorable element: a session's request activity as 48 slim bars — height is how busy the bucket
 * was, colour is the model that made most of its requests. Live cards show the last 15 minutes, history
 * cards the session's whole life; the data slice hands either one over with the same shape.
 */

import { modelColor } from "@muhmdraouf/ui/model-color.ts";
import { ACTIVITY_BUCKETS, type Activity } from "../../shared/model.ts";
import { fmtCount } from "../fmt.ts";

/** Each bucket owns a 3px bar and a 1px gap; the svg stretches to the card's width. The rail's card
 *  asks for the 1.5rem strip with `height`; the default keeps the compact 20px the cards draw today. */
const BAR = 3;
const STEP = 4;
export const STRIP_HEIGHT = 20;
const MIN_BAR = 2;

/** One model's share of an activity window: its winning buckets, counted. */
export type ModelShare = { model: string; requests: number };

/** Requests per model from the buckets: each bucket counts toward its winning model, busiest first. */
export function modelShares(activity: Activity): ModelShare[] {
  const counts = new Map<string, number>();
  for (const [bucket, model] of activity.models.entries()) {
    if (model === "") continue;
    counts.set(model, (counts.get(model) ?? 0) + (activity.counts[bucket] ?? 0));
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, requests]) => ({ model, requests }));
}

export type StripBar = {
  x: number;
  width: number;
  /** Top offset and height of the bar; an empty bucket is the 1px baseline. */
  y: number;
  height: number;
  fill: string;
  baseline: boolean;
};

/** One bar per bucket, oldest first: height by the bucket's share of the busiest one, 2px at least. */
export function stripBars(activity: Activity, height = STRIP_HEIGHT): StripBar[] {
  const counts = activity.counts.slice(0, ACTIVITY_BUCKETS);
  const peak = Math.max(0, ...counts);
  return Array.from({ length: ACTIVITY_BUCKETS }, (_, bucket) => {
    const count = counts[bucket] ?? 0;
    const bar = count <= 0 || peak <= 0 ? 0 : Math.max(MIN_BAR, Math.round((count / peak) * height));
    return {
      x: bucket * STEP,
      width: BAR,
      y: bar > 0 ? height - bar : height - 1,
      height: bar > 0 ? bar : 1,
      fill: bar > 0 ? modelColor(activity.models[bucket] ?? "") : "var(--color-base-content)",
      baseline: bar <= 0,
    };
  });
}

/** Every bucket's requests together: what the strip's label says. */
export function activityTotal(activity: Activity): number {
  return activity.counts.slice(0, ACTIVITY_BUCKETS).reduce((sum, count) => sum + count, 0);
}

/** The activity strip: an svg image, named for the reader who cannot see it. The svg carries no
 *  `block` class on purpose: legacy.css's `.block` (the inspector's stored sides) would draw its
 *  faint rounded outline around the bars; the stylesheet's own svg rule already blockifies it. */
export function ActivityStrip({
  activity,
  window: where,
  height = STRIP_HEIGHT,
}: {
  activity: Activity;
  window: string;
  /** the svg's height; the rail's card draws it 1.5rem tall */
  height?: number;
}) {
  return (
    <svg
      role="img"
      aria-label={`Activity: ${fmtCount(activityTotal(activity), "request")} ${where}`}
      viewBox={`0 0 ${ACTIVITY_BUCKETS * STEP - 1} ${height}`}
      preserveAspectRatio="none"
      class="w-full"
      style={{ height: `${height}px` }}
    >
      {stripBars(activity, height).map((bar, bucket) => (
        <rect
          key={bucket}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          fill={bar.fill}
          fill-opacity={bar.baseline ? 0.1 : undefined}
        />
      ))}
    </svg>
  );
}
