/**
 * Per-session activity sparklines, pure and stateless: 48 buckets of request counts, each bucket naming
 * the model most seen in it. A live session's window is its last 15 minutes ending now (18,750 ms per
 * bucket); an ended session's window stretches from its start to its last activity, so a whole run fits
 * the same 48 buckets. The store computes these inside its cached session views; the history assembles
 * them from one grouped SQL query per tree with `activityFromRows`.
 */
import {
  ACTIVITY_BUCKETS,
  ACTIVITY_LIVE_BUCKET_MS,
  ACTIVITY_LIVE_MS,
  type Activity,
} from "../shared/model.ts";

/** One request as a sparkline reads it: when it happened and on what model. */
export type ActivityRequest = { ts: number; model: string };

/** The window one session's sparkline covers, decided by the caller (the store knows live from ended). */
export type ActivityWindow = {
  live: boolean;
  /** The session's first activity; null when nothing recorded it (the window falls back to 15 minutes). */
  start: number | null;
  /** The session's last activity, ending the window. */
  last: number;
  now: number;
};

/** One counted bucket of a grouped read: the bucket index, the model (null when unnamed), the requests. */
export type ActivityRow = { bucket: number; model: string | null; c: number };

/** The empty sparkline at a bucket size: zero requests everywhere, no model anywhere. */
export function emptyActivity(bucketMs: number): Activity {
  return {
    bucketMs,
    counts: new Array<number>(ACTIVITY_BUCKETS).fill(0),
    models: new Array<string>(ACTIVITY_BUCKETS).fill(""),
  };
}

/** The bucket a timestamp lands in, clamped so a boundary timestamp never falls off either end. */
export function bucketAt(ts: number, start: number, bucketMs: number): number {
  return Math.min(ACTIVITY_BUCKETS - 1, Math.max(0, Math.floor((ts - start) / bucketMs)));
}

/** The most-seen model of one bucket, ties broken alphabetically; "" when the bucket holds no named model. */
export function topModelOf(models: Map<string, number> | undefined): string {
  if (models === undefined) return "";
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of models) {
    if (count > bestCount || (count === bestCount && best !== null && model < best)) {
      best = model;
      bestCount = count;
    }
  }
  return best ?? "";
}

/** A bucket index a query produced, clamped into the sparkline (SQLite divides toward zero). */
function clampBucket(bucket: number): number {
  return Math.min(ACTIVITY_BUCKETS - 1, Math.max(0, Math.trunc(bucket)));
}

/** Grouped rows into a sparkline: whatever query produced them, the assembly is the same. */
export function activityFromRows(rows: Iterable<ActivityRow>, bucketMs: number): Activity {
  const activity = emptyActivity(bucketMs);
  const byBucket = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const at = clampBucket(row.bucket);
    activity.counts[at] = (activity.counts[at] ?? 0) + row.c;
    if (row.model === null || row.model === "") continue;
    const models = byBucket.get(at) ?? new Map<string, number>();
    models.set(row.model, (models.get(row.model) ?? 0) + row.c);
    byBucket.set(at, models);
  }
  for (let at = 0; at < ACTIVITY_BUCKETS; at += 1) activity.models[at] = topModelOf(byBucket.get(at));
  return activity;
}

/** One session's sparkline: 48 buckets over the window its live state names. */
export function activityOf(requests: ActivityRequest[], window: ActivityWindow): Activity {
  const start = window.live
    ? window.now - ACTIVITY_LIVE_MS
    : (window.start ?? window.last - ACTIVITY_LIVE_MS);
  const bucketMs = window.live
    ? ACTIVITY_LIVE_BUCKET_MS
    : Math.max(1, Math.ceil((window.last - start) / ACTIVITY_BUCKETS));
  const rows: ActivityRow[] = requests.map((request) => ({
    bucket: bucketAt(request.ts, start, bucketMs),
    model: request.model,
    c: 1,
  }));
  return activityFromRows(rows, bucketMs);
}
