/** Small hooks shared by the components. */

import { useEffect, useRef, useState } from "preact/hooks";
import { HERO_TWEEN_MS, heroAt } from "../hero.ts";

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The number on screen easing towards `target` over HERO_TWEEN_MS (at once for reduced motion). A new target
 * cancels the running tween and starts from what is shown, so live updates never compound.
 */
export function useTween(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    const from = shownRef.current;
    if (from === target || reducedMotion()) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const startedAt = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const value = now - startedAt >= HERO_TWEEN_MS ? target : heroAt(from, target, startedAt, now);
      shownRef.current = value;
      setShown(value);
      if (value !== target) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}
