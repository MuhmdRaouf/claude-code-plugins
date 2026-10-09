/**
 * The history schema: created in place with IF NOT EXISTS and versioned through the meta table, so an
 * older radar refuses to read a database a newer one wrote. The pragmas run on every open (openHistory
 * always migrates), WAL included, since the file is read while the server writes it.
 */
import type { Db } from "./driver.ts";

export const SCHEMA_VERSION = 7;

/** One row per main session, subagent or job; every node of a tree carries its root's id. */
const NODES = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('main','subagent','job')),
  parent_id TEXT,
  root_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT,
  agent_type TEXT,
  description TEXT,
  project TEXT,
  cwd TEXT,
  model TEXT,
  provider TEXT,
  tool_use_id TEXT,
  spawn_depth INTEGER,
  job_state TEXT,
  repo TEXT,
  branch TEXT,
  name TEXT,
  parent_session_id TEXT,
  started_at INTEGER,
  last_at INTEGER,
  ended_at INTEGER
)`;
const INDEXES = `
CREATE INDEX IF NOT EXISTS nodes_root_id ON nodes(root_id);
CREATE INDEX IF NOT EXISTS nodes_parent_id ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_last_at ON nodes(last_at)`;

const REQUESTS = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT,
  agent_id TEXT,
  model TEXT,
  upstream TEXT,
  ts INTEGER NOT NULL,
  latency_ms INTEGER,
  input INTEGER,
  output INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  cache_write_1h INTEGER,
  speed TEXT,
  geo TEXT,
  service_tier TEXT,
  stop_reason TEXT,
  error TEXT,
  parent_agent_id TEXT,
  provider TEXT,
  route TEXT,
  via TEXT,
  what TEXT,
  thinking INTEGER,
  prompt_hash TEXT,
  headers TEXT,
  totals INTEGER NOT NULL DEFAULT 0
)`;
const REQUEST_INDEXES = `
CREATE INDEX IF NOT EXISTS requests_node_ts ON requests(node_id, ts);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts)`;

/** Request input/output text, gzipped; each side's plain text length sits beside it (in_len, out_len),
 *  so a read that only weighs sides never decompresses them, and bytes keeps the sum for the read-out. */
const CONTENT = `
CREATE TABLE IF NOT EXISTS content (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  input BLOB,
  output BLOB,
  bytes INTEGER NOT NULL,
  in_len INTEGER,
  out_len INTEGER
)`;

const TOOLS = `
CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER,
  ok INTEGER NOT NULL,
  input_key TEXT
)`;

/** One row per distinct prompt capture: the gzip bytes exactly as the router sent them (never re-expanded
 *  on disk), the plain size its ISIZE trailer names, and when the first request carrying it was seen.
 *  Requests point at a row through their prompt_hash. */
const CAPTURES = `
CREATE TABLE IF NOT EXISTS captures (
  hash TEXT PRIMARY KEY,
  gz BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  first_ts INTEGER NOT NULL
)`;

/** Timeline events (a kind plus a JSON payload); node_id is null when the event names no node. */
const EVENTS = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  agent_id TEXT,
  label TEXT,
  payload TEXT NOT NULL,
  node_id TEXT
)`;

const OFFSETS = `
CREATE TABLE IF NOT EXISTS offsets (
  file TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL
)`;

/** Create the meta table first: the version check must work on a database that has nothing else yet. */
const META = "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

/** The columns each later version added to tables an older database already has; every one nullable, so
 *  ADD COLUMN needs no default. The key is the version that introduced the batch. */
const VERSION_COLUMNS: Record<number, Record<string, string[]>> = {
  2: {
    nodes: ["repo TEXT", "branch TEXT", "name TEXT", "parent_session_id TEXT"],
    requests: ["cache_write_1h INTEGER", "speed TEXT", "geo TEXT", "service_tier TEXT"],
  },
  3: {
    requests: ["what TEXT", "thinking INTEGER"],
  },
  4: {
    requests: ["error TEXT"],
  },
  5: {
    requests: ["parent_agent_id TEXT"],
  },
  6: {
    content: ["in_len INTEGER", "out_len INTEGER"],
  },
  7: {
    requests: ["prompt_hash TEXT", "headers TEXT"],
  },
};

/** The column names a table already has, remembered per migrate so the pragma runs once per table. */
function columnsOf(db: Db, seen: Map<string, Set<string>>, table: string): Set<string> {
  let have = seen.get(table);
  if (have === undefined) {
    have = new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((column) => column.name));
    seen.set(table, have);
  }
  return have;
}

/** Add every named column of one table the database lacks. */
function addTableColumns(db: Db, seen: Map<string, Set<string>>, table: string, columns: string[]): void {
  const have = columnsOf(db, seen, table);
  for (const column of columns) {
    if (!have.has(column.split(" ")[0] ?? "")) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
}

/** Add every named column the table lacks, from every batch above the version on disk; a fresh database
 *  already has them all and skips the ALTERs. */
function addMissingColumns(db: Db, version: number): void {
  const seen = new Map<string, Set<string>>();
  for (const [batch, tables] of Object.entries(VERSION_COLUMNS)) {
    if (Number(batch) <= version) continue; // a database of this version already has the batch
    for (const [table, columns] of Object.entries(tables)) {
      addTableColumns(db, seen, table, columns);
    }
  }
}

/** The uncompressed size a gzip member names in its ISIZE trailer (its last four bytes, little-endian;
 *  exact below 4 GiB, and every stored side is capped far under that). Reads nothing but the trailer. */
export function isizeOf(blob: Uint8Array): number {
  if (blob.length < 4) return 0;
  return new DataView(blob.buffer, blob.byteOffset + blob.length - 4, 4).getUint32(0, true);
}

/** Fill the side lengths of rows an older radar wrote without them, reading each blob's ISIZE trailer —
 *  a one-time pass, so no later read ever decompresses a side just to weigh it. */
function backfillSideLengths(db: Db): void {
  const rows = db.all<{ request_id: string; input: Uint8Array | null; output: Uint8Array | null }>(
    "SELECT request_id, input, output FROM content WHERE in_len IS NULL OR out_len IS NULL",
  );
  for (const row of rows) {
    db.run("UPDATE content SET in_len = ?, out_len = ? WHERE request_id = ?", [
      row.input === null ? null : isizeOf(row.input),
      row.output === null ? null : isizeOf(row.output),
      row.request_id,
    ]);
  }
}

/** Bring an opened database to SCHEMA_VERSION; throws on one written by a newer radar. */
export function migrate(db: Db): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(META);
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  const version = row === undefined ? 0 : Number(row.value);
  if (version > SCHEMA_VERSION)
    throw new Error(`radar history was written by a newer radar (schema ${version}); update radar`);
  db.exec(
    `${NODES};${INDEXES};${REQUESTS};${REQUEST_INDEXES};${CONTENT};${TOOLS};${CAPTURES};${EVENTS};${OFFSETS}`,
  );
  // older tables keep their old shape through CREATE IF NOT EXISTS; widen them before anything reads
  if (version < SCHEMA_VERSION) {
    addMissingColumns(db, version);
    backfillSideLengths(db);
  }
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
}
