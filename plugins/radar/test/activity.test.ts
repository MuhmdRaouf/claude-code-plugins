import { describe, expect, it } from "vitest";
import { ACTIVITY_BUCKETS, ACTIVITY_LIVE_BUCKET_MS, ACTIVITY_LIVE_MS } from "../src/shared/model.ts";
import { activityFromRows, activityOf, emptyActivity } from "../src/store/activity.ts";

const NOW = 1_800_000_000_000;

describe("activityOf", () => {
  it("spans a live session's last 15 minutes in 18,750 ms buckets ending now", () => {
    const start = NOW - ACTIVITY_LIVE_MS;
    const activity = activityOf(
      [
        { ts: start + 10, model: "glm-5.3" },
        { ts: NOW - 100, model: "glm-5.3" },
        { ts: NOW - 100, model: "claude-opus-5-5" },
        { ts: start - 5_000, model: "glm-5.3" }, // older than the window clamps into the first bucket
      ],
      { live: true, start: start - 5_000, last: NOW - 100, now: NOW },
    );
    expect(activity.bucketMs).toBe(ACTIVITY_LIVE_BUCKET_MS);
    expect(activity.counts[0]).toBe(2);
    expect(activity.counts[47]).toBe(2);
    expect(activity.models[0]).toBe("glm-5.3");
    expect(activity.models[47]).toBe("claude-opus-5-5"); // a tie reads alphabetically
    expect(activity.counts.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("stretches an ended session from its start to its last activity over the same 48 buckets", () => {
    const start = NOW - 4_800_000; // an 80-minute run: 100,000 ms per bucket
    const activity = activityOf(
      [
        { ts: start + 50_000, model: "glm-5.3" },
        { ts: start + 150_000, model: "claude-sonnet-5-5" },
        { ts: start + 199_999, model: "glm-5.3" },
        { ts: NOW, model: "claude-sonnet-5-5" }, // the last activity clamps into bucket 47
      ],
      { live: false, start, last: NOW, now: NOW },
    );
    expect(activity.bucketMs).toBe(100_000);
    expect(activity.counts[0]).toBe(1);
    expect(activity.counts[1]).toBe(2);
    expect(activity.models[1]).toBe("claude-sonnet-5-5"); // the most-seen model, ties alphabetical
    expect(activity.counts[47]).toBe(1);
    expect(activity.counts).toHaveLength(ACTIVITY_BUCKETS);
  });

  it("falls back to the live window when an ended session never recorded its start", () => {
    const activity = activityOf([{ ts: NOW, model: "glm-5.3" }], {
      live: false,
      start: null,
      last: NOW,
      now: NOW,
    });
    expect(activity.bucketMs).toBe(ACTIVITY_LIVE_BUCKET_MS);
    expect(activity.counts[47]).toBe(1);
  });

  it("keeps a span-less session in one bucket and leaves every bucket nameless when empty", () => {
    const single = activityOf([{ ts: NOW, model: "glm-5.3" }], {
      live: false,
      start: NOW,
      last: NOW,
      now: NOW,
    });
    expect(single.bucketMs).toBe(1);
    expect(single.counts[0]).toBe(1);
    expect(single.models[0]).toBe("glm-5.3");
    const none = activityOf([], { live: false, start: NOW, last: NOW, now: NOW });
    expect(none.counts.every((count) => count === 0)).toBe(true);
    expect(none.models.every((model) => model === "")).toBe(true);
  });
});

describe("activityFromRows", () => {
  it("assembles grouped rows, clamping stray buckets and skipping unnamed models", () => {
    const activity = activityFromRows(
      [
        { bucket: -3, model: "glm-5.3", c: 2 },
        { bucket: 99, model: null, c: 1 },
        { bucket: 5, model: "a", c: 1 },
        { bucket: 5, model: "b", c: 2 },
        { bucket: 5, model: "", c: 1 },
      ],
      1_000,
    );
    expect(activity.bucketMs).toBe(1_000);
    expect(activity.counts[0]).toBe(2);
    expect(activity.counts[5]).toBe(4);
    expect(activity.counts[47]).toBe(1);
    expect(activity.models[5]).toBe("b");
    expect(activity.models[0]).toBe("glm-5.3");
    expect(activity.models[47]).toBe(""); // a bucket only null models name stays nameless
  });
});

describe("emptyActivity", () => {
  it("is 48 silent buckets at the bucket size given", () => {
    const empty = emptyActivity(18_750);
    expect(empty).toEqual({
      bucketMs: 18_750,
      counts: new Array<number>(ACTIVITY_BUCKETS).fill(0),
      models: new Array<string>(ACTIVITY_BUCKETS).fill(""),
    });
  });
});
