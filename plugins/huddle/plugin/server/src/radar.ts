// src/radar.ts — Huddle reads the Radar plugin when it runs on this machine: its
// state dir ($RADAR_HOME, else ~/.agents/radar) holds its port
// (<state>/port); its loopback API answers GET /api/alerts and GET /api/attribution?by=session.
// Radar not installed, not running, slow or answering garbage: null, quietly — the parts of
// the dashboard that show its data are simply absent. Answers are cached for a few seconds.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Alert = { id: string; kind: string; sessionId: string; agentId: string | null; project: string; since: number; detail: string; costUsd: number | null };
export type Attribution = { key: string; label: string; requests: number; tokens: Record<string, number>; costUsd: number };

const TIMEOUT_MS = 800, TTL_MS = 5000;
const cache = new Map<string, { at: number; v: unknown }>();

export function stateDir(env = process.env): string {
  return env.RADAR_HOME || join(env.HOME || homedir(), ".agents", "radar");
}
export function port(env = process.env): number | null {
  try {
    const p = Number(readFileSync(join(stateDir(env), "port"), "utf8").trim());
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  } catch { return null; }
}

async function get<T>(path: string): Promise<T | null> {
  const p = port();
  if (!p) return null;
  const key = `${p}${path}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T | null;
  let v: T | null = null;
  try {
    // its server answers only Host 127.0.0.1:<port> (a DNS-rebinding guard); fetch sends exactly that
    const r = await fetch(`http://127.0.0.1:${p}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (r.ok) v = await r.json() as T;
  } catch { v = null; }
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** The current alerts (stuck, loop, retry storm, budget, context), or null when Radar is absent. */
export async function alerts(): Promise<Alert[] | null> {
  const j = await get<{ alerts?: unknown }>("/api/alerts");
  if (!j || !Array.isArray(j.alerts)) return null;
  return (j.alerts as any[]).filter(a => a && typeof a.sessionId === "string").map(a => ({
    id: String(a.id ?? ""), kind: String(a.kind ?? "alert"), sessionId: a.sessionId, agentId: a.agentId ?? null, project: String(a.project ?? ""),
    since: Number(a.since) || 0, detail: String(a.detail ?? ""), costUsd: typeof a.costUsd === "number" ? a.costUsd : null }));
}

/** Estimated cost per Claude session over a range, or null when Radar is absent. */
export async function costBySession(range: "day" | "week" | "month" = "day"): Promise<Map<string, number> | null> {
  const j = await get<{ rows?: unknown }>(`/api/attribution?by=session&range=${range}`);
  if (!j || !Array.isArray(j.rows)) return null;
  const m = new Map<string, number>();
  for (const r of j.rows as any[]) if (r && typeof r.key === "string" && typeof r.costUsd === "number" && Number.isFinite(r.costUsd)) m.set(r.key, (m.get(r.key) ?? 0) + r.costUsd);
  return m;
}

/** Forget the cached answers (tests). */
export const resetCache = () => cache.clear();
