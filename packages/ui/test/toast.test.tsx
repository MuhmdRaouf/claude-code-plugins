import { act, fireEvent, render, screen } from "@testing-library/preact";
import { useEffect } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { type Timers, ToastProvider, useToast } from "../src/toast.tsx";

/**
 * A timers double: `set` queues with a due time, `run(ms)` advances the clock and fires everything due,
 * firing fns may queue new ones at the same moment.
 */
function fakeTimers(): Timers & { run: (ms: number) => void; pending: () => number } {
  const queue = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  let next = 1;
  return {
    set: (fn, ms) => {
      const id = next;
      next += 1;
      queue.set(id, { fn, at: now + ms });
      return id;
    },
    clear: (id) => {
      queue.delete(id as number);
    },
    run: (ms) => {
      now += ms;
      for (const [id, q] of [...queue]) {
        if (q.at > now) continue;
        queue.delete(id);
        q.fn();
      }
    },
    pending: () => queue.size,
  };
}

/** A child that hands its parent the toast fn once mounted. */
function Grab({ onReady }: { onReady: (t: ReturnType<typeof useToast>) => void }): null {
  const toast = useToast();
  useEffect(() => {
    // braces: the assignment's value would read as this effect's cleanup
    onReady(toast);
  }, []);
  return null;
}

describe("toast stack", () => {
  it("shows a good toast as a polite status with a check icon and a dismiss button", () => {
    const timers = fakeTimers();
    let push: ReturnType<typeof useToast> = () => {};
    render(
      <ToastProvider timers={timers}>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => push("Saved"));
    const row = screen.getByText("Saved").closest(".toast") as HTMLElement;
    expect(row.getAttribute("role")).toBe("status");
    expect(row.getAttribute("class")).toContain("hr-toast-good");
    expect(row.querySelector("svg")).toBeTruthy();
    const stack = row.parentElement as HTMLElement;
    expect(stack.getAttribute("aria-live")).toBe("polite");
    expect(stack.getAttribute("popover")).toBe("manual");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(row.getAttribute("class")).toContain("out");
    act(() => timers.run(180));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("shows a bad toast as an alert that lives 6s", () => {
    const timers = fakeTimers();
    let push: ReturnType<typeof useToast> = () => {};
    render(
      <ToastProvider timers={timers}>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => push("Failed", { bad: true }));
    const row = screen.getByText("Failed").closest(".toast") as HTMLElement;
    expect(row.getAttribute("role")).toBe("alert");
    expect(row.getAttribute("class")).toContain("hr-toast-bad");
    act(() => timers.run(5999));
    expect(screen.getByText("Failed")).toBeTruthy();
    act(() => timers.run(1));
    expect(screen.getByText("Failed").closest(".toast")?.getAttribute("class")).toContain("out");
    act(() => timers.run(180));
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("retires a plain toast after 3s on its own", () => {
    const timers = fakeTimers();
    let push: ReturnType<typeof useToast> = () => {};
    render(
      <ToastProvider timers={timers}>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => push("Copied"));
    expect(timers.pending()).toBe(1);
    act(() => timers.run(2999));
    expect(screen.getByText("Copied")).toBeTruthy();
    act(() => timers.run(1));
    expect(screen.getByText("Copied").closest(".toast")?.getAttribute("class")).toContain("out");
    act(() => timers.run(180));
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("gives an undo toast 8s, runs the action once and takes the toast away", () => {
    const timers = fakeTimers();
    let push: ReturnType<typeof useToast> = () => {};
    const undo = vi.fn();
    render(
      <ToastProvider timers={timers}>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => push("Deleted", { undo }));
    expect(screen.getByText("Undo")).toBeTruthy();
    act(() => timers.run(7999));
    expect(screen.getByText("Deleted")).toBeTruthy();
    act(() => timers.run(1));
    expect(screen.getByText("Deleted").closest(".toast")?.getAttribute("class")).toContain("out");
    act(() => timers.run(180));
    expect(undo).not.toHaveBeenCalled();
    expect(screen.queryByText("Deleted")).toBeNull();
  });

  it("runs the undo action on the Undo button and dismisses", () => {
    const timers = fakeTimers();
    let push: ReturnType<typeof useToast> = () => {};
    const undo = vi.fn();
    render(
      <ToastProvider timers={timers}>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => push("Deleted", { undo }));
    fireEvent.click(screen.getByText("Undo"));
    expect(undo).toHaveBeenCalledTimes(1);
    act(() => timers.run(180));
    expect(screen.queryByText("Deleted")).toBeNull();
  });

  it("keeps four toasts at most, dropping the oldest", () => {
    const timers = fakeTimers();
    let push: ReturnType<typeof useToast> = () => {};
    render(
      <ToastProvider timers={timers}>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => {
      push("one");
      push("two");
      push("three");
      push("four");
      push("five");
    });
    expect(screen.queryByText("one")).toBeNull();
    for (const t of ["two", "three", "four", "five"]) expect(screen.getByText(t)).toBeTruthy();
    expect(timers.pending()).toBe(4);
  });

  it("stops every toast it still owns when the page it lives on goes away", async () => {
    const timers = fakeTimers();
    let push: ReturnType<typeof useToast> = () => {};
    const view = render(
      <ToastProvider timers={timers}>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => push("Leaving"));
    expect(timers.pending()).toBe(1);
    view.unmount();
    // Preact defers effect cleanups to its next paint: give it that paint before judging
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(timers.pending()).toBe(0);
  });

  it("runs on the real timers when none are injected", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let push: ReturnType<typeof useToast> = () => {};
    const view = render(
      <ToastProvider>
        <Grab onReady={(t) => (push = t)} />
      </ToastProvider>,
    );
    act(() => push("Real"));
    expect(setTimeoutSpy).toHaveBeenCalled();
    view.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("refuses to work without a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Grab onReady={vi.fn()} />)).toThrow(/no ToastProvider/);
    spy.mockRestore();
  });
});
