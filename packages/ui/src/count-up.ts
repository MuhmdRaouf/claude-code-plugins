import { useEffect, useRef, useState } from "preact/hooks";

/** What schedules a frame: the real requestAnimationFrame, or a test double driven by hand. */
export type Raf = (step: (time: number) => void) => number;

const REDUCED = "(prefers-reduced-motion: reduce)";
const DURATION_MS = 300;

/**
 * Animate from the previously shown number to `value` over 300 ms with ease-out, as hrTick did. The first
 * paint, a repeated value and reduced motion show `value` at once. Frames come in through `raf`, which also
 * sets the clock — its first frame timestamp starts the 300 ms. A frame left pending is cancelled on unmount
 * and dropped when a new animation replaces it.
 */
export function useCountUp(value: number, raf: Raf = requestAnimationFrame): number {
  const target = Math.round(value) || 0;
  const [shown, setShown] = useState(target);
  const prev = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const run = useRef(0);
  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    const mine = ++run.current;
    // the previous effect's cleanup always ran by now, so no frame of ours can still be pending here
    if (from === null || from === target || matchMedia(REDUCED).matches) {
      setShown(target);
      return undefined;
    }
    let t0 = -1;
    const step = (t: number) => {
      if (run.current !== mine) return;
      if (t0 < 0) t0 = t;
      const k = Math.min(1, (t - t0) / DURATION_MS);
      const e = 1 - (1 - k) ** 2;
      setShown(Math.round(from + (target - from) * e));
      frame.current = k < 1 ? raf(step) : null;
    };
    frame.current = raf(step);
    return () => {
      run.current += 1;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [target, raf]);
  return shown;
}
