/** AIMD concurrency limiting, as pure functions of an epoch-ms `now` (persisted by the limiter store). */

export interface LimiterConfig {
  readonly min: number;
  /** The ceiling when nothing has persisted one (see maxFromEnv: `${PREFIX}_MAX_CONCURRENCY`). */
  readonly defaultMax: number;
  readonly decreaseFactor: number;
  /** How long a rate-limit event counts toward the three that lower the cap. */
  readonly windowMs: number;
  readonly cooldownMs: number;
  readonly increaseAfterMs: number;
}

export interface LimiterState {
  readonly cap: number;
  /** The ceiling this state grows back towards (written by run/batch from the environment). */
  readonly max: number;
  readonly lastDecreaseAt: number | null;
  readonly quietSince: number;
  /** Recent rate-limit events (ms), oldest first; only the last windowMs are kept. */
  readonly rateLimitedAt: readonly number[];
}

/** Rate limits from any 3 attempts within one window — or one that ended an attempt — are pressure. */
const EVENTS_TO_LOWER = 3;

export const DEFAULT_LIMITER: LimiterConfig = {
  min: 1,
  defaultMax: 16,
  decreaseFactor: 0.75,
  windowMs: 60_000,
  cooldownMs: 60_000,
  increaseAfterMs: 60_000,
};

export function initialLimiter(config: LimiterConfig, now: number, max = config.defaultMax): LimiterState {
  return { cap: max, max, lastDecreaseAt: null, quietSince: now, rateLimitedAt: [] };
}

/** A new ceiling keeps the current cap unless it sits above it. */
export function withMax(state: LimiterState, max: number): LimiterState {
  return { ...state, max, cap: Math.min(state.cap, max) };
}

/** `${PREFIX}_MAX_CONCURRENCY`: a positive integer, else the config's default ceiling. */
export function maxFromEnv(value: string | undefined, config: LimiterConfig): number {
  const max = Number(value);
  return Number.isInteger(max) && max >= config.min ? max : config.defaultMax;
}

export function onRateLimited(
  state: LimiterState,
  config: LimiterConfig,
  now: number,
  endedAttempt = false,
): LimiterState {
  const rateLimitedAt = [...state.rateLimitedAt.filter((at) => now - at < config.windowMs), now];
  const base = { ...state, rateLimitedAt, quietSince: now };
  const cooled = state.lastDecreaseAt === null || now - state.lastDecreaseAt >= config.cooldownMs;
  if (!(endedAttempt || rateLimitedAt.length >= EVENTS_TO_LOWER) || !cooled) return base;
  return {
    ...base,
    cap: Math.max(config.min, Math.floor(state.cap * config.decreaseFactor)),
    lastDecreaseAt: now,
  };
}

export function tick(state: LimiterState, config: LimiterConfig, now: number): LimiterState {
  if (state.cap >= state.max || now - state.quietSince < config.increaseAfterMs) return state;
  return { ...state, cap: state.cap + 1, quietSince: now };
}
