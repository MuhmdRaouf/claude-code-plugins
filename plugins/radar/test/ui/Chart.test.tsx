import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { AreaChart, StackedAreaChart, StackedBar } from "../../src/ui/app/Chart.tsx";
import type { ChartOptions, StackedOptions } from "../../src/ui/chart.ts";

function fullAreaOptions(): ChartOptions {
  return {
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
  };
}

/** Every y coordinate in an svg path string, in order (path numbers alternate x, y, x, y…). */
function pathYs(d: string): number[] {
  return [...d.matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((_, index) => index % 2 === 1);
}

describe("AreaChart", () => {
  it("stays inside the plot when the series jumps from flat to a peak", () => {
    const { container } = render(
      <AreaChart values={[0, 0, 0, 0, 100]} width={200} height={60} color="c" gradientId="g" />,
    );
    const d = container.querySelector("path.chart-line")?.getAttribute("d") ?? "";
    const ys = pathYs(d);
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) {
      expect(y, d).toBeGreaterThanOrEqual(4); // the headroom top
      expect(y, d).toBeLessThanOrEqual(60); // the baseline
    }
  });

  it("frames a stretchable svg with a fading gradient for this chart's id", () => {
    const { container } = render(<AreaChart {...fullAreaOptions()} />);
    expect(container.querySelector(".chart-frame")).toBeTruthy();
    const svg = container.querySelector("svg.chart");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 200 60");
    expect(svg?.getAttribute("width")).toBe("100%");
    expect(svg?.getAttribute("height")).toBe("60");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("none");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    const gradient = svg?.querySelector("linearGradient");
    expect(gradient?.getAttribute("id")).toBe("g1");
    const stops = gradient?.querySelectorAll("stop") ?? [];
    expect(stops).toHaveLength(2);
    expect(stops[0]?.getAttribute("offset")).toBe("0%");
    expect(stops[0]?.getAttribute("stop-color")).toBe("#89b4fa");
    expect(stops[0]?.getAttribute("stop-opacity")).toBe("0.3");
    expect(stops[1]?.getAttribute("offset")).toBe("100%");
    expect(stops[1]?.getAttribute("stop-color")).toBe("#89b4fa");
    expect(stops[1]?.getAttribute("stop-opacity")).toBe("0");
  });

  it("lays a baseline and three muted gridlines across the plot", () => {
    const { container } = render(<AreaChart {...fullAreaOptions()} />);
    const lines = [...container.querySelectorAll("line")];
    expect(lines.map((line) => line.getAttribute("class"))).toEqual([
      "chart-axis",
      "chart-grid",
      "chart-grid",
      "chart-grid",
    ]);
    expect(lines.map((line) => line.getAttribute("y1"))).toEqual(["59.5", "46.5", "32.5", "18.5"]);
  });

  it("closes the area under the smooth line", () => {
    const { container } = render(<AreaChart {...fullAreaOptions()} />);
    const paths = container.querySelectorAll("path");
    const area = paths[0];
    const line = paths[1];
    expect(area?.getAttribute("d")).toContain(" L 200 60 L 0 60 Z");
    expect(area?.getAttribute("fill")).toBe("url(#g1)");
    expect(line?.getAttribute("class")).toBe("chart-line");
    expect(line?.getAttribute("d")?.startsWith("M 0.0 60.0")).toBe(true);
    expect(line?.getAttribute("d")).toContain("100.0 4.0"); // the peak touches the 4-unit headroom
    expect(line?.getAttribute("stroke")).toBe("#89b4fa");
  });

  it("puts the labels outside the svg: the max above, time marks pinned by position", () => {
    const { container } = render(<AreaChart {...fullAreaOptions()} />);
    expect(container.querySelector(".chart-ymax")?.textContent).toBe("10");
    const marks = [...container.querySelectorAll<HTMLElement>(".chart-mark")];
    expect(marks.map((mark) => mark.getAttribute("class"))).toEqual([
      "chart-mark mark-start",
      "chart-mark",
      "chart-mark mark-end",
    ]);
    expect(marks.map((mark) => mark.style.left)).toEqual(["0.0%", "50.0%", "100.0%"]);
    expect(marks.map((mark) => mark.textContent)).toEqual(["start", "mid", "now"]);
    expect(container.querySelector(".chart-x")?.children).toHaveLength(3);
  });

  it("leaves the labels out when the frame has none", () => {
    const { container } = render(<AreaChart values={[1]} width={100} height={40} color="c" gradientId="g" />);
    expect(container.querySelector(".chart-ymax")).toBeNull();
    expect(container.querySelector(".chart-x")).toBeNull();
    expect(container.querySelector(".chart-frame")?.children).toHaveLength(1);
  });

  it("renders empty values as bare, unclosed paths", () => {
    const { container } = render(<AreaChart values={[]} width={100} height={40} color="c" gradientId="g" />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.getAttribute("d")).toBe("");
    expect(paths[1]?.getAttribute("d")).toBe("");
  });
});

const TWO_BANDS: StackedOptions = {
  series: [
    { values: [0, 10, 0], color: "a" },
    { values: [0, 10, 10], color: "b" },
  ],
  width: 200,
  height: 60,
};

describe("StackedAreaChart", () => {
  it("stacks each band on the running total below it", () => {
    const { container } = render(<StackedAreaChart {...TWO_BANDS} />);
    const bands = [...container.querySelectorAll("path.chart-band")];
    const lines = [...container.querySelectorAll("path.chart-line")];
    expect(bands.map((band) => band.getAttribute("fill"))).toEqual(["a", "b"]);
    expect(lines.map((line) => line.getAttribute("stroke"))).toEqual(["a", "b"]);
    // the first band's top is half the stack's peak; the second band's top is the peak itself
    expect(lines[0]?.getAttribute("d")).toContain("100.0 32.0");
    expect(lines[1]?.getAttribute("d")).toContain("100.0 4.0");
    // each band closes back along the edge of the band below it
    expect(bands[0]?.getAttribute("d")?.endsWith("0.0 60.0 Z")).toBe(true);
    expect(bands[1]?.getAttribute("d")).toContain("L 200.0 60.0");
    expect(bands[1]?.getAttribute("d")?.endsWith("0.0 60.0 Z")).toBe(true);
    expect(bands.every((band) => !(band.getAttribute("d") ?? "").includes(" M "))).toBe(true); // one subpath per band
  });

  it("draws bands before lines so every edge stays visible, and frames labels", () => {
    const { container } = render(
      <StackedAreaChart {...TWO_BANDS} yLabel="20" xLabels={[{ text: "now", at: 1 }]} />,
    );
    const svg = container.querySelector("svg.chart");
    const kids = [...(svg?.children ?? [])];
    expect(kids.slice(4).map((kid) => kid.getAttribute("class"))).toEqual([
      "chart-band",
      "chart-band",
      "chart-line",
      "chart-line",
    ]);
    expect(container.querySelector(".chart-ymax")?.textContent).toBe("20");
  });

  it("draws only the grid when there are no buckets", () => {
    const empty = render(<StackedAreaChart series={[{ values: [], color: "a" }]} width={10} height={10} />);
    const kids = [...(empty.container.querySelector("svg.chart")?.children ?? [])];
    expect(kids.every((kid) => kid.localName === "line")).toBe(true);
    empty.unmount();
    const none = render(<StackedAreaChart series={[]} width={10} height={10} />);
    expect(none.container.querySelector("svg.chart")?.children).toHaveLength(4);
  });

  it("closes every band with values across the full width, even after an empty first band", () => {
    const { container } = render(
      <StackedAreaChart
        series={[
          { values: [], color: "a" },
          { values: [5, 5, 5], color: "b" },
        ]}
        width={100}
        height={40}
      />,
    );
    const bands = [...container.querySelectorAll("path.chart-band")];
    expect(bands).toHaveLength(1);
    expect(bands[0]?.getAttribute("fill")).toBe("b");
    const d = bands[0]?.getAttribute("d") ?? "";
    expect(d.startsWith("M 0.0 ")).toBe(true); // the top edge starts at the left edge
    expect(d).toContain("100.0 4.0"); // …and runs the full width to the headroom top
    expect(d).toContain("L 100.0 40.0"); // the walk back along the empty band's baseline reaches the edge
    expect(d.endsWith(" Z")).toBe(true); // the band is closed
    expect(d).not.toContain(" M "); // one subpath, not a degenerate sliver at x 0
  });

  it("draws a single bucket as one band and one line", () => {
    const { container } = render(
      <StackedAreaChart series={[{ values: [5], color: "a" }]} width={100} height={40} />,
    );
    expect(container.querySelectorAll("path.chart-band")).toHaveLength(1);
    expect(container.querySelectorAll("path.chart-line")).toHaveLength(1);
  });
});

describe("StackedBar", () => {
  it("sizes segments against the max, skipping zeroes", () => {
    const { container } = render(
      <StackedBar
        segments={[
          { value: 10, color: "c1" },
          { value: 5, color: "c2" },
          { value: 0, color: "c3" },
        ]}
        max={10}
      />,
    );
    expect(container.querySelector(".bar-track")).toBeTruthy();
    const segments = container.querySelectorAll<HTMLElement>(".bar-seg");
    expect(segments).toHaveLength(2);
    expect(segments[0]?.style.width).toBe("100.00%");
    expect(segments[1]?.style.width).toBe("50.00%");
  });

  it("caps a runaway segment at the full width", () => {
    const { container } = render(<StackedBar segments={[{ value: 40, color: "c" }]} max={10} />);
    expect(container.querySelector<HTMLElement>(".bar-seg")?.style.width).toBe("100.00%");
  });

  it("falls back to the empty placeholder when nothing fits", () => {
    const zeroMax = render(<StackedBar segments={[{ value: 3, color: "c" }]} max={0} />);
    expect(zeroMax.container.querySelector(".bar-empty")).toBeTruthy();
    expect(zeroMax.container.querySelector(".bar-seg")).toBeNull();
    zeroMax.unmount();
    const none = render(<StackedBar segments={[]} max={10} />);
    expect(none.container.querySelector(".bar-empty")).toBeTruthy();
    expect(none.container.querySelector(".bar-seg")).toBeNull();
  });
});
