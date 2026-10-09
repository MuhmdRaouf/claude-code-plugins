import { describe, expect, it } from "vitest";
import { heroAt } from "../src/ui/hero.ts";

describe("heroAt", () => {
  it("eases from the shown value to the target over 300ms", () => {
    expect(heroAt(0, 1000, 0, 0)).toBe(0);
    expect(heroAt(0, 1000, 0, 150)).toBe(875);
    expect(heroAt(0, 1000, 0, 300)).toBe(1000);
    expect(heroAt(0, 1000, 0, 5000)).toBe(1000);
  });

  it("stays between the shown value and the target when the frame clock is behind the start", () => {
    // requestAnimationFrame stamps a frame with its start time, which can precede the performance.now() taken
    // when the tween began
    const value = heroAt(100, 1000, 1000, 990);
    expect(value).toBeGreaterThanOrEqual(100);
    expect(value).toBeLessThanOrEqual(1000);
  });

  it("never drifts away from the total when live updates restart the tween every frame", () => {
    const total = 2_229_000_000;
    let shown = 0;
    // each live message repaints and restarts the tween from what is on screen; its first frame is a little early
    for (let update = 0; update < 5000; update += 1)
      shown = heroAt(shown, total, update * 16 + 4, update * 16);
    expect(Number.isFinite(shown)).toBe(true);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(shown).toBeLessThanOrEqual(total);
  });
});

describe("heroAt with a broken start", () => {
  it("jumps to the target when the shown value is not a number", () => {
    expect(heroAt(Number.NaN, 500, 0, 10)).toBe(500);
    expect(heroAt(Number.NEGATIVE_INFINITY, 500, 0, 10)).toBe(500);
  });
});
