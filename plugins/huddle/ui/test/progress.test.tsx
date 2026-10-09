import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { PhaseDiagram, type PhaseGraph, Ring } from "../src/progress.tsx";

describe("Ring", () => {
  it("draws the percentage: the dash is the number, the text says it, the label reads it", () => {
    const view = render(<Ring pct={42} />);
    const svg = view.baseElement.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("class")).toBe("pct-ring size-24");
    expect(svg.getAttribute("viewBox")).toBe("0 0 36 36");
    expect(svg.getAttribute("aria-label")).toBe("42% of the tasks done");
    const meter = svg.querySelector(".meter") as SVGCircleElement;
    expect(meter.getAttribute("stroke-dasharray")).toBe("42 100");
    expect(meter.getAttribute("transform")).toBe("rotate(-90 18 18)");
    expect(meter.getAttribute("style")).toBeNull();
    expect(svg.querySelector(".track")).toBeTruthy();
    expect(svg.querySelector("[data-ovpct]")?.textContent).toBe("42%");
  });

  it("hides the meter at zero and takes a size class", () => {
    const view = render(<Ring pct={0} class="size-10" />);
    const svg = view.baseElement.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("class")).toBe("pct-ring size-10");
    expect(svg.getAttribute("aria-label")).toBe("0% of the tasks done");
    const meter = svg.querySelector(".meter") as SVGCircleElement;
    expect(meter.getAttribute("style")).toBe("display: none;");
    expect(svg.querySelector("[data-ovpct]")?.textContent).toBe("0%");
  });
});

const GRAPH: PhaseGraph = {
  nodes: [
    ["net", "Public network", "net", "The edge the world sees"],
    ["api", "API server", "svc", "Serves the owner UI"],
    ["db", "Postgres", "store", "The only state"],
    ["odd", "Mystery box", "alien", "Not in the table"],
    ["long", "A label far longer than twenty-two characters", "svc"],
  ],
  edges: [
    ["net", "api", "tls"],
    ["api", "db"],
  ],
};

describe("PhaseDiagram", () => {
  it("draws nothing without a graph or without nodes", () => {
    const a = render(<PhaseDiagram g={null} />);
    expect(a.baseElement.querySelector("svg")).toBeNull();
    a.unmount();
    const b = render(<PhaseDiagram g={{ nodes: [] }} />);
    expect(b.baseElement.querySelector("svg")).toBeNull();
  });

  it("renders the boxes with their cut labels, kinds and the svg frame", () => {
    const view = render(<PhaseDiagram g={GRAPH} />);
    const svg = view.baseElement.querySelector("svg.pgraph") as SVGSVGElement;
    expect(svg.getAttribute("role")).toBe("group");
    expect(svg.getAttribute("aria-label")).toBe("How the phase fits together");
    expect(svg.getAttribute("style")).toContain("max-height: 420px");
    expect(svg.querySelector("marker#arr")).toBeTruthy();
    for (const label of ["Public network", "API server", "Postgres", "Mystery box"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Network")).toBeTruthy();
    expect(screen.getAllByText("Service").length).toBe(3); // api, the long box, and the unknown kind
    expect(screen.getByText("Storage")).toBeTruthy();
    expect(screen.getByText("A label far longer th…")).toBeTruthy();
    expect(view.baseElement.querySelectorAll("g.edge").length).toBe(2);
    expect(screen.getByText("tls")).toBeTruthy();
  });

  it("answers with the prompt until a box is picked, then describes it", () => {
    const view = render(<PhaseDiagram g={GRAPH} />);
    expect(screen.getByText("Select a box to read what it is.")).toBeTruthy();
    const node = (i: number): Element => view.baseElement.querySelector(`g.node[data-i="${i}"]`) as Element;
    fireEvent.click(node(2)); // Postgres
    const p = view.baseElement.querySelector("p[aria-live]") as HTMLElement;
    expect(p.getAttribute("aria-live")).toBe("polite");
    expect(p.querySelector("b")?.textContent).toBe("Postgres");
    expect(p.textContent).toBe("Postgres: The only state");
    expect(node(2).getAttribute("class")).toContain("sel");
    // picking another box moves the selection
    fireEvent.click(node(3)); // Mystery box
    expect(p.textContent).toBe("Mystery box: Not in the table");
    expect(node(2).getAttribute("class")).not.toContain("sel");
  });

  it("describes an undescribed box with an empty tail and reads Enter and Space", () => {
    const view = render(<PhaseDiagram g={GRAPH} />);
    const node = (i: number): Element => view.baseElement.querySelector(`g.node[data-i="${i}"]`) as Element;
    fireEvent.keyDown(node(4), { key: "a" }); // not a picking key
    expect(view.baseElement.querySelector("p[aria-live]")?.textContent).toBe(
      "Select a box to read what it is.",
    );
    fireEvent.keyDown(node(4), { key: "Enter" });
    // the description carries the full label, the box only the cut one
    expect(view.baseElement.querySelector("p[aria-live]")?.textContent).toBe(
      "A label far longer than twenty-two characters: ",
    );
    fireEvent.keyDown(node(1), { key: " " });
    expect(view.baseElement.querySelector("p[aria-live]")?.textContent).toBe(
      "API server: Serves the owner UI",
    );
    expect(node(1).getAttribute("aria-label")).toBe("API server");
    expect(node(1).getAttribute("tabindex")).toBe("0");
  });

  it("lays an arrowless box in its own last column, edges or not", () => {
    const view = render(<PhaseDiagram g={{ nodes: [["a", "Only", "svc"]] }} />);
    expect(screen.getByText("Only")).toBeTruthy();
    expect(view.baseElement.querySelector("g.edge")).toBeNull();
  });

  it("keeps an edge whose ends the graph does not name from breaking the layout", () => {
    const g: PhaseGraph = {
      nodes: [["a", "Alpha", "svc"]],
      edges: [["a", "ghost", "??"]],
    };
    render(<PhaseDiagram g={g} />);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("??")).toBeNull();
  });
});
