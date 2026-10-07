/**
 * The dashboard's own preferences, kept in the state dir so every browser and the server agree: whether desktop
 * notifications are on (default on), and which alerts the user dismissed (by id, forgotten after a week). Reads
 * never throw — a missing or broken file is the defaults.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../budget/budgets.ts";
import { stateDir } from "../shared/paths.ts";

export type Settings = { notifications: boolean };

export const DEFAULT_SETTINGS: Settings = { notifications: true };

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

export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const record = readJson(settingsPath(env));
  return {
    notifications:
      typeof record.notifications === "boolean" ? record.notifications : DEFAULT_SETTINGS.notifications,
  };
}

/** Merge a partial update from the dashboard; unknown keys and wrong types are refused with a reason. */
export function validateSettings(input: unknown, current: Settings): Settings | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "expected an object";
  const record = input as Record<string, unknown>;
  const next: Settings = { ...current };
  for (const [key, value] of Object.entries(record)) {
    if (key !== "notifications") return `unknown setting: ${key.slice(0, 40)}`;
    if (typeof value !== "boolean") return "notifications: true or false";
    next.notifications = value;
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
