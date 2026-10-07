/**
 * The spool: dated jsonl files under <state>/spool holding hook lines. Listed by date window (datestamped
 * filenames compare lexicographically), parsed tolerantly — a malformed line is skipped, never fatal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpoolLine } from "../shared/model.ts";
import { spoolDir } from "../shared/paths.ts";

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Spool files whose date is within `days` of `now`, oldest first. Missing dir → empty. Full paths. */
export function listSpoolFiles(env: NodeJS.ProcessEnv, now: Date, days = 7): string[] {
  const dir = spoolDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = now.getTime() - days * 86_400_000;
  return names
    .filter((name) => DATE_FILE.test(name))
    .filter((name) => {
      const date = Date.parse(`${name.slice(0, 10)}T00:00:00Z`);
      return Number.isFinite(date) && date >= cutoff - 86_400_000;
    })
    .sort()
    .map((name) => join(dir, name));
}

export function parseSpoolLine(line: string): SpoolLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      // a router may stamp epoch milliseconds; everything downstream reads an ISO string
      if (typeof record.ts === "number" && Number.isFinite(record.ts)) {
        record.ts = new Date(record.ts).toISOString();
      }
      if (typeof record.ts === "string" && typeof record.event === "string") return record as SpoolLine;
    }
  } catch {
    // malformed line: skip it, the spool is append-only so it will not come back different
  }
  return null;
}

/** All parseable lines from the given spool files, in file order. Unreadable files are skipped. */
export function readSpoolLines(paths: string[]): SpoolLine[] {
  const out: SpoolLine[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const parsed = parseSpoolLine(line);
      if (parsed !== null) out.push(parsed);
    }
  }
  return out;
}
