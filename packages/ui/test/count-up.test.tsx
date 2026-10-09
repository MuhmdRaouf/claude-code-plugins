import { act, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Raf, useCountUp } from "../src/count-up.ts";

function Probe({ value, raf }: { value: number; raf: Raf }) {
  return <span data-testid="n">{useCountUp(value, raf)}</span>;
}

let cancelSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cancelSpy = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancelSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A requestAnimationFrame double: frames queue up and `run(time)` fires them with a chosen timestamp. */
function fakeRaf() {
  const queue = new Map<number, (t: number) => void>();
  let nextId = 1;
  const raf: Raf = (step) => {
    const id = nextId;
    nextId += 1;
    queue.set(id, step);
    return id;
  };
  const run = (time: number) => {
    const steps = [...queue.values()];
    queue.clear();
    for (const step of steps) step(time);
  };
  return { raf, run, pending: () => queue.size };
}

describe("useCountUp", () => {
  it("paints the rounded value at once on first paint and schedules no frame", () => {
    const f = fakeRaf();
    const view = render(<Probe value={100.6} raf={f.raf} />);
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("101");
    expect(f.pending()).toBe(0);
    const empty = render(<Probe value={Number.NaN} raf={f.raf} />);
    expect(empty.container.querySelector("[data-testid=n]")?.textContent).toBe("0");
  });

  it("animates from the previous value to the new one, easing out over 300 ms", () => {
    const f = fakeRaf();
    const view = render(<Probe value={100} raf={f.raf} />);
    view.rerender(<Probe value={200} raf={f.raf} />);
    expect(f.pending()).toBe(1);
    act(() => f.run(1000));
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("100");
    expect(f.pending()).toBe(1);
    act(() => f.run(1150));
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("175");
    act(() => f.run(1299));
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("200");
    expect(f.pending()).toBe(1);
    act(() => f.run(1300));
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("200");
    expect(f.pending()).toBe(0);
  });

  it("shows the final value at once under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    const f = fakeRaf();
    const view = render(<Probe value={100} raf={f.raf} />);
    view.rerender(<Probe value={400} raf={f.raf} />);
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("400");
    expect(f.pending()).toBe(0);
  });

  it("does not animate when the value did not change", () => {
    const f = fakeRaf();
    const view = render(<Probe value={50} raf={f.raf} />);
    view.rerender(<Probe value={50} raf={f.raf} />);
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("50");
    expect(f.pending()).toBe(0);
  });

  it("cancels the frame of an animation it replaces and drops the stale callback", () => {
    const f = fakeRaf();
    const view = render(<Probe value={0} raf={f.raf} />);
    view.rerender(<Probe value={100} raf={f.raf} />);
    view.rerender(<Probe value={200} raf={f.raf} />);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    act(() => f.run(1000));
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("100");
    expect(f.pending()).toBe(1);
    act(() => f.run(1150));
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("175");
    act(() => f.run(1300));
    expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("200");
    expect(f.pending()).toBe(0);
  });

  it("keeps a frame landing after unmount from throwing", () => {
    const f = fakeRaf();
    const view = render(<Probe value={0} raf={f.raf} />);
    view.rerender(<Probe value={100} raf={f.raf} />);
    expect(f.pending()).toBe(1);
    view.unmount();
    // @testing-library/preact drops the last commit's cleanup, so the guard, not cancel, stops it here
    expect(() => act(() => f.run(1000))).not.toThrow();
    expect(view.container.querySelector("[data-testid=n]")).toBeNull();
  });

  it("runs on the real requestAnimationFrame when tests drive it with fake timers", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    try {
      const view = render(<Probe value={0} raf={requestAnimationFrame} />);
      view.rerender(<Probe value={100} raf={requestAnimationFrame} />);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(view.container.querySelector("[data-testid=n]")?.textContent).toBe("100");
    } finally {
      vi.useRealTimers();
    }
  });
});
