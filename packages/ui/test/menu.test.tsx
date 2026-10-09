import { act, fireEvent, render, screen } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { type MenuClose, type MenuItem, PopMenu } from "../src/menu.tsx";

/** A page with an anchor button and a menu on it. */
function Harness({
  items,
  onClose,
  dir,
}: {
  items: readonly MenuItem[];
  onClose: (why: MenuClose) => void;
  dir?: "up" | "down" | undefined;
}): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" ref={setAnchor}>
        anchor
      </button>
      <PopMenu anchor={anchor} items={items} onClose={onClose} dir={dir} />
    </>
  );
}

const ITEMS: MenuItem[] = [
  { label: "Light", run: () => {} },
  { label: "Dark", checked: true, run: () => {} },
  { label: "System", icon: <b>ic</b>, badge: <span>kbd</span>, run: () => {} },
];

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe("PopMenu", () => {
  it("renders its entries into the document, radio role for the checked one, focused", () => {
    const onClose = vi.fn();
    render(<Harness items={ITEMS} onClose={onClose} />);
    for (const label of ["Light", "Dark", "System"]) expect(screen.getByText(label)).toBeTruthy();
    const dark = screen.getByText("Dark").closest("button") as HTMLElement;
    expect(dark.getAttribute("role")).toBe("menuitemradio");
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(dark);
    const light = screen.getByText("Light").closest("button") as HTMLElement;
    expect(light.getAttribute("role")).toBe("menuitem");
    expect(light.getAttribute("aria-checked")).toBeNull();
    expect(dark.querySelector("svg")).toBeTruthy(); // the checked entry's check mark
    expect(screen.getByText("kbd")).toBeTruthy(); // the badge on an unchecked entry
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs an entry and closes as picked", () => {
    const onClose = vi.fn();
    const run = vi.fn();
    render(<Harness items={[{ label: "Go", run }]} onClose={onClose} />);
    fireEvent.click(screen.getByText("Go"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ picked: true });
  });

  it("closes on Escape as picked and hands the focus back to the anchor", () => {
    const onClose = vi.fn();
    render(<Harness items={ITEMS} onClose={onClose} />);
    const anchor = screen.getByText("anchor") as HTMLElement;
    fireEvent.keyDown(screen.getByText("Dark"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith({ picked: true });
    expect(document.activeElement).toBe(anchor);
  });

  it("closes on Tab and on an outside click without picking", async () => {
    const onClose = vi.fn();
    const view = render(<Harness items={ITEMS} onClose={onClose} />);
    await flush();
    fireEvent.keyDown(screen.getByText("Light"), { key: "Tab" });
    expect(onClose).toHaveBeenCalledWith({ picked: false });
    view.unmount();

    const onClose2 = vi.fn();
    render(<Harness items={ITEMS} onClose={onClose2} />);
    await flush();
    fireEvent.click(document.body);
    expect(onClose2).toHaveBeenCalledWith({ picked: false });
  });

  it("ignores clicks that land inside the menu", async () => {
    const onClose = vi.fn();
    const view = render(<Harness items={ITEMS} onClose={onClose} />);
    const m = view.baseElement.querySelector('[role="menu"]') as HTMLElement;
    fireEvent.click(m); // before the outside listener attaches: nothing at all
    expect(onClose).not.toHaveBeenCalled();
    await flush();
    fireEvent.click(m);
    expect(onClose).not.toHaveBeenCalled(); // inside, so no close
  });

  it("walks the entries with the arrows, Home and End, wrapping at the ends", () => {
    const onClose = vi.fn();
    render(<Harness items={ITEMS} onClose={onClose} />);
    const b = (label: string): HTMLElement => screen.getByText(label).closest("button") as HTMLElement;
    expect(document.activeElement).toBe(b("Dark"));
    fireEvent.keyDown(b("Dark"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(b("System"));
    fireEvent.keyDown(b("System"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(b("Light"));
    fireEvent.keyDown(b("Light"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(b("System"));
    fireEvent.keyDown(b("System"), { key: "Home" });
    expect(document.activeElement).toBe(b("Light"));
    fireEvent.keyDown(b("Light"), { key: "End" });
    expect(document.activeElement).toBe(b("System"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("walks from the menu itself when the focus is not on an entry", () => {
    const onClose = vi.fn();
    const view = render(<Harness items={ITEMS} onClose={onClose} />);
    (document.activeElement as HTMLElement).blur();
    const m = view.baseElement.querySelector('[role="menu"]') as HTMLElement;
    fireEvent.keyDown(m, { key: "ArrowDown" }); // no entry focused: the walk starts from the top
    expect(document.activeElement).toBe(screen.getByText("Light").closest("button"));
  });

  it("opens upward and pins itself inside the viewport", () => {
    const onClose = vi.fn();
    const view = render(<Harness items={ITEMS} onClose={onClose} dir="up" />);
    const m = view.baseElement.querySelector('[role="menu"]') as HTMLElement;
    // a zero-width anchor in the test dom: left clamps to the 8px edge, top sits below the viewport
    expect(m.style.left).toBe("8px");
    expect(m.style.top).toBe("774px");
    expect(screen.getByText("anchor").getAttribute("aria-expanded")).toBe("true");
  });

  it("survives an empty items list, keys included", async () => {
    const onClose = vi.fn();
    const view = render(<Harness items={[]} onClose={onClose} />);
    await flush();
    const m = view.baseElement.querySelector('[role="menu"]') as HTMLElement;
    fireEvent.keyDown(m, { key: "ArrowDown" });
    fireEvent.keyDown(m, { key: "End" });
    expect(m.querySelectorAll("button").length).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hosts the menu inside the anchor's dialog when there is one", () => {
    const dlg = document.createElement("dialog");
    document.body.append(dlg);
    const anchor = document.createElement("button");
    dlg.append(anchor);
    function Direct({ a }: { a: HTMLElement }): JSX.Element {
      return <PopMenu anchor={a} items={[{ label: "Solo", run: () => {} }]} onClose={() => {}} />;
    }
    const view = render(<Direct a={anchor} />);
    expect(dlg.contains(screen.getByText("Solo"))).toBe(true);
    view.unmount();
    dlg.remove();
  });
});
