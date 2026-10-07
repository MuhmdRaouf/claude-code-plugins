import { describe, expect, it } from "vitest";
import { type RequestRecord, ZERO_TOKENS } from "../src/shared/model.ts";
import {
  areaChart,
  bucketizeRequests,
  bucketizeTokenKinds,
  catmullRomPath,
  nearestIndex,
  stackedAreaChart,
  stackedBar,
} from "../src/ui/chart.ts";
import type { UINode } from "../src/ui/types.ts";
import { makeRequest } from "./helpers.ts";

const NOW = 300_000; // a 5m window that starts at ts 0

function req(ts: number, output = 0): RequestRecord {
  return makeRequest({ ts, tokens: { ...ZERO_TOKENS, output } });
}

describe("bucketizeRequests", () => {
  it("counts per bucket and clamps the window's right edge into the last one", () => {
    const values = bucketizeRequests([req(0), req(7_499), req(299_999), req(NOW)], "5m", NOW);
    expect(values).toHaveLength(60);
    expect(values[0]).toBe(1);
    expect(values[1]).toBe(1); // 7_499 sits in the second 5s bucket
    expect(values[59]).toBe(2); // 299_999 and the clamped NOW both land in the last bucket
    expect(values.slice(2, 59).every((value) => value === 0)).toBe(true);
  });

  it("drops requests outside the window entirely", () => {
    const values = bucketizeRequests([req(-1), req(NOW + 1)], "5m", NOW);
    expect(values.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("sums a picked metric and honours a custom bucket count", () => {
    const counted = bucketizeRequests([req(0, 4), req(1_000, 6)], "5m", NOW, (r) => r.tokens.output);
    expect(counted[0]).toBe(10);
    const halved = bucketizeRequests([req(100_000), req(200_000)], "5m", NOW, () => 1, 2);
    expect(halved).toEqual([1, 1]);
  });

  it("uses the range's own window length", () => {
    const hourOld = NOW + 3_600_000;
    const values = bucketizeRequests([req(hourOld - 3_600_000)], "1h", hourOld);
    expect(values[0]).toBe(1);
    expect(bucketizeRequests([req(hourOld - 3_600_000)], "5m", hourOld)[0]).toBe(0);
  });
});

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
});

/** The svg inside a chart frame. */
function svgOf(frame: UINode): UINode {
  return (frame.children ?? []).find((kid) => kid.tag === "svg") ?? { tag: "svg" };
}

describe("areaChart", () => {
  function chart(): UINode {
    return areaChart({
      values: [0, 10, 0],
      width: 200,
      height: 60,
      color: "#89b4fa",
      gradientId: "g1",
      yLabel: "10",
      xLabels: [
        { text: "start", at: 0 },
        { text: "mid", at: 0.5 },
        { text: "now", at: 1 },
      ],
    });
  }

  it("frames a stretchable svg with a fading gradient for this chart's id", () => {
    const frame = chart();
    expect(frame.cls).toBe("chart-frame");
    const node = svgOf(frame);
    expect(node.cls).toBe("chart");
    expect(node.attrs).toMatchObject({
      viewBox: "0 0 200 60",
      width: "100%",
      height: "60",
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    });
    const stops = node.children?.[0]?.children?.[0]?.children ?? [];
    expect(node.children?.[0]?.children?.[0]?.attrs?.id).toBe("g1");
    expect(stops[0]?.attrs).toEqual({ offset: "0%", "stop-color": "#89b4fa", "stop-opacity": "0.3" });
    expect(stops[1]?.attrs).toEqual({ offset: "100%", "stop-color": "#89b4fa", "stop-opacity": "0" });
  });

  it("lays a baseline and three muted gridlines across the plot", () => {
    const kids = svgOf(chart()).children ?? [];
    const lines = kids.slice(1, 5);
    expect(lines.map((line) => line.cls)).toEqual(["chart-axis", "chart-grid", "chart-grid", "chart-grid"]);
    expect(lines.map((line) => line.attrs?.y1)).toEqual(["59.5", "46.5", "32.5", "18.5"]);
  });

  it("closes the area under the smooth line", () => {
    const kids = svgOf(chart()).children ?? [];
    const area = kids[5];
    const line = kids[6];
    expect(area?.d).toContain(" L 200 60 L 0 60 Z");
    expect(area?.attrs).toEqual({ fill: "url(#g1)" });
    expect(line?.cls).toBe("chart-line");
    expect(line?.d?.startsWith("M 0.0 60.0")).toBe(true);
    expect(line?.d).toContain("100.0 4.0"); // the peak touches the 4-unit headroom
    expect(line?.attrs).toEqual({ stroke: "#89b4fa" });
  });

  it("puts the labels outside the svg: the max above, time marks pinned by position", () => {
    const kids = chart().children ?? [];
    expect(kids[0]).toEqual({ tag: "span", cls: "chart-ymax", text: "10" });
    const marks = kids[2]?.children ?? [];
    expect(kids[2]?.cls).toBe("chart-x");
    expect(marks.map((mark) => mark.cls)).toEqual([
      "chart-mark mark-start",
      "chart-mark",
      "chart-mark mark-end",
    ]);
    expect(marks.map((mark) => mark.attrs?.style)).toEqual(["left:0.0%", "left:50.0%", "left:100.0%"]);
    expect(marks[0]?.text).toBe("start");
    const bare = areaChart({
      values: [1],
      width: 100,
      height: 40,
      color: "c",
      gradientId: "g",
      yLabel: null,
    });
    expect(bare.children?.map((kid) => kid.tag)).toEqual(["svg"]);
  });

  it("renders empty values as bare, unclosed paths", () => {
    const kids =
      svgOf(areaChart({ values: [], width: 100, height: 40, color: "c", gradientId: "g" })).children ?? [];
    expect(kids[5]?.d).toBe("");
    expect(kids[6]?.d).toBe("");
  });
});

describe("bucketizeTokenKinds", () => {
  it("splits tokens into input, output, cache read and cache write series", () => {
    const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const series = bucketizeTokenKinds(
      [makeRequest({ ts: 0, tokens }), makeRequest({ ts: 10, tokens })],
      "5m",
      NOW,
    );
    expect(series).toHaveLength(4);
    expect(series.map((values) => values[0])).toEqual([2, 4, 6, 8]);
    expect(series.every((values) => values.length === 60)).toBe(true);
  });
});

describe("stackedAreaChart", () => {
  const options = {
    series: [
      { values: [0, 10, 0], color: "a" },
      { values: [0, 10, 10], color: "b" },
    ],
    width: 200,
    height: 60,
  };

  it("stacks each band on the running total below it", () => {
    const kids = svgOf(stackedAreaChart(options)).children ?? [];
    const bands = kids.filter((kid) => kid.cls === "chart-band");
    const lines = kids.filter((kid) => kid.cls === "chart-line");
    expect(bands.map((band) => band.attrs?.fill)).toEqual(["a", "b"]);
    expect(lines.map((line) => line.attrs?.stroke)).toEqual(["a", "b"]);
    // the first band's top is half the stack's peak; the second band's top is the peak itself
    expect(lines[0]?.d).toContain("100.0 32.0");
    expect(lines[1]?.d).toContain("100.0 4.0");
    // each band closes back along the edge of the band below it
    expect(bands[0]?.d?.endsWith("0.0 60.0 Z")).toBe(true);
    expect(bands[1]?.d).toContain("L 200.0 60.0");
    expect(bands[1]?.d?.endsWith("0.0 60.0 Z")).toBe(true);
    expect(bands.every((band) => !band.d?.includes(" M "))).toBe(true); // one subpath per band
  });

  it("draws bands before lines so every edge stays visible, and frames labels", () => {
    const frame = stackedAreaChart({ ...options, yLabel: "20", xLabels: [{ text: "now", at: 1 }] });
    const kids = svgOf(frame).children ?? [];
    expect(kids.slice(4).map((kid) => kid.cls)).toEqual([
      "chart-band",
      "chart-band",
      "chart-line",
      "chart-line",
    ]);
    expect(frame.children?.[0]?.text).toBe("20");
  });

  it("draws only the grid when there are no buckets", () => {
    const kids = svgOf(
      stackedAreaChart({ series: [{ values: [], color: "a" }], width: 10, height: 10 }),
    ).children;
    expect(kids?.every((kid) => kid.tag === "line")).toBe(true);
    expect(svgOf(stackedAreaChart({ series: [], width: 10, height: 10 })).children).toHaveLength(4);
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

describe("stackedBar", () => {
  it("sizes segments against the max, skipping zeroes", () => {
    const bar = stackedBar(
      [
        { value: 10, color: "c1" },
        { value: 5, color: "c2" },
        { value: 0, color: "c3" },
      ],
      10,
    );
    expect(bar.cls).toBe("bar-track");
    const kids = bar.children ?? [];
    expect(kids).toHaveLength(2);
    expect(kids[0]?.attrs?.style).toBe("width:100.00%;background:c1");
    expect(kids[1]?.attrs?.style).toBe("width:50.00%;background:c2");
  });

  it("caps a runaway segment at the full width", () => {
    const kids = stackedBar([{ value: 40, color: "c" }], 10).children ?? [];
    expect(kids[0]?.attrs?.style).toBe("width:100.00%;background:c");
  });

  it("falls back to the empty placeholder when nothing fits", () => {
    expect(stackedBar([{ value: 3, color: "c" }], 0).children?.[0]?.cls).toBe("bar-empty");
    expect(stackedBar([], 10).children?.[0]?.cls).toBe("bar-empty");
  });
});
