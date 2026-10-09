import { describe, expect, it } from "vitest";
import {
  bucketPlan,
  DEFAULT_RANGE,
  MAX_BUCKETS,
  PRESETS,
  type Preset,
  parseRangeHash,
  rangeLabel,
  rangeToHash,
  resolveRange,
  type TimeRange,
} from "../../src/shared/time-range.ts";

const NOW = 1_800_000_000_000;

/** A local wall-clock timestamp, so the label tests never depend on the runner's zone offset. */
const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month, day, hour, minute).getTime();

const preset = (key: Preset): TimeRange => ({ preset: key, from: 0, to: null });
const custom = (from: number, to: number | null): TimeRange => ({ preset: null, from, to });

describe("PRESETS", () => {
  it("lists the picker's presets in display order, with their labels", () => {
    expect(PRESETS.map((entry) => entry.key)).toEqual(["5m", "15m", "1h", "6h", "24h", "7d", "30d", "all"]);
    expect(PRESETS.map((entry) => entry.label)).toEqual([
      "Last 5 minutes",
      "Last 15 minutes",
      "Last 1 hour",
      "Last 6 hours",
      "Last 24 hours",
      "Last 7 days",
      "Last 30 days",
      "All time",
    ]);
    expect(PRESETS.map((entry) => entry.ms)).toEqual([
      300_000,
      900_000,
      3_600_000,
      21_600_000,
      86_400_000,
      604_800_000,
      2_592_000_000,
      null,
    ]);
  });
});

describe("resolveRange", () => {
  it("resolves a preset against now, ending at it", () => {
    expect(resolveRange(preset("5m"), NOW)).toEqual({ from: NOW - 300_000, to: NOW });
    expect(resolveRange(preset("15m"), NOW)).toEqual({ from: NOW - 900_000, to: NOW });
    expect(resolveRange(preset("1h"), NOW)).toEqual({ from: NOW - 3_600_000, to: NOW });
    expect(resolveRange(preset("6h"), NOW)).toEqual({ from: NOW - 21_600_000, to: NOW });
    expect(resolveRange(preset("24h"), NOW)).toEqual({ from: NOW - 86_400_000, to: NOW });
    expect(resolveRange(preset("7d"), NOW)).toEqual({ from: NOW - 604_800_000, to: NOW });
    expect(resolveRange(preset("30d"), NOW)).toEqual({ from: NOW - 2_592_000_000, to: NOW });
  });

  it("reaches back to the oldest known request for all, epoch zero without one", () => {
    expect(resolveRange(preset("all"), NOW, 555)).toEqual({ from: 555, to: NOW });
    expect(resolveRange(preset("all"), NOW)).toEqual({ from: 0, to: NOW });
  });

  it("uses a custom range as it stands, to = now when the end is open", () => {
    expect(resolveRange(custom(100, 200), NOW)).toEqual({ from: 100, to: 200 });
    expect(resolveRange(custom(100, null), NOW)).toEqual({ from: 100, to: NOW });
  });

  it("reads an unknown preset as all time", () => {
    expect(resolveRange({ preset: "nope" as Preset, from: 0, to: null }, NOW, 42)).toEqual({
      from: 42,
      to: NOW,
    });
  });
});

describe("rangeLabel", () => {
  it("labels every preset in words", () => {
    for (const entry of PRESETS) expect(rangeLabel(preset(entry.key), NOW)).toBe(entry.label);
  });

  it("draws a custom span as two en-GB stamps, the shared year left out", () => {
    const from = at(2026, 9, 6, 14, 0);
    const to = at(2026, 9, 6, 18, 30);
    expect(rangeLabel(custom(from, to), to)).toBe("6 Oct 14:00 – 6 Oct 18:30");
  });

  it("keeps the year of an end that is not the current one, zero-pads the clock", () => {
    const from = at(2025, 2, 1, 9, 5);
    const to = at(2026, 9, 6, 18, 30);
    expect(rangeLabel(custom(from, to), to)).toBe("1 Mar 2025 09:05 – 6 Oct 18:30");
    expect(rangeLabel(custom(at(2026, 11, 25, 8, 5), to), to)).toBe("25 Dec 08:05 – 6 Oct 18:30");
  });

  it("says now for an open-ended custom range", () => {
    expect(rangeLabel(custom(at(2026, 9, 6, 14, 0), null), at(2026, 9, 6, 18, 30))).toBe("6 Oct 14:00 – now");
  });

  it("falls back to All time for an unknown preset", () => {
    expect(rangeLabel({ preset: "nope" as Preset, from: 0, to: null }, NOW)).toBe("All time");
  });
});

describe("parseRangeHash", () => {
  it("reads a preset from range=", () => {
    expect(parseRangeHash(new URLSearchParams("range=1h"))).toEqual(preset("1h"));
    expect(parseRangeHash(new URLSearchParams("range=30d"))).toEqual(preset("30d"));
    expect(parseRangeHash(new URLSearchParams("range=all"))).toEqual(preset("all"));
  });

  it("reads a custom range from from= and to=, to = now when absent", () => {
    expect(parseRangeHash(new URLSearchParams("from=100&to=200"))).toEqual(custom(100, 200));
    expect(parseRangeHash(new URLSearchParams("from=100"))).toEqual(custom(100, null));
  });

  it("falls back to the default 1h for missing or bad input", () => {
    expect(parseRangeHash(new URLSearchParams(""))).toEqual(DEFAULT_RANGE);
    expect(parseRangeHash(new URLSearchParams("range=yesterday"))).toEqual(DEFAULT_RANGE);
    expect(parseRangeHash(new URLSearchParams("from=abc"))).toEqual(DEFAULT_RANGE);
    expect(parseRangeHash(new URLSearchParams("from="))).toEqual(DEFAULT_RANGE);
    expect(parseRangeHash(new URLSearchParams("from=100&to=later"))).toEqual(custom(100, null));
  });

  it("lets a valid range= win over a from=", () => {
    expect(parseRangeHash(new URLSearchParams("range=24h&from=100"))).toEqual(preset("24h"));
  });
});

describe("rangeToHash", () => {
  it("writes range= for a preset and from=&to= for a custom span, to left out when open", () => {
    expect(rangeToHash(preset("1h"))).toBe("range=1h");
    expect(rangeToHash(preset("all"))).toBe("range=all");
    expect(rangeToHash(custom(100, 200))).toBe("from=100&to=200");
    expect(rangeToHash(custom(100, null))).toBe("from=100");
  });

  it("round-trips through the URLSearchParams a hash parses", () => {
    for (const range of [preset("5m"), preset("all"), custom(100, 200), custom(100, null)]) {
      expect(parseRangeHash(new URLSearchParams(rangeToHash(range)))).toEqual(range);
    }
  });
});

describe("bucketPlan", () => {
  it("picks the readable step that fits the target bar count", () => {
    expect(bucketPlan(0, 300_000)).toEqual({ bucketMs: 5_000, buckets: 60 }); // 5m → 5 s bars
    expect(bucketPlan(0, 3_600_000)).toEqual({ bucketMs: 60_000, buckets: 60 }); // 1h → 1 min bars
    expect(bucketPlan(0, 21_600_000)).toEqual({ bucketMs: 900_000, buckets: 24 }); // 6h → 15 min bars
    expect(bucketPlan(0, 86_400_000)).toEqual({ bucketMs: 1_800_000, buckets: 48 }); // 24h → 30 min bars
    expect(bucketPlan(0, 604_800_000)).toEqual({ bucketMs: 10_800_000, buckets: 56 }); // 7d → 3 h bars
    expect(bucketPlan(0, 2_592_000_000)).toEqual({ bucketMs: 43_200_000, buckets: 60 }); // 30d → 12 h bars
  });

  it("honours a custom target, still under the cap", () => {
    expect(bucketPlan(0, 300_000, 5)).toEqual({ bucketMs: 60_000, buckets: 5 });
    expect(bucketPlan(0, 300_000, 1000)).toEqual({ bucketMs: 1_000, buckets: MAX_BUCKETS });
  });

  it("rounds an awkward span up to the next step and the bucket count up", () => {
    expect(bucketPlan(0, 61_000)).toEqual({ bucketMs: 5_000, buckets: 13 });
    expect(bucketPlan(0, 500)).toEqual({ bucketMs: 1_000, buckets: 1 });
  });

  it("caps the bars a chart draws", () => {
    expect(MAX_BUCKETS).toBe(240);
    expect(bucketPlan(0, 400 * 86_400_000)).toEqual({ bucketMs: 86_400_000, buckets: MAX_BUCKETS });
  });
});
