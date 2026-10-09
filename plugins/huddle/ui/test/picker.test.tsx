import { fireEvent, render, screen } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { describe, expect, it } from "vitest";
import { Picker, type PickerProps, type PickerTask } from "../src/picker.tsx";

const TASKS: PickerTask[] = [
  { id: "t1", title: "First task", status: "todo" },
  { id: "t2", title: "Second task", status: "doing", blocked_by: ["t1"] },
  { id: "t3", title: "Third task", status: "done" },
];

const byId = (id: string): PickerTask | null => TASKS.find((t) => t.id === id) ?? null;

/** The picker with the selection held here, plus a line that shows it. */
function Harness(props: Omit<PickerProps, "id" | "onChange">): JSX.Element {
  const [v, setV] = useState<readonly string[]>(props.value);
  return (
    <div>
      <Picker id="dp" {...props} value={v} onChange={setV} />
      <output data-testid="picked">{v.join(",")}</output>
    </div>
  );
}

const input = (): HTMLInputElement => screen.getByRole("combobox") as HTMLInputElement;
const options = (): string[] =>
  [...document.querySelectorAll('[role="option"] .font-mono')].map((o) => o.textContent ?? "");
const show = (): void => {
  fireEvent.focus(input());
};
const type = (q: string): void => {
  fireEvent.input(input(), { target: { value: q } });
};

describe("Picker", () => {
  it("renders a chip per chosen task with its status icon, title and remove button", () => {
    render(<Harness value={["t1"]} tasks={TASKS} byId={byId} />);
    const remove = screen.getByRole("button", { name: "Remove t1" });
    const chip = remove.closest(".badge") as HTMLElement;
    expect(chip.getAttribute("title")).toBe("First task");
    expect(screen.getByText("First task")).toBeTruthy();
    expect(chip.querySelector("svg")).toBeTruthy();
    expect(chip.querySelector(".font-mono")?.textContent).toBe("t1");
    expect(input().getAttribute("placeholder")).toBe("Search tasks by id or title");
    expect(input().getAttribute("aria-label")).toBe("Add a task");
    expect(input().getAttribute("aria-controls")).toBe("dp-menu");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("marks a chosen id the board does not know as missing and blocked", () => {
    render(<Harness value={["zz"]} tasks={TASKS} byId={byId} />);
    const chip = screen.getByRole("button", { name: "Remove zz" }).closest(".badge") as HTMLElement;
    expect(chip.getAttribute("title")).toBe("No such task");
    expect(screen.getByText("missing")).toBeTruthy();
  });

  it("removes a chip from its button and the last one with Backspace on an empty query", () => {
    render(<Harness value={["t1", "t2"]} tasks={TASKS} byId={byId} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove t1" }));
    expect(screen.getByTestId("picked").textContent).toBe("t2");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.getByTestId("picked").textContent).toBe("");
  });

  it("keeps the query empty when Backspace lands on text", () => {
    render(<Harness value={["t1"]} tasks={TASKS} byId={byId} />);
    type("x");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.getByTestId("picked").textContent).toBe("t1");
  });

  it("opens on focus with the open tasks the board still has", () => {
    render(<Harness value={["t1"]} tasks={TASKS} byId={byId} />);
    expect((document.getElementById("dp-menu") as HTMLElement).hidden).toBe(true);
    show();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect((document.getElementById("dp-menu") as HTMLElement).hidden).toBe(false);
    expect(options()).toEqual(["t2"]); // t1 is chosen, t3 is finished
    expect(input().getAttribute("aria-activedescendant")).toBe("dp-o0");
  });

  it("fuzzy-ranks the board when the query has text and answers a miss with a note", () => {
    render(<Harness value={[]} tasks={TASKS} byId={byId} />);
    show();
    type("second");
    expect(options()).toEqual(["t2"]);
    type("zzz");
    expect(screen.getByText("No task matches.")).toBeTruthy();
  });

  it("answers an empty pool with No open tasks", () => {
    render(<Harness value={[]} tasks={[{ id: "t3", title: "Third task", status: "done" }]} byId={byId} />);
    show();
    expect(screen.getByText("No open tasks.")).toBeTruthy();
  });

  it("takes the highlighted task on Enter and hides the menu on Escape, leaving the dialog alone", () => {
    let dialogClosed = 0;
    document.addEventListener("keydown", () => {
      dialogClosed += 1;
    });
    render(<Harness value={[]} tasks={TASKS} byId={byId} />);
    show();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    dialogClosed = 0; // the walker keys travel; only Enter and Escape must stop at the picker
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByTestId("picked").textContent).toBe("t2");
    expect(dialogClosed).toBe(0);
    expect(input().value).toBe(""); // the query resets after a pick
    show();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect((document.getElementById("dp-menu") as HTMLElement).hidden).toBe(true);
    expect(dialogClosed).toBe(0);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(dialogClosed).toBe(1); // the second Escape falls through to the dialog
  });

  it("walks the menu with the arrows without leaving it", () => {
    render(<Harness value={[]} tasks={TASKS} byId={byId} />);
    show();
    type("task"); // all three match
    const first = document.getElementById("dp-o0") as HTMLElement;
    const last = document.getElementById("dp-o2") as HTMLElement;
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(first.getAttribute("aria-selected")).toBe("true"); // clamped at the top
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(last.getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(last.getAttribute("aria-selected")).toBe("true");
  });

  it("picks from the mouse without blurring, and hides the menu on blur", () => {
    render(<Harness value={[]} tasks={TASKS} byId={byId} />);
    show();
    const opt = document.querySelector('[role="option"]') as HTMLElement;
    fireEvent.mouseDown(opt); // preventDefault keeps the focus, so no blur fires
    expect(screen.getByTestId("picked").textContent).toBe("t1");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(input());
    expect((document.getElementById("dp-menu") as HTMLElement).hidden).toBe(true);
  });

  it("hides its input once the maximum is reached and takes placeholder, label, exclude", () => {
    render(
      <Harness value={["t1"]} tasks={TASKS} byId={byId} max={1} placeholder="Pick blockers" label="Blocks" />,
    );
    expect(input().getAttribute("placeholder")).toBe("Pick blockers");
    expect(input().getAttribute("aria-label")).toBe("Blocks");
    expect(input().getAttribute("class")).toContain("hidden");
  });

  it("never offers the excluded task", () => {
    render(<Harness value={[]} tasks={TASKS} byId={byId} exclude="t3" />);
    show();
    expect(options()).toEqual(["t1", "t2"]);
  });
});
