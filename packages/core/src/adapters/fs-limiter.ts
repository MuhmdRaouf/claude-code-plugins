import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  initialLimiter,
  type LimiterConfig,
  type LimiterState,
  onRateLimited,
  tick,
  withMax,
} from "../domain/limiter.ts";
import { stateLayout } from "../domain/state-layout.ts";
import type { LimiterStore } from "../ports/index.ts";
import { readJsonFileAsync, writeFileAtomic } from "./fs-files.ts";
import { waitLock } from "./fs-lock.ts";
import { isAlive } from "./process/group.ts";

/** The lock is held only for one read-modify-write; waiting longer means its holder is stuck. */
const LOCK_TIMEOUT_MS = 10_000;

// max and rateLimitedAt are optional: a state file without them keeps its cap.
const StoredState = z.object({
  cap: z.number().int(),
  max: z.number().int().optional(),
  lastDecreaseAt: z.number().nullable(),
  quietSince: z.number(),
  rateLimitedAt: z.array(z.number()).optional(),
});

/** <root>/limiter.json, read-modify-write under a lock file; applies domain/limiter.ts. */
export function createFsLimiter(root: string, config: LimiterConfig): LimiterStore {
  const file = stateLayout(root).limiter;

  /** A missing or unreadable file starts over at full capacity; a cap from an older ceiling is clamped. */
  async function read(now: number): Promise<LimiterState> {
    const stored = await readJsonFileAsync(file, StoredState);
    if (stored === undefined) return initialLimiter(config, now);
    const max = stored.max ?? config.defaultMax;
    return {
      ...stored,
      max,
      rateLimitedAt: stored.rateLimitedAt ?? [],
      cap: Math.min(max, Math.max(config.min, stored.cap)),
    };
  }

  /** Applies step under the lock and persists a changed state. Without the lock (a stuck holder) the shared state is
   *  left alone and the caller sees the step applied to what was read. */
  async function update(now: number, step: (state: LimiterState) => LimiterState): Promise<LimiterState> {
    await mkdir(root, { recursive: true });
    const lock = await waitLock(`${file}.lock`, process.pid, isAlive, LOCK_TIMEOUT_MS);
    try {
      const before = await read(now);
      const after = step(before);
      if (lock.ok && !sameState(before, after)) await writeFileAtomic(file, `${JSON.stringify(after)}\n`);
      return after;
    } finally {
      if (lock.ok) await lock.value();
    }
  }

  return {
    async capacity(now) {
      return (await update(now, (state) => tick(state, config, now))).cap;
    },
    async limit(now) {
      const { cap, max } = await read(now);
      return { cap, max };
    },
    async rateLimited(now, options) {
      await update(now, (state) => onRateLimited(state, config, now, options?.endedAttempt));
    },
    async saveMax(max, now) {
      await update(now, (state) => withMax(state, Math.max(config.min, max)));
    },
  };
}

function sameState(a: LimiterState, b: LimiterState): boolean {
  return (
    a.cap === b.cap &&
    a.max === b.max &&
    a.lastDecreaseAt === b.lastDecreaseAt &&
    a.quietSince === b.quietSince &&
    a.rateLimitedAt.join(",") === b.rateLimitedAt.join(",")
  );
}
