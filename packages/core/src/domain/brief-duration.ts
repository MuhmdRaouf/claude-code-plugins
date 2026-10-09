import { err, ok, type Result } from "./result.ts";

const UNITS = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const MILLISECONDS = /^\d+$/;
const MS_PER = { h: 3_600_000, m: 60_000, s: 1_000 } as const;

/** "90s", "15m", "2h", "1h30m" or a bare number of milliseconds. */
export function parseDuration(text: string | number): Result<number, string> {
  if (typeof text === "number") return positiveMs(text, String(text));
  const trimmed = text.trim();
  if (MILLISECONDS.test(trimmed)) return positiveMs(Number(trimmed), text);
  const match = UNITS.exec(trimmed);
  if (match === null) return err(invalid(text));
  const [, h, m, s] = match;
  return positiveMs(Number(h ?? 0) * MS_PER.h + Number(m ?? 0) * MS_PER.m + Number(s ?? 0) * MS_PER.s, text);
}

function positiveMs(ms: number, text: string): Result<number, string> {
  return Number.isSafeInteger(ms) && ms > 0 ? ok(ms) : err(invalid(text));
}

function invalid(text: string): string {
  return `invalid duration "${text}": use a positive whole number of milliseconds or h/m/s units like 90s, 15m, 2h, 1h30m`;
}
