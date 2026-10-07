/**
 * The usage ledger: every model request observatory has seen, kept for 35 days in one small JSON file per local
 * day under <state>/ledger/. The in-memory store only holds the dashboard's lookback (24 h by default) and forgets
 * on restart; budgets ("this month") and the 30-day attribution need more, so each request lands here too, keyed
 * by its id — a request seen again (a stream update, a restart re-reading the transcript) replaces itself, never
 * counts twice. Only numbers and ids are written: never a prompt, a tool input or a body.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestRecord, Tokens } from "../shared/model.ts";
import { stateDir } from "../shared/paths.ts";

export type LedgerRow = {
  id: string;
  ts: number;
  model: string;
  sessionId: string;
  agentId: string;
  tokens: Tokens;
};

/** What a session and an agent are called, remembered so a 30-day-old row still has a name. */
export type LedgerNames = {
  sessions: Record<string, { project: string | null; title: string | null }>;
  agents: Record<string, string>;
};

type Packed = [number, string, string, string, number, number, number, number];

type DayFile = {
  version: 1;
  rows: Record<string, Packed>;
  sessions: LedgerNames["sessions"];
  agents: LedgerNames["agents"];
};

export type Ledger = {
  /** Add or replace one request (route lines are skipped: the transcript holds the same request). */
  record(request: RequestRecord): void;
  nameSession(id: string, project: string | null, title: string | null): void;
  nameAgent(sessionId: string, agentId: string, name: string): void;
  /** Every row at or after `since`, oldest first. */
  rows(since: number): LedgerRow[];
  names(): LedgerNames;
  /** Write the days that changed; never throws (the ledger is a convenience, the dashboard runs without it). */
  flush(): void;
  /** Bumps on every change, so callers can cache what they derive. */
  version(): number;
};

export const LEDGER_DAYS = 35;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

export function ledgerDir(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "ledger");
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** The local calendar day of a timestamp, as the file name stem. */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function emptyDay(): DayFile {
  return { version: 1, rows: {}, sessions: {}, agents: {} };
}

function isPacked(value: unknown): value is Packed {
  return (
    Array.isArray(value) &&
    value.length === 8 &&
    typeof value[0] === "number" &&
    typeof value[1] === "string" &&
    typeof value[2] === "string" &&
    typeof value[3] === "string" &&
    value.slice(4).every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A day file as written, keeping only well-formed entries; anything unreadable is an empty day. */
export function parseDay(text: string): DayFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyDay();
  }
  const record = asRecord(parsed);
  const day = emptyDay();
  for (const [id, packed] of Object.entries(asRecord(record.rows)))
    if (isPacked(packed)) day.rows[id] = packed;
  for (const [id, value] of Object.entries(asRecord(record.sessions))) {
    const entry = asRecord(value);
    day.sessions[id] = {
      project: typeof entry.project === "string" ? entry.project : null,
      title: typeof entry.title === "string" ? entry.title : null,
    };
  }
  for (const [id, name] of Object.entries(asRecord(record.agents))) {
    if (typeof name === "string") day.agents[id] = name;
  }
  return day;
}

function unpack(id: string, packed: Packed): LedgerRow {
  const [ts, model, sessionId, agentId, input, output, cacheRead, cacheWrite] = packed;
  return { id, ts, model, sessionId, agentId, tokens: { input, output, cacheRead, cacheWrite } };
}

export function createLedger(env: NodeJS.ProcessEnv, now: () => number = Date.now): Ledger {
  const dir = ledgerDir(env);
  const days = new Map<string, DayFile>();
  const dayOfId = new Map<string, string>();
  const dirty = new Set<string>();
  let ver = 0;
  let cache: { version: number; rows: LedgerRow[] } | null = null;

  const cutoffKey = (): string => dayKey(now() - LEDGER_DAYS * 86_400_000);

  function listDays(): string[] {
    try {
      return readdirSync(dir)
        .filter((n) => DAY_FILE.test(n))
        .map((n) => n.slice(0, 10))
        .sort();
    } catch {
      return [];
    }
  }

  function readDay(key: string): DayFile | null {
    try {
      return parseDay(readFileSync(join(dir, `${key}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  function load(): void {
    const cutoff = cutoffKey();
    for (const key of listDays().filter((k) => k >= cutoff)) {
      const entry = readDay(key);
      if (entry === null) continue;
      days.set(key, entry);
      for (const id of Object.keys(entry.rows)) dayOfId.set(id, key);
    }
  }

  function day(key: string): DayFile {
    let entry = days.get(key);
    if (entry === undefined) {
      entry = emptyDay();
      days.set(key, entry);
    }
    return entry;
  }

  function changed(key: string): void {
    dirty.add(key);
    ver += 1;
  }

  function prune(): void {
    const cutoff = cutoffKey();
    const old = new Set([...days.keys(), ...listDays()].filter((key) => key < cutoff));
    for (const key of old) {
      for (const id of Object.keys(days.get(key)?.rows ?? {})) dayOfId.delete(id);
      days.delete(key);
      dirty.delete(key);
      try {
        rmSync(join(dir, `${key}.json`), { force: true });
      } catch {
        // not ours to remove: past the cutoff it is never read either way
      }
    }
  }

  function writeDay(key: string, entry: DayFile): void {
    const path = join(dir, `${key}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmp, path);
  }

  load();

  return {
    record(request) {
      if (request.provider === "route" || request.model === "" || request.model === "<synthetic>") return;
      const key = dayKey(request.ts);
      if (key < cutoffKey()) return;
      const previous = dayOfId.get(request.id);
      if (previous !== undefined && previous !== key) {
        delete days.get(previous)?.rows[request.id];
        changed(previous);
      }
      const t = request.tokens;
      const packed: Packed = [
        request.ts,
        request.model,
        request.sessionId,
        request.agentId,
        t.input,
        t.output,
        t.cacheRead,
        t.cacheWrite,
      ];
      const current = day(key).rows[request.id];
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(packed)) return;
      day(key).rows[request.id] = packed;
      dayOfId.set(request.id, key);
      changed(key);
    },

    nameSession(id, project, title) {
      const key = dayKey(now());
      const known = day(key).sessions[id];
      if (known !== undefined && known.project === project && known.title === title) return;
      day(key).sessions[id] = { project, title };
      changed(key);
    },

    nameAgent(sessionId, agentId, name) {
      const key = dayKey(now());
      const id = `${sessionId}:${agentId}`;
      if (day(key).agents[id] === name) return;
      day(key).agents[id] = name;
      changed(key);
    },

    rows(since) {
      if (cache === null || cache.version !== ver) {
        const all: LedgerRow[] = [];
        for (const entry of days.values()) {
          for (const [id, packed] of Object.entries(entry.rows)) all.push(unpack(id, packed));
        }
        all.sort((a, b) => a.ts - b.ts);
        cache = { version: ver, rows: all };
      }
      return cache.rows.filter((row) => row.ts >= since);
    },

    names() {
      const out: LedgerNames = { sessions: {}, agents: {} };
      // oldest day first, so the newest name a session was given wins
      for (const key of [...days.keys()].sort()) {
        const entry = days.get(key);
        if (entry === undefined) continue;
        Object.assign(out.sessions, entry.sessions);
        Object.assign(out.agents, entry.agents);
      }
      return out;
    },

    flush() {
      prune();
      if (dirty.size === 0) return;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const key of [...dirty]) {
          const entry = days.get(key);
          if (entry !== undefined) writeDay(key, entry);
          dirty.delete(key);
        }
      } catch {
        // a full disk or a removed state dir: the next flush tries again
      }
    },

    version() {
      return ver;
    },
  };
}
