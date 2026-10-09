import { describe, expect, it } from "vitest";
import { type RequestRecord, ZERO_TOKENS } from "../src/shared/model.ts";
import {
  agoWord,
  bucketizeRange,
  bucketizeTokenKindsRange,
  cacheHitRate,
  catmullRomPath,
  nearestIndex,
  spanWord,
  windowLabels,
} from "../src/ui/chart.ts";
import { makeRequest } from "./helpers.ts";

const NOW = 300_000; // a 5m window that starts at ts 0

function req(ts: number, output = 0): RequestRecord {
  return makeRequest({ ts, tokens: { ...ZERO_TOKENS, output } });
}

describe("catmullRomPath", () => {
  it("degrades to nothing or a single move for empty and single-point series", () => {
    expect(catmullRomPath([])).toBe("");
    expect(catmullRomPath([{ x: 10, y: 20 }])).toBe("M 10.0 20.0");
  });

  it("draws one smooth segment for two points", () => {
    const d = catmullRomPath([
      { x: 0, y: 10 },
      { x: 30, y: 4 },
    ]);
    expect(d).toBe("M 0.0 10.0 C 5.0 9.0, 25.0 5.0, 30.0 4.0");
  });

  it("clamps the phantom end points so edges stay inside the series", () => {
    const d = catmullRomPath([
      { x: 0, y: 39 },
      { x: 100, y: 0 },
      { x: 200, y: 39 },
    ]);
    expect(d).toBe("M 0.0 39.0 C 16.7 32.5, 66.7 0.0, 100.0 0.0 C 133.3 0.0, 183.3 32.5, 200.0 39.0");
  });

  it("keeps every y inside the plot when the series jumps, so the spline cannot overshoot", () => {
    const top = 4;
    const baseline = 100;
    // the same points an area chart draws: [0, 0, 0, 0, 100] over a plot of height 100
    const points = [0, 0, 0, 0, 100].map((value, index) => ({
      x: index * 50,
      y: baseline - (value / 100) * (baseline - top),
    }));
    const d = catmullRomPath(points, { top, bottom: baseline });
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?/g)]
      .map((match) => Number(match[0]))
      .filter((_, index) => index % 2 === 1);
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) {
      expect(y, d).toBeGreaterThanOrEqual(top);
      expect(y, d).toBeLessThanOrEqual(baseline);
    }
  });
});

describe("bucketizeTokenKindsRange", () => {
  it("splits tokens into the four kind series over the explicit window", () => {
    const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const series = bucketizeTokenKindsRange(
      [makeRequest({ ts: 0, tokens }), makeRequest({ ts: 10, tokens })],
      0,
      NOW,
    );
    expect(series).toHaveLength(4);
    expect(series.map((values) => values[0])).toEqual([2, 4, 6, 8]);
    expect(series.every((values) => values.length === 60)).toBe(true);
  });
});

describe("bucketizeRange", () => {
  it("counts per bucket over an explicit window and clamps its right edge into the last bucket", () => {
    const values = bucketizeRange([req(0), req(7_499), req(299_999), req(NOW)], 0, NOW, 60);
    expect(values).toHaveLength(60);
    expect(values[0]).toBe(1);
    expect(values[1]).toBe(1); // 7_499 sits in the second 5s bucket
    expect(values[59]).toBe(2); // 299_999 and the clamped edge both land in the last bucket
    expect(values.slice(2, 59).every((value) => value === 0)).toBe(true);
  });

  it("drops requests outside [from, to] entirely", () => {
    const values = bucketizeRange([req(-1), req(NOW + 1)], 0, NOW, 60);
    expect(values.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("sums a picked metric over any bucket count", () => {
    const counted = bucketizeRange([req(0, 4), req(1_000, 6)], 0, NOW, 60, (r) => r.tokens.output);
    expect(counted[0]).toBe(10);
    const halved = bucketizeRange([req(100_000), req(200_000)], 0, NOW, 2);
    expect(halved).toEqual([1, 1]);
  });

  it("reads a degenerate window as all zeros instead of dividing by zero", () => {
    expect(bucketizeRange([req(5)], 5, 5, 3)).toEqual([0, 0, 0]);
  });
});

describe("bucketizeTokenKindsRange", () => {
  it("splits tokens into the four kind series over the explicit window", () => {
    const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const series = bucketizeTokenKindsRange(
      [makeRequest({ ts: 0, tokens }), makeRequest({ ts: 10, tokens })],
      0,
      NOW,
    );
    expect(series).toHaveLength(4);
    expect(series.map((values) => values[0])).toEqual([2, 4, 6, 8]);
    expect(series.every((values) => values.length === 60)).toBe(true);
  });
});

describe("nearestIndex", () => {
  it("maps a pointer x to its bucket, null outside", () => {
    expect(nearestIndex([], 10, 200)).toBeNull();
    expect(nearestIndex([1, 2, 3, 4], 10, 0)).toBeNull();
    expect(nearestIndex([1, 2, 3, 4], 0, 200)).toBe(0);
    expect(nearestIndex([1, 2, 3, 4], 49, 200)).toBe(0);
    expect(nearestIndex([1, 2, 3, 4], 50, 200)).toBe(1);
    expect(nearestIndex([1, 2, 3, 4], 199, 200)).toBe(3);
    expect(nearestIndex([1, 2, 3, 4], 200, 200)).toBeNull();
    expect(nearestIndex([1, 2, 3, 4], -1, 200)).toBeNull();
  });
});

/* ------------------------------- window helpers ------------------------------ */

describe("spanWord", () => {
  it("reads a span in compact words, rounding to the unit", () => {
    expect(spanWord(45_000)).toBe("45 s");
    expect(spanWord(300_000)).toBe("5 min");
    expect(spanWord(10_800_000)).toBe("3 h");
    expect(spanWord(604_800_000)).toBe("7 d");
  });

  it("never rounds a short span below one second", () => {
    expect(spanWord(400)).toBe("1 s");
  });
});

describe("agoWord", () => {
  it("uses minutes under the hour, hours under two days, days beyond", () => {
    expect(agoWord(300_000)).toBe("5 min");
    expect(agoWord(3_600_000)).toBe("1 h");
    expect(agoWord(86_400_000)).toBe("24 h");
    expect(agoWord(3 * 86_400_000)).toBe("3 d");
  });
});

describe("windowLabels", () => {
  it("marks an open-ended window by how far back it reaches, ending at now", () => {
    expect(windowLabels(NOW - 300_000, NOW, NOW).map((label) => label.text)).toEqual(["5 min ago", "now"]);
  });

  it("adds the midpoint to long spans", () => {
    const marks = windowLabels(NOW - 86_400_000, NOW, NOW);
    expect(marks.map((label) => label.text)).toEqual(["24 h ago", "12 h", "now"]);
    expect(marks.map((label) => label.at)).toEqual([0, 0.5, 1]);
  });

  it("stamps a fixed window's ends and its midpoint", () => {
    const year = new Date(NOW).getFullYear();
    const at = (month: number, day: number, hour: number, minute: number): number =>
      new Date(year, month, day, hour, minute).getTime();
    const from = at(9, 6, 14, 0);
    const to = at(9, 6, 20, 0);
    expect(windowLabels(from, to, to + 60_000).map((label) => label.text)).toEqual([
      "6 Oct 14:00",
      "6 Oct 17:00",
      "6 Oct 20:00",
    ]);
  });

  it("draws nothing for a degenerate window", () => {
    expect(windowLabels(NOW, NOW, NOW)).toEqual([]);
  });
});

describe("cacheHitRate", () => {
  it("computes the cache hit rate over everything the model read", () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitRate({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(0.8);
  });
});
