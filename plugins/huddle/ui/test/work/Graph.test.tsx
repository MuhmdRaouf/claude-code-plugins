import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api.ts";
import type { PlanStep } from "../../src/store.ts";
import { Graph } from "../../src/work/Graph.tsx";
import type { Step } from "../../src/work/model.ts";

/** The value the test needs, or a loud failure — the tests carry no non-null assertions. */
function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("the test could not find what it needs");
  return x;
}

const api: Api = {
  api: async () => [],
  op: async () => ({}),
  channelPath: (ch, p) => `/api/c/${ch}${p}`,
  channelHref: (ch, p) => `#/c/${ch}${p}`,
};

/** One step with the fields the tests name. */
const s = (id: string, over: Partial<PlanStep> = {}): Step => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  ...over,
});

const base = {
  ch: "ch",
  api,
  crit: [] as string[],
  anySteps: true,
  onOpenTask: vi.fn(),
  onClear: vi.fn(),
};

const graph = (rows: Step[], over: Partial<typeof base> = {}) =>
  render(<Graph {...base} rows={rows} {...over} />);

describe("Graph layout", () => {
  it("layers the tasks left to right by their longest path behind them", () => {
    const { container } = graph([
      s("a"),
      s("b", { depends: ["a"] }),
      s("c", { depends: ["b"], status: "doing" }),
    ]);
    const svg = must(container.querySelector("svg.dgraph"));
    expect(svg.getAttribute("aria-label")).toBe("Task dependency graph");
    const groups = svg.querySelectorAll("g.gn");
    expect(groups).toHaveLength(3);
    const xOf = (label: string): number => {
      const g = must([...groups].find((n) => n.getAttribute("aria-label")?.startsWith(label)));
      return Number(must(must(g.getAttribute("transform")).match(/translate\((\d+)/))?.[1]);
    };
    expect(xOf("a")).toBeLessThan(xOf("b"));
    expect(xOf("b")).toBeLessThan(xOf("c"));
    expect(svg.querySelectorAll("path.ge")).toHaveLength(2);
  });

  it("orders the boxes inside a column and numbers their rows", () => {
    const { container } = graph([s("a"), s("b"), s("c", { depends: ["a"] }), s("d", { depends: ["b"] })]);
    const groups = [...container.querySelectorAll("g.gn")];
    const yOf = (label: string): number =>
      Number(
        must(
          must(groups.find((n) => n.getAttribute("aria-label")?.startsWith(label))).getAttribute("transform"),
        ).match(/,\s*(\d+)/)?.[1] ?? 0,
      );
    expect(yOf("c")).toBeLessThan(yOf("d"));
    expect(yOf("a")).toBe(yOf("c"));
    expect(yOf("b")).toBe(yOf("d"));
  });

  it("names the box for the screen: id, title, state, owner, critical", () => {
    const { container } = graph([s("t1", { owner: "owl", title: "Fix the thing" })], { crit: ["t1"] });
    const g = must(container.querySelector("g.gn"));
    expect(g.getAttribute("aria-label")).toBe("t1 Fix the thing, To do, owner owl, on the critical path");
    expect(g.getAttribute("class")).toContain("crit");
    expect(g.getAttribute("class")).toContain("c-idle");
    expect(g.textContent).toContain("○ t1");
    expect(g.textContent).toContain("owl");
    expect(g.getAttribute("role")).toBe("button");
    expect(g.getAttribute("tabindex")).toBe("0");
  });

  it("marks a finished dependency's arrow ok and shows the owner as You", () => {
    const { container } = graph([s("a", { status: "done" }), s("b", { depends: ["a"], owner: "owner" })]);
    expect(container.querySelector("path.ge")?.getAttribute("class")).toContain("ok");
    const b = must([...container.querySelectorAll("g.gn")].find((n) => n.getAttribute("data-i") === "1"));
    expect(b.textContent).toContain("You");
  });

  it("cuts long titles and owners, and counts the hidden dependencies", () => {
    const long = s("t1", {
      title: "A very long task title that goes on and on and over",
      owner: "a.verylongownername",
      depends: ["ghost", "other"],
    });
    const { container } = graph([long]);
    const g = must(container.querySelector("g.gn"));
    const title = must(must([...g.querySelectorAll("text")].at(-2)).textContent);
    expect(title.length).toBeLessThanOrEqual(30);
    expect(title.endsWith("…")).toBe(true);
    expect(g.textContent).toContain("+2 hidden");
    const owner = must(g.querySelector("text.gow")?.textContent);
    expect(owner.length).toBeLessThanOrEqual(14);
    expect(owner.endsWith("…")).toBe(true);
  });

  it("marks the critical path's arrows and boxes", () => {
    const { container } = graph([s("a"), s("b", { depends: ["a"] })], { crit: ["a", "b"] });
    expect(container.querySelector("path.ge")?.getAttribute("class")).toContain("crit");
    expect(container.querySelectorAll("g.gn.crit")).toHaveLength(2);
  });
});

describe("Graph info panel", () => {
  it("explains the drawing and lists the critical path while nothing is picked", () => {
    graph([s("a"), s("b", { depends: ["a"] })], { crit: ["a", "b"] });
    const info = must(document.getElementById("ginfo"));
    expect(info.textContent).toContain("Left to right in the order tasks can run.");
    expect(info.textContent).toContain("Critical path: a → b");
    expect(info.textContent).toContain("Select a task to trace it; Enter opens it.");
  });

  it("traces a picked task: its box, its rivers, its arrows and the panel", () => {
    const rows = [
      s("up", { status: "done" }),
      s("mid", { depends: ["up"] }),
      s("down", { depends: ["mid"] }),
      s("out", { depends: ["up"] }),
    ];
    const { container } = graph(rows);
    const mid = must(container.querySelector("g.gn[data-i='1']"));
    fireEvent.click(mid);
    const svg = must(container.querySelector("svg.dgraph"));
    expect(svg.className).toContain("focus");
    expect(mid.getAttribute("class")).toContain("sel");
    expect(must(container.querySelector("g.gn[data-i='0']")).getAttribute("class")).toContain("up");
    expect(must(container.querySelector("g.gn[data-i='2']")).getAttribute("class")).toContain("down");
    expect(must(container.querySelector("g.gn[data-i='3']")).getAttribute("class")).not.toContain("down");
    const hot = [...container.querySelectorAll("path.ge")].filter((p) =>
      must(p.getAttribute("class")).includes("hot"),
    );
    expect(hot).toHaveLength(2);
    const info = must(document.getElementById("ginfo"));
    expect(info.querySelector(".font-mono")?.textContent).toBe("mid");
    expect(info.textContent).toContain("Task mid");
    expect(info.textContent).toContain("waits on 1, 1 wait on it");
    const open = must(info.querySelector("a.btn-primary"));
    expect(open.getAttribute("href")).toBe("#/c/ch/work?t=mid");
    fireEvent.click(open);
    expect(base.onOpenTask).toHaveBeenCalledWith("mid");
  });

  it("selects with Space and opens with Enter or a double click", () => {
    const { container } = graph([s("a")]);
    const g = must(container.querySelector("g.gn"));
    fireEvent.keyDown(g, { key: " " });
    expect(must(document.getElementById("ginfo")).querySelector(".font-mono")?.textContent).toBe("a");
    fireEvent.keyDown(g, { key: "Enter" });
    expect(base.onOpenTask).toHaveBeenCalledWith("a");
    fireEvent.dblClick(g);
    expect(base.onOpenTask).toHaveBeenCalledTimes(2);
  });
});

describe("Graph empty", () => {
  it("shows the empty state in a card while the filters keep nothing", () => {
    const onClear = vi.fn();
    graph([], { onClear });
    expect(document.querySelector("svg.dgraph")).toBeNull();
    expect(screen.getByText("No task matches.")).not.toBeNull();
    fireEvent.click(screen.getByText("Clear filters"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("asks for a plan while the board is empty", () => {
    graph([], { anySteps: false });
    expect(screen.getByText("No tasks yet")).not.toBeNull();
  });
});

describe("Graph arrow classes", () => {
  it("stacks ok and crit on a finished dependency along the critical path", () => {
    const { container } = graph([s("a", { status: "done" }), s("b", { depends: ["a"] })], {
      crit: ["a", "b"],
    });
    const cls = must(container.querySelector("path.ge")).getAttribute("class");
    expect(cls).toContain("ok");
    expect(cls).toContain("crit");
    expect(cls).not.toContain("hot");
  });

  it("keeps a plain arrow between plain tasks plain", () => {
    const { container } = graph([s("a"), s("b", { depends: ["a"], owner: "owl" })]);
    expect(must(container.querySelector("path.ge")).getAttribute("class")).toBe("ge");
  });
});
