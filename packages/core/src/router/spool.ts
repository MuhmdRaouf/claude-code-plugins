// Route events for Radar: one JSON line per forwarded request, one per router start/stop and one per
// health event (kind "router.event"), appended to a local spool Radar drains. Metadata only — model, route, status, latency, usage,
// the three ids Claude Code sends (session, agent, parent agent) — never another header value, never a byte of any
// body. Every plugin's router appends to the same dated files, so a reader filters by the `plugin` field.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../domain/json.ts";
import type { EnvLookup } from "../domain/provider.ts";
import { ROUTER_HEALTH, type SpoolEvent } from "../domain/route-events.ts";
import type { RouteSpool } from "../ports/index.ts";
import { radarHome } from "./spool-write.ts";

export { createSpoolWriter, radarHome, spoolFile } from "./spool-write.ts";

/** The spool schema's version, stamped on every router start/stop event. */
export const SPOOL_VERSION = 1;

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** The spool files of the last `days` local days, today's included, oldest first: the board reads two, usage thirty.
 *  A missing directory (no router has run yet) yields nothing. */
export function listSpoolFiles(env: EnvLookup, now: Date, days: number): string[] {
  const dir = join(radarHome(env), "spool");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
  return names
    .filter((name) => DATE_FILE.test(name))
    .map((name) => ({ name, day: Date.parse(`${name.slice(0, 10)}T00:00:00`) }))
    .filter(({ day }) => Number.isFinite(day) && day >= first && day <= now.getTime())
    .sort((a, b) => a.day - b.day || a.name.localeCompare(b.name))
    .map(({ name }) => join(dir, name));
}

/** Every parseable event in the given files, in file order: the spool is append-only, so a malformed line is skipped,
 *  never fatal, and an unreadable file yields nothing. */
export function readSpoolEvents(files: readonly string[]): SpoolEvent[] {
  const events: SpoolEvent[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const parsed = parseEvent(line);
      if (parsed !== undefined) events.push(parsed);
    }
  }
  return events;
}

/** What a spool line must carry to be an event: a timestamp and an event name (the rest is read as written). */
const EventShape = z.looseObject({ ts: z.string(), event: z.string() });

/** A router health line: its kind, the plugin, a known event and an epoch-millisecond timestamp. */
const HealthShape = z.looseObject({
  kind: z.literal("router.event"),
  plugin: z.string(),
  event: z.enum(ROUTER_HEALTH),
  reason: z.string().catch(""),
  model: z.string().nullable().catch(null),
  ts: z.number(),
});

/** One spool line as an event, else nothing. */
function parseEvent(line: string): SpoolEvent | undefined {
  const value = parseJson(line, z.unknown());
  if (value === undefined) return undefined;
  const health = HealthShape.safeParse(value);
  if (health.success) return health.data as unknown as SpoolEvent;
  // A health line that does not hold up is skipped, never read as a route event.
  if ((value as { kind?: unknown } | null)?.kind === "router.event") return undefined;
  const event = EventShape.safeParse(value);
  return event.success ? (event.data as unknown as SpoolEvent) : undefined;
}

/** The spool as the board and the usage windows read it. */
export function createSpoolReader(env: EnvLookup): RouteSpool {
  return { events: (now, days) => readSpoolEvents(listSpoolFiles(env, now, days)) };
}
