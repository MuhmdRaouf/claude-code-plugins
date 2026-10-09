/**
 * The hero number's count-up: where it sits `now` on its way from the value on screen to the new total.
 */

export const HERO_TWEEN_MS = 300;

/**
 * Ease-out cubic from `from` to `target`, started at `startedAt`. Progress is clamped to [0, 1]: a frame
 * timestamp can precede the start, and an unclamped negative progress overshoots away from the target, which
 * compounds when live updates restart the tween every frame.
 */
export function heroAt(from: number, target: number, startedAt: number, now: number): number {
  if (!Number.isFinite(from)) return target;
  const t = Math.min(1, Math.max(0, (now - startedAt) / HERO_TWEEN_MS));
  const eased = 1 - (1 - t) ** 3;
  return from + (target - from) * eased;
}
