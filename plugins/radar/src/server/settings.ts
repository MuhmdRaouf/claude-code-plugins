/**
 * The dashboard's own preferences, kept in the state dir so every browser and the server agree: whether desktop
 * notifications are on (default on), how many days of history to keep (0 = forever, default 30), and which alerts
 * the user dismissed (by id, forgotten after a week). Reads never throw — a missing or broken file is the defaults.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../budget/budgets.ts";
import { stateDir } from "../shared/paths.ts";

export type Settings = { notifications: boolean; historyRetentionDays: number };

/** The retention choices the dashboard offers, in days; 0 keeps everything. */
export const RETENTION_DAYS = [7, 30, 90, 0] as const;

export const DEFAULT_SETTINGS: Settings = { notifications: true, historyRetentionDays: 30 };

export function settingsPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "settings.json");
}

export function dismissedPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "dismissed.json");
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One of the offered retention choices; anything else (14, -1, "30") is not. */
function isRetentionDays(value: unknown): value is number {
  return typeof value === "number" && (RETENTION_DAYS as readonly number[]).includes(value);
}

export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const record = readJson(settingsPath(env));
  return {
    notifications:
      typeof record.notifications === "boolean" ? record.notifications : DEFAULT_SETTINGS.notifications,
    historyRetentionDays: isRetentionDays(record.historyRetentionDays)
      ? record.historyRetentionDays
      : DEFAULT_SETTINGS.historyRetentionDays,
  };
}

/** One key of a partial update applied to `current`, or the reason it is refused; null for no key of ours. */
function validatedKey(key: string, value: unknown, current: Settings): Settings | string {
  if (key === "notifications") {
    if (typeof value !== "boolean") return "notifications: true or false";
    return { ...current, notifications: value };
  }
  if (key === "historyRetentionDays") {
    if (!isRetentionDays(value)) return `historyRetentionDays: one of ${RETENTION_DAYS.join(", ")}`;
    return { ...current, historyRetentionDays: value };
  }
  return `unknown setting: ${key.slice(0, 40)}`;
}

/** Merge a partial update from the dashboard; unknown keys and wrong types are refused with a reason. */
export function validateSettings(input: unknown, current: Settings): Settings | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "expected an object";
  let next: Settings = { ...current };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const one = validatedKey(key, value, next);
    if (typeof one === "string") return one;
    next = one;
  }
  return next;
}

export function writeSettings(env: NodeJS.ProcessEnv, settings: Settings): void {
  writeJsonAtomic(settingsPath(env), { version: 1, ...settings });
}

const KEEP_DISMISSED_MS = 7 * 86_400_000;

export function readDismissed(env: NodeJS.ProcessEnv, now: number): Map<string, number> {
  const ids = readJson(dismissedPath(env)).ids;
  const out = new Map<string, number>();
  if (typeof ids !== "object" || ids === null) return out;
  for (const [id, at] of Object.entries(ids as Record<string, unknown>)) {
    if (typeof at === "number" && now - at < KEEP_DISMISSED_MS) out.set(id, at);
  }
  return out;
}

export function writeDismissed(env: NodeJS.ProcessEnv, dismissed: Map<string, number>): void {
  writeJsonAtomic(dismissedPath(env), { version: 1, ids: Object.fromEntries(dismissed) });
}
