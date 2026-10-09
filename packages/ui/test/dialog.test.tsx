import { fireEvent, render, screen } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/dialog.tsx";

/** A page with a trigger button and a dialog the button opens. */
function Harness({ initial = false }: { initial?: boolean | undefined }): JSX.Element {
  const [open, setOpen] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        trigger
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Rename">
        <p>body text</p>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("opens modally with its title and body, and closes from the header button", () => {
    const onClose = vi.fn();
    const view = render(
      <Dialog open onClose={onClose} title="Rename">
        <p>body text</p>
      </Dialog>,
    );
    const dlg = view.baseElement.querySelector("dialog");
    expect(dlg?.open).toBe(true);
    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("body text")).toBeTruthy();
    expect(dlg?.getAttribute("aria-labelledby")).toBe("mtitle");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    expect(dlg?.open).toBe(false);
  });

  it("renders no header and no labelledby without a title", () => {
    const view = render(
      <Dialog open onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    expect(view.baseElement.querySelector(".dlg-h")).toBeNull();
    expect(view.baseElement.querySelector("dialog")?.getAttribute("aria-labelledby")).toBeNull();
  });

  it("closes on a scrim click and returns focus to the opener", async () => {
    const view = render(<Harness />);
    const trigger = screen.getByText("trigger") as HTMLElement;
    trigger.focus();
    fireEvent.click(trigger); // opens
    const dlg = view.baseElement.querySelector("dialog");
    expect(dlg?.open).toBe(true);
    fireEvent.click(dlg as Element); // the click that reaches the dialog is the scrim
    expect(dlg?.open).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a click inside the box from reading as the scrim, and a second scrim click stays quiet", () => {
    const onClose = vi.fn();
    const view = render(
      <Dialog open onClose={onClose}>
        <p>body text</p>
      </Dialog>,
    );
    const dlg = view.baseElement.querySelector("dialog") as HTMLDialogElement;
    fireEvent.click(screen.getByText("body text")); // inside the box, not on the scrim
    expect(dlg.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dlg); // the scrim closes it
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dlg); // already closed: nothing more to do
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    const view = render(
      <Dialog open onClose={onClose}>
        <p>body</p>
      </Dialog>,
    );
    fireEvent.keyDown(view.baseElement.querySelector("dialog") as Element, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the focus in a dialog that is still open when another one closes", async () => {
    const view = render(<Harness />);
    const trigger = screen.getByText("trigger") as HTMLElement;
    trigger.focus();
    fireEvent.click(trigger);
    const other = document.createElement("dialog");
    document.body.append(other);
    other.showModal();
    other.focus();
    fireEvent.click(view.baseElement.querySelector("dialog") as Element);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(other);
    other.close();
    other.remove();
  });

  it("flips open off through the native close and stays quiet when already closed", () => {
    const onClose = vi.fn();
    const view = render(
      <Dialog open onClose={onClose}>
        <p>body</p>
      </Dialog>,
    );
    view.rerender(
      <Dialog open={false} onClose={onClose}>
        <p>body</p>
      </Dialog>,
    );
    expect(view.baseElement.querySelector("dialog")?.open).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(
      <Dialog open={false} onClose={onClose}>
        <p>body</p>
      </Dialog>,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes the caller's class and labelledby over the modal defaults", () => {
    const view = render(
      <Dialog open onClose={() => {}} class="drawer hr-dialog" labeledBy="td-title">
        <p>body</p>
      </Dialog>,
    );
    const dlg = view.baseElement.querySelector("dialog");
    expect(dlg?.getAttribute("class")).toBe("drawer hr-dialog");
    expect(dlg?.getAttribute("aria-labelledby")).toBe("td-title");
  });

  it("unmounts cleanly while open", () => {
    const view = render(
      <Dialog open onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    expect(() => view.unmount()).not.toThrow();
  });
});
