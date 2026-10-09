import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITER,
  initialLimiter,
  type LimiterConfig,
  type LimiterState,
  maxFromEnv,
  onRateLimited,
  tick,
  withMax,
} from "../../src/domain/limiter.ts";

const CONFIG: LimiterConfig = {
  min: 1,
  defaultMax: 16,
  decreaseFactor: 0.75,
  windowMs: 60_000,
  cooldownMs: 60_000,
  increaseAfterMs: 60_000,
};
const T0 = 1_700_000_000_000;

/** mulberry32: a tiny seeded PRNG so property runs are reproducible from the seed in the failure message. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_296_729_296;
  };
}

function intBetween(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function randomConfig(random: () => number): LimiterConfig {
  const min = intBetween(random, 1, 3);
  return {
    min,
    defaultMax: intBetween(random, min, min + 15),
    decreaseFactor: 0.1 + 0.85 * random(),
    windowMs: intBetween(random, 1_000, 300_000),
    // Longer than the one-second burst, as any sane cooldown is.
    cooldownMs: intBetween(random, 1_000, 300_000),
    increaseAfterMs: intBetween(random, 1_000, 600_000),
  };
}

const SEEDS = Array.from({ length: 300 }, (_, index) => 0x5eed + index);

/** 200 random steps of rate limits and ticks, each with the state it left and the time it happened. */
function randomWalk(
  random: () => number,
  config: LimiterConfig,
  max: number,
): { readonly state: LimiterState; readonly now: number; readonly rateLimited: boolean }[] {
  const steps: { state: LimiterState; now: number; rateLimited: boolean }[] = [];
  let now = T0;
  let state = initialLimiter(config, now, max);
  for (let step = 0; step < 200; step += 1) {
    now += intBetween(random, 0, 2 * config.increaseAfterMs);
    const rateLimited = random() < 0.3;
    state = rateLimited ? onRateLimited(state, config, now, random() < 0.2) : tick(state, config, now);
    steps.push({ state, now, rateLimited });
  }
  return steps;
}

/** A cooled state (a decrease is allowed) with no remembered events. */
function at(cap: number, max = CONFIG.defaultMax): LimiterState {
  return { cap, max, lastDecreaseAt: null, quietSince: T0, rateLimitedAt: [] };
}

describe("limiter (AIMD)", () => {
  it("initialLimiter starts at the ceiling with no decrease and quietSince = now", () => {
    expect(initialLimiter(CONFIG, T0)).toEqual({
      cap: 16,
      max: 16,
      lastDecreaseAt: null,
      quietSince: T0,
      rateLimitedAt: [],
    });
    expect(initialLimiter(CONFIG, T0, 4).cap).toBe(4);
  });

  it("DEFAULT_LIMITER lowers by a quarter at most once a minute and grows after one quiet minute, ceiling 16", () => {
    expect(DEFAULT_LIMITER).toEqual({
      min: 1,
      defaultMax: 16,
      decreaseFactor: 0.75,
      windowMs: 60_000,
      cooldownMs: 60_000,
      increaseAfterMs: 60_000,
    });
  });

  it("maxFromEnv takes a positive integer, anything else the default ceiling", () => {
    expect(maxFromEnv("4", CONFIG)).toBe(4);
    expect(maxFromEnv("1", CONFIG)).toBe(1);
    expect(maxFromEnv(undefined, CONFIG)).toBe(16);
    expect(maxFromEnv("", CONFIG)).toBe(16);
    expect(maxFromEnv("0", CONFIG)).toBe(16);
    expect(maxFromEnv("-2", CONFIG)).toBe(16);
    expect(maxFromEnv("2.5", CONFIG)).toBe(16);
    expect(maxFromEnv("eight", CONFIG)).toBe(16);
  });

  it("withMax keeps the cap unless it is above the new ceiling", () => {
    expect(withMax(at(3, 8), 16)).toEqual(at(3, 16));
    expect(withMax(at(6, 16), 4)).toEqual({ ...at(6, 16), cap: 4, max: 4 });
  });

  it("one or two rate limits in the window never lower the cap; the third does, by a quarter (floor), min 1", () => {
    const now = T0 + 5_000;
    const one = onRateLimited(at(8), CONFIG, now);
    const two = onRateLimited(one, CONFIG, now + 1_000);

    expect(one).toEqual({ ...at(8), quietSince: now, rateLimitedAt: [now] });
    expect(two).toEqual({ ...at(8), quietSince: now + 1_000, rateLimitedAt: [now, now + 1_000] });
    expect(onRateLimited(two, CONFIG, now + 2_000)).toEqual({
      ...at(8),
      quietSince: now + 2_000,
      rateLimitedAt: [now, now + 1_000, now + 2_000],
      cap: 6,
      lastDecreaseAt: now + 2_000,
    });
    const pair = onRateLimited(onRateLimited(at(3), CONFIG, now), CONFIG, now + 1_000);
    expect(onRateLimited(pair, CONFIG, now + 2_000).cap).toBe(2);
    const floored = onRateLimited(
      onRateLimited(onRateLimited(at(1), CONFIG, now), CONFIG, now + 1_000),
      CONFIG,
      now + 2_000,
    );
    expect(floored.cap).toBe(1);
  });

  it("a rate limit that ended an attempt lowers the cap on its own, the first event included", () => {
    const now = T0 + 5_000;

    expect(onRateLimited(at(8), CONFIG, now, true)).toEqual({
      ...at(6),
      quietSince: now,
      rateLimitedAt: [now],
      lastDecreaseAt: now,
    });
  });

  it("events older than the window no longer count toward the three", () => {
    const old = onRateLimited(at(8), CONFIG, T0);
    const older = onRateLimited(old, CONFIG, T0 + 1_000);
    const later = T0 + CONFIG.windowMs + 2_000;

    expect(onRateLimited(older, CONFIG, later)).toEqual({
      ...at(8),
      quietSince: later,
      rateLimitedAt: [later],
    });
  });

  it("a second decrease needs both the quorum and a full cooldown since the last one", () => {
    const decreased: LimiterState = {
      ...at(6),
      lastDecreaseAt: T0,
      quietSince: T0,
      rateLimitedAt: [T0 - 2_000, T0 - 1_000, T0],
    };
    const justBefore = T0 + CONFIG.cooldownMs - 1;
    const atCooldown = T0 + CONFIG.cooldownMs;

    const stillCooling = onRateLimited(decreased, CONFIG, justBefore, true);
    // Only T0 itself is still inside the 60 s window at justBefore.
    expect(stillCooling).toEqual({
      ...decreased,
      quietSince: justBefore,
      rateLimitedAt: [T0, justBefore],
    });
    expect(onRateLimited(decreased, CONFIG, atCooldown, true).cap).toBe(4);
  });

  it("tick increases by one after increaseAfterMs of quiet, then needs another full quiet period", () => {
    const lowered = { ...at(4), lastDecreaseAt: T0 };
    const firstAt = T0 + CONFIG.increaseAfterMs;

    const once = tick(lowered, CONFIG, firstAt);
    const tooSoon = tick(once, CONFIG, firstAt + CONFIG.increaseAfterMs - 1);
    const twice = tick(tooSoon, CONFIG, firstAt + CONFIG.increaseAfterMs);

    expect(once).toEqual({ ...lowered, cap: 5, quietSince: firstAt });
    expect(tooSoon).toBe(once);
    expect(twice).toEqual({ ...lowered, cap: 6, quietSince: firstAt + CONFIG.increaseAfterMs });
  });

  it("tick never exceeds the persisted ceiling and never changes the cap before the quiet period", () => {
    const full = initialLimiter(CONFIG, T0);
    const lowered = { ...at(2), lastDecreaseAt: T0 };

    expect(tick(full, CONFIG, T0 + 10 * CONFIG.increaseAfterMs)).toBe(full);
    expect(tick({ ...at(3, 3) }, CONFIG, T0 + 10 * CONFIG.increaseAfterMs).cap).toBe(3);
    expect(tick(lowered, CONFIG, T0)).toBe(lowered);
    expect(tick(lowered, CONFIG, T0 + CONFIG.increaseAfterMs - 1)).toBe(lowered);
  });

  it("a burst of 20 rate limits in one second costs exactly one decrease (property over random bursts)", () => {
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const config = randomConfig(random);
      const start = T0 + intBetween(random, 0, 10_000_000);
      const max = intBetween(random, config.min, config.min + 15);
      const before: LimiterState = {
        cap: intBetween(random, config.min, max),
        max,
        lastDecreaseAt: random() < 0.5 ? null : start - config.cooldownMs - intBetween(random, 0, 1_000_000),
        quietSince: start - intBetween(random, 0, 1_000_000),
        rateLimitedAt: [],
      };
      const burst = Array.from({ length: 20 }, () => start + intBetween(random, 0, 999)).sort(
        (a, b) => a - b,
      );

      const after = burst.reduce((state, now) => onRateLimited(state, config, now), before);

      expect(after, `seed ${seed}`).toEqual({
        ...before,
        cap: Math.max(config.min, Math.floor(before.cap * config.decreaseFactor)),
        lastDecreaseAt: burst[2],
        quietSince: burst[burst.length - 1],
        rateLimitedAt: burst,
      });
    }
  });

  it("the cap stays within [min, max] under any random interleaving of rate limits and ticks", () => {
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const config = randomConfig(random);
      const max = intBetween(random, config.min, config.min + 15);
      for (const [step, { state, now, rateLimited }] of randomWalk(random, config, max).entries()) {
        expect(state.cap, `seed ${seed} step ${step}`).toBeGreaterThanOrEqual(config.min);
        expect(state.cap, `seed ${seed} step ${step}`).toBeLessThanOrEqual(max);
        expect(Number.isInteger(state.cap), `seed ${seed} step ${step}`).toBe(true);
        // Pruning happens on the next event; only that step must leave a fully fresh window.
        if (rateLimited) {
          expect(
            state.rateLimitedAt.every((at) => now - at < config.windowMs),
            `seed ${seed}`,
          ).toBe(true);
        }
      }
    }
  });

  it("recovers from min to the ceiling in (ceiling - min) * increaseAfterMs of quiet", () => {
    const floored = { ...at(CONFIG.min), lastDecreaseAt: T0 };
    const recoveryMs = (CONFIG.defaultMax - CONFIG.min) * CONFIG.increaseAfterMs;
    const everySecondUntil = (end: number): LimiterState => {
      let state: LimiterState = floored;
      for (let now = T0; now <= end; now += 1_000) state = tick(state, CONFIG, now);
      return state;
    };

    expect(everySecondUntil(T0 + recoveryMs - 1_000).cap).toBe(CONFIG.defaultMax - 1);
    expect(everySecondUntil(T0 + recoveryMs).cap).toBe(CONFIG.defaultMax);
  });
});
