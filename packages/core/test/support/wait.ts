/**
 * Waiting in tests: `sleep` for a fixed pause and `until` for a condition. Plain promises, no vitest import, so fake
 * engines and child scripts can use them too. Inside a vitest test prefer `until` (or `expect.poll`) over a blind sleep.
 */
import { setTimeout as delay } from "node:timers/promises";

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return delay(ms).then(() => undefined);
}

export interface UntilOptions {
  /** Give up after this long (default 10 s). */
  readonly timeoutMs?: number;
  /** Poll this often (default 10 ms). */
  readonly intervalMs?: number;
  /** What the error says when time runs out. */
  readonly message?: string;
}

/** Polls `probe` until it returns a truthy value and resolves with it; rejects after `timeoutMs` with `message`. A probe
 *  that throws fails at once. */
export async function until<T>(
  probe: () => T | Promise<T>,
  options: UntilOptions = {},
): Promise<NonNullable<T>> {
  const { timeoutMs = 10_000, intervalMs = 10, message = "condition not met" } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${message} within ${timeoutMs} ms`);
    await delay(intervalMs);
  }
}

/** Whether `pid` names a live process (EPERM: alive, someone else's). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Resolves once process `pid` is gone; rejects after `timeoutMs` (default 10 s). */
export async function untilGone(pid: number, options: UntilOptions = {}): Promise<void> {
  await until(() => !isPidAlive(pid), { message: `process ${pid} still alive`, ...options });
}
