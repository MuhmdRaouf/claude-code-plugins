import { fireEvent, render, screen } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { type Tab, Tabs } from "../src/tabs.tsx";

const TABS: Tab[] = [
  { id: "list", label: "List", icon: <i>L</i> },
  { id: "board", label: "Board" },
  { id: "graph", label: "Graph" },
];

/** The work strip with its selection owned here, the way the view holds it. */
function Harness({ initial, onPick }: { initial: string; onPick: (id: string) => void }): JSX.Element {
  const [v, setV] = useState(initial);
  return (
    <Tabs
      tabs={TABS}
      value={v}
      onPick={(id) => {
        setV(id);
        onPick(id);
      }}
    />
  );
}

const tab = (id: string): HTMLElement =>
  screen
    .getByText(id === "list" ? "List" : id === "board" ? "Board" : "Graph")
    .closest("button") as HTMLElement;

describe("Tabs", () => {
  it("renders the legacy tablist markup: seg class, tab buttons, selected only one tab stop", () => {
    const view = render(<Tabs tabs={TABS} value="board" onPick={() => {}} />);
    const list = view.baseElement.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute("class")).toBe("seg");
    expect(list.getAttribute("aria-label")).toBe("View");
    const b = tab("board");
    expect(b.getAttribute("role")).toBe("tab");
    expect(b.getAttribute("id")).toBe("wt-board");
    expect(b.getAttribute("data-tab")).toBe("board");
    expect(b.getAttribute("aria-selected")).toBe("true");
    expect(b.getAttribute("aria-controls")).toBe("wpanel");
    expect(b.getAttribute("tabindex")).toBe("0");
    expect(tab("list").querySelector("i")).toBeTruthy(); // the icon vnode rides inside its button
    expect(tab("list").getAttribute("aria-selected")).toBe("false");
    expect(tab("list").getAttribute("tabindex")).toBe("-1");
  });

  it("picks on click", () => {
    const onPick = vi.fn();
    render(<Harness initial="list" onPick={onPick} />);
    fireEvent.click(tab("graph"));
    expect(onPick).toHaveBeenCalledWith("graph");
    expect(tab("graph").getAttribute("aria-selected")).toBe("true");
    expect(tab("graph").getAttribute("tabindex")).toBe("0");
    expect(tab("list").getAttribute("tabindex")).toBe("-1");
  });

  it("walks with the arrows and jumps with Home and End, wrapping around", () => {
    const onPick = vi.fn();
    render(<Harness initial="board" onPick={onPick} />);
    fireEvent.keyDown(tab("board"), { key: "ArrowRight" });
    expect(tab("graph").hasAttribute("data-tab")).toBe(true);
    expect(document.activeElement).toBe(tab("graph"));
    expect(onPick).toHaveBeenLastCalledWith("graph");
    fireEvent.keyDown(tab("graph"), { key: "ArrowRight" }); // wraps to the first
    expect(document.activeElement).toBe(tab("list"));
    expect(onPick).toHaveBeenLastCalledWith("list");
    fireEvent.keyDown(tab("list"), { key: "ArrowLeft" }); // wraps back to the last
    expect(document.activeElement).toBe(tab("graph"));
    fireEvent.keyDown(tab("graph"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("board"));
    fireEvent.keyDown(tab("board"), { key: "Home" });
    expect(document.activeElement).toBe(tab("list"));
    expect(onPick).toHaveBeenLastCalledWith("list");
    fireEvent.keyDown(tab("list"), { key: "End" });
    expect(document.activeElement).toBe(tab("graph"));
    expect(onPick).toHaveBeenLastCalledWith("graph");
  });

  it("ignores other keys and takes a custom label, panel and class", () => {
    const onPick = vi.fn();
    const view = render(
      <Tabs tabs={TABS} value="list" onPick={onPick} label="Sections" panel="secp" class="seg seg-sm" />,
    );
    fireEvent.keyDown(tab("list"), { key: "a" });
    expect(onPick).not.toHaveBeenCalled();
    const list = view.baseElement.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute("aria-label")).toBe("Sections");
    expect(list.getAttribute("class")).toBe("seg seg-sm");
    expect(tab("list").getAttribute("aria-controls")).toBe("secp");
  });
});
