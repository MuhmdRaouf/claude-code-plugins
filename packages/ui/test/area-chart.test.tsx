import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { AreaChart, nice, type Point, spline } from "../src/area-chart.tsx";

const T = 10;
const BASE = 202; // 220 - 18 bottom margin, the plot's baseline

const points = (ys: number[]): Point[] => ys.map((y, i) => ({ x: i * 100, y }));

const coords = (d: string): { x: number; y: number }[] => {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < nums.length; i += 2) out.push({ x: Number(nums[i]), y: Number(nums[i + 1]) });
  return out;
};

describe("nice", () => {
  it("rounds the axis max up to a 1/2/5 multiple and never below 1", () => {
    expect(nice(1)).toBe(1);
    expect(nice(2)).toBe(2);
    expect(nice(4)).toBe(5);
    expect(nice(9)).toBe(10);
    expect(nice(11)).toBe(20);
    expect(nice(99)).toBe(100);
    expect(nice(101)).toBe(200);
    expect(nice(0)).toBe(1);
    expect(nice(-3)).toBe(1);
  });
});

describe("spline", () => {
  it("is empty without points and draws a single moveto for one point", () => {
    expect(spline([])).toBe("");
    expect(spline([{ x: 5, y: 6 }])).toBe("M5.0 6.0");
  });

  it("keeps every control point inside the plot across a spike", () => {
    // three flat bins then a jump to the top: the raw spline overshoots under the baseline
    const pts = points([BASE, BASE, BASE, T]);
    const d = spline(pts, { top: T, bottom: BASE });
    const cs = coords(d);
    expect(cs.length).toBeGreaterThan(4);
    for (const c of cs) {
      expect(c.y).toBeGreaterThanOrEqual(T - 0.1);
      expect(c.y).toBeLessThanOrEqual(BASE + 0.1);
      expect(c.x).toBeGreaterThanOrEqual(-0.1);
      expect(c.x).toBeLessThanOrEqual(300.1);
    }
  });

  it("does overshoot without bounds, so the clamp is doing real work", () => {
    const pts = points([BASE, BASE, BASE, T]);
    const cs = coords(spline(pts));
    expect(cs.some((c) => c.y > BASE + 1)).toBe(true);
  });

  it("runs the ends through with repeated edge points", () => {
    const pts = points([BASE, T, BASE]);
    expect(coords(spline(pts)).length).toBeGreaterThan(3);
  });
});

describe("AreaChart", () => {
  it("draws the dashed grid at the quarters with printed maxima and axis labels", () => {
    render(
      <AreaChart
        series={[{ values: [0, 50, 100] }]}
        w={600}
        axis={["9:00", "9:05", "9:10"]}
        label="Events per minute"
      />,
    );
    const svg = document.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Events per minute");
    expect(svg.getAttribute("viewBox")).toBe("0 0 600 220");
    expect(svg.querySelectorAll("line.hr-chart-grid").length).toBe(4);
    const texts = [...svg.querySelectorAll("text.hr-chart-axis")].map((t) => t.textContent);
    for (const t of ["25", "50", "75", "100", "9:00", "9:05", "9:10"]) expect(texts).toContain(t);
    expect(svg.querySelector("path.hr-chart-line")).toBeTruthy();
    expect(svg.querySelector("path.hr-chart-fill.grad")).toBeTruthy();
    expect(svg.querySelector("linearGradient#hr-chart-grad")).toBeTruthy();
  });

  it("prints the maxima through yfmt", () => {
    render(<AreaChart series={[{ values: [1, 2] }]} w={600} yfmt={(v) => `${v}m`} />);
    const texts = [...(document.querySelector("svg") as SVGSVGElement).querySelectorAll("text")].map(
      (t) => t.textContent,
    );
    expect(texts).toContain("0.5m");
    expect(texts).toContain("1m");
  });

  it("notes an empty window instead of drawing lines", () => {
    render(<AreaChart series={[{ values: [0, 0] }]} w={600} />);
    expect(screen.getByText("No data yet")).toBeTruthy();
    expect(document.querySelector("path")).toBeNull();
  });

  it("takes a custom note for the empty window and still draws the grid", () => {
    render(<AreaChart series={[{ values: [0] }]} w={600} note="Nothing yet" />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(document.querySelectorAll("line.hr-chart-grid").length).toBe(4);
  });

  it("draws a lone dot for a single-bin series and tints a second series", () => {
    render(<AreaChart series={[{ values: [3] }, { values: [4], tint: "c-peach" }]} w={600} />);
    const svg = document.querySelector("svg") as SVGSVGElement;
    expect(svg.querySelectorAll("circle").length).toBe(2);
    expect(svg.querySelector("path")).toBeNull();
    const peach = svg.querySelectorAll(".c-peach").length;
    expect(peach).toBe(0); // a single-bin series has no line to tint
  });

  it("carries the tint class on the fill and line of a multi-bin series", () => {
    render(<AreaChart series={[{ values: [1, 2, 3], tint: "c-peach" }]} w={600} />);
    const svg = document.querySelector("svg") as SVGSVGElement;
    expect(svg.querySelectorAll("path.c-peach").length).toBe(2);
  });

  it("shows the crosshair, a dot per series and the tooltip's rows on hover", () => {
    render(
      <AreaChart
        series={[{ values: [0, 0, 9, 0] }, { values: [1, 1, 1, 1] }]}
        w={600}
        tip={(i) => [`bin ${i}`, `${i} events`]}
      />,
    );
    const svg = document.querySelector("svg") as SVGSVGElement;
    // index 2 sits at x = 38 + 2 * (552 / 3) = 406
    fireEvent(svg, new MouseEvent("pointermove", { clientX: 406, bubbles: true }));
    expect(svg.querySelector("line.hr-chart-cross")).toBeTruthy();
    expect(svg.querySelectorAll("circle[r='3.5']").length).toBe(2);
    expect(screen.getByText("bin 2")).toBeTruthy();
    expect(screen.getByText("2 events")).toBeTruthy();
    expect((screen.getByText("bin 2") as HTMLElement).getAttribute("class")).toBe("text-faint");
  });

  it("falls back to the bin index as the tooltip's only row", () => {
    render(<AreaChart series={[{ values: [2, 0] }]} w={600} />);
    const svg = document.querySelector("svg") as SVGSVGElement;
    fireEvent(svg, new MouseEvent("pointermove", { clientX: 40, bubbles: true }));
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("snaps the hovered bin to the pointer and clears on leave", () => {
    render(<AreaChart series={[{ values: [2, 0, 0, 0, 0, 1] }]} w={600} />);
    const svg = document.querySelector("svg") as SVGSVGElement;
    // far right pointer: clamped to the last bin
    fireEvent(svg, new MouseEvent("pointermove", { clientX: 9999, bubbles: true }));
    expect(screen.getByText("5")).toBeTruthy();
    fireEvent(svg, new MouseEvent("pointerleave"));
    expect(screen.queryByText("5")).toBeNull();
    expect(svg.querySelector("line.hr-chart-cross")).toBeNull();
  });

  it("stays quiet on an empty window: no crosshair, no tooltip", () => {
    render(<AreaChart series={[{ values: [0, 0] }]} w={600} />);
    const svg = document.querySelector("svg") as SVGSVGElement;
    fireEvent(svg, new MouseEvent("pointermove", { clientX: 300, bubbles: true }));
    expect(svg.querySelector("line.hr-chart-cross")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("keeps the fallback width when the box has none and wraps the label off", () => {
    render(<AreaChart series={[{ values: [1, 2] }]} />);
    const svg = document.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("width")).toBe("600");
    expect(svg.getAttribute("height")).toBe("220");
    expect(svg.getAttribute("role")).toBeNull();
  });
});
