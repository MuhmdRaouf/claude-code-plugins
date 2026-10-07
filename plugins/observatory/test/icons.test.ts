import { describe, expect, it } from "vitest";
import { ICON_NAMES, icon } from "../src/ui/icons.ts";

describe("icon", () => {
  it("draws a decorative 24-unit stroke icon by default", () => {
    const node = icon("clock");
    expect(node.tag).toBe("svg");
    expect(node.cls).toBe("icon");
    expect(node.attrs).toMatchObject({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "data-icon": "clock",
      "aria-hidden": "true",
    });
    expect(node.children?.map((child) => child.tag)).toEqual(["circle", "path"]);
    expect(node.children?.[0]?.attrs).toEqual({ cx: "12", cy: "12", r: "10" });
    expect(node.children?.[1]?.d).toBe("M12 6v6l4 2");
  });

  it("announces a labelled icon as an image", () => {
    const node = icon("alert", "icon big", "Error");
    expect(node.cls).toBe("icon big");
    expect(node.attrs?.role).toBe("img");
    expect(node.attrs?.["aria-label"]).toBe("Error");
    expect(node.attrs?.["aria-hidden"]).toBeUndefined();
  });

  it("supports every shape kind: rect, line and polyline", () => {
    expect(icon("monitor").children?.map((child) => child.tag)).toEqual(["rect", "line", "line"]);
    expect(icon("monitor").children?.[0]?.attrs).toEqual({
      x: "2",
      y: "3",
      width: "20",
      height: "14",
      rx: "2",
    });
    expect(icon("timer").children?.[0]?.attrs).toEqual({ x1: "10", y1: "2", x2: "14", y2: "2" });
    expect(icon("inbox").children?.[0]).toEqual({
      tag: "polyline",
      attrs: { points: "22 12 16 12 14 15 10 15 8 12 2 12" },
    });
  });

  it("renders every named icon with at least one shape", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(20);
    for (const name of ICON_NAMES) expect(icon(name).children?.length ?? 0).toBeGreaterThan(0);
  });
});
