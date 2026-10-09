import { fireEvent, render, screen } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { PageIntro, Panel } from "../src/page.tsx";
import { SlideOver } from "../src/slide-over.tsx";

describe("PageIntro", () => {
  it("shows the title as the page heading, the description and the actions", () => {
    render(
      <PageIntro
        icon={<svg />}
        title="Requests"
        description="Every API call."
        actions={<button type="button">Export</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Requests");
    expect(screen.getByText("Every API call.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });
});

describe("Panel", () => {
  it("renders a header only when it has a title or actions", () => {
    const { container, rerender } = render(<Panel label="Body only">x</Panel>);
    expect(container.querySelector("h2")).toBeNull();
    rerender(
      <Panel title="Agents" meta="12">
        x
      </Panel>,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Agents");
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("drops the body padding when flush", () => {
    const { container } = render(<Panel flush>x</Panel>);
    expect(container.querySelector("section")?.className).toContain("overflow-hidden");
    expect(container.querySelector(".p-5")).toBeNull();
  });
});

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open it
      </button>
      <SlideOver open={open} onClose={() => setOpen(false)} label="Request" header={<h2>Opus</h2>}>
        <p>body</p>
      </SlideOver>
    </>
  );
}

describe("SlideOver", () => {
  it("opens modally and closes from the button and from Escape", () => {
    const { baseElement } = render(<Harness />);
    const dlg = baseElement.querySelector("dialog") as HTMLDialogElement;
    expect(dlg.open).toBe(false);
    fireEvent.click(screen.getByText("open it"));
    expect(dlg.open).toBe(true);
    fireEvent.click(screen.getByTitle("Close (Esc)"));
    expect(dlg.open).toBe(false);
    fireEvent.click(screen.getByText("open it"));
    fireEvent(dlg, new Event("cancel", { cancelable: true }));
    expect(dlg.open).toBe(false);
  });

  it("calls onClose once per close", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <SlideOver open onClose={onClose} label="R" header="h">
        b
      </SlideOver>,
    );
    fireEvent.click(screen.getByTitle("Close (Esc)"));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <SlideOver open={false} onClose={onClose} label="R" header="h">
        b
      </SlideOver>,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("frames, every optional part", () => {
  it("paints a panel's icon and actions, and an intro without actions", () => {
    render(
      <>
        <PageIntro icon={<svg />} title="Bare" description="d" />
        <Panel
          title="T"
          icon={<svg data-testid="ic" />}
          actions={<button type="button">Act</button>}
          class="extra"
        >
          x
        </Panel>
        <Panel actions={<button type="button">Only</button>}>y</Panel>
      </>,
    );
    expect(screen.getByTestId("ic")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Act" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Only" })).toBeTruthy();
    expect(document.querySelector("[data-page-intro] .shrink-0.flex-wrap")).toBeNull();
  });

  it("shows a slide-over's actions and tabs, and gives focus back to its opener", () => {
    const { baseElement } = render(<Harness />);
    const trigger = screen.getByText("open it");
    trigger.focus();
    fireEvent.click(trigger);
    const dlg = baseElement.querySelector("dialog") as HTMLDialogElement;
    fireEvent.click(screen.getByTitle("Close (Esc)"));
    expect(dlg.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    render(
      <SlideOver
        open
        onClose={() => {}}
        label="T"
        header="h"
        actions={<button type="button">Prev</button>}
        tabs={<div role="tablist" />}
      >
        b
      </SlideOver>,
    );
    expect(screen.getByRole("button", { name: "Prev" })).toBeTruthy();
    expect(screen.getByRole("tablist")).toBeTruthy();
  });
});
