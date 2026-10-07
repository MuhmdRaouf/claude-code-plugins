// src/store.ts — the storage behind a channel: one SQLite file (WAL, foreign keys) through
// bun:sqlite or node:sqlite (src/rt.ts), with FTS5 indexes for search (« » around the matches in
// snippets). A SQLite without FTS5 still works: search falls back to LIKE (src/channel.ts).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sqlite, type Db, type Row } from "./rt";

export type { Row };
// what a query runs on: the store itself, or the transaction it opened
export interface Q {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  get(sql: string, params?: unknown[]): Promise<Row | null>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

// {ID} is the integer key that numbers rows. ADDED lists columns a channel file may lack; opening
// the file adds them.
const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  name TEXT PRIMARY KEY, label TEXT, role TEXT, joined_at TEXT NOT NULL, last_seen TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle', task TEXT, step TEXT,
  control TEXT NOT NULL DEFAULT 'run' CHECK (control IN ('run','pause')), control_by TEXT, control_at TEXT,
  cursor INTEGER NOT NULL DEFAULT 0, parent TEXT, context TEXT, brief TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq {ID}, ts TEXT NOT NULL, from_name TEXT NOT NULL, to_name TEXT,
  topic TEXT NOT NULL, ref TEXT, msg TEXT, data TEXT, reply_to INTEGER, needs_reply INTEGER NOT NULL DEFAULT 0, key TEXT
);
CREATE INDEX IF NOT EXISTS events_to ON events(to_name, seq);
CREATE INDEX IF NOT EXISTS events_reply ON events(reply_to, from_name);
CREATE INDEX IF NOT EXISTS events_open ON events(needs_reply, seq) WHERE needs_reply = 1;
CREATE UNIQUE INDEX IF NOT EXISTS events_key ON events(from_name, key) WHERE key IS NOT NULL;
CREATE TABLE IF NOT EXISTS phases (n INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, phase INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL,
  owner TEXT, status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','blocked','skipped')),
  after TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL DEFAULT '{}', origin TEXT NOT NULL DEFAULT 'session',
  created_by TEXT, created_at TEXT NOT NULL, status_by TEXT, status_at TEXT, status_note TEXT
);
CREATE INDEX IF NOT EXISTS tasks_order ON tasks(phase, ord);
CREATE TABLE IF NOT EXISTS edits (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, field TEXT NOT NULL, value TEXT NOT NULL,
  by TEXT, at TEXT NOT NULL, PRIMARY KEY (task_id, field)
);
CREATE TABLE IF NOT EXISTS notes (
  id {ID}, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, body TEXT NOT NULL, by TEXT, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_task ON notes(task_id);
CREATE TABLE IF NOT EXISTS knowledge (
  id {ID}, by TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]', task_id TEXT, supersedes INTEGER, created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS touches (
  session TEXT NOT NULL, repo TEXT NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL, warned_at TEXT,
  PRIMARY KEY (session, repo, path)
);
CREATE INDEX IF NOT EXISTS touches_path ON touches(repo, path, at);
`;
// touches: which files a session edited (src/touches.ts); knowledge: verified, moved to the server-wide
// store, and (there) the channel it came from (src/knowledge.ts)
const ADDED: [table: string, column: string][] = [["sessions", "parent TEXT"], ["sessions", "context TEXT"], ["sessions", "brief TEXT"],
  ["knowledge", "verified_by TEXT"], ["knowledge", "verified_at TEXT"], ["knowledge", "moved_to INTEGER"], ["knowledge", "origin TEXT"]];

// One per channel: its SQLite file. The drivers are synchronous; the store keeps the async face
// the channel was written against (and one connection, as the server is the file's only writer).
export class Store implements Q {
  fts = true;
  private q: Q;
  private depth = 0; // open transactions: a transaction inside one is a savepoint
  private constructor(readonly db: Db) { this.q = this.on(); }

  static async sqlite(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const s = new Store(await sqlite(file));
    s.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    return s;
  }
  private on(): Q {
    return {
      all: async (s, p = []) => this.db.all(s, p),
      get: async (s, p = []) => this.db.all(s, p)[0] ?? null,
      run: async (s, p = []) => { this.db.run(s, p); },
    };
  }
  all(s: string, p?: unknown[]) { return this.q.all(s, p); }
  get(s: string, p?: unknown[]) { return this.q.get(s, p); }
  run(s: string, p?: unknown[]) { return this.q.run(s, p); }
  // one transaction; the callback must use the Q it is given, never the store
  async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const sp = this.depth ? `sp${this.depth}` : null;
    this.db.exec(sp ? `SAVEPOINT ${sp}` : "BEGIN");
    this.depth++;
    try {
      const r = await fn(this.q);
      this.depth--;
      this.db.exec(sp ? `RELEASE ${sp}` : "COMMIT");
      return r;
    } catch (e) {
      this.depth--;
      try { this.db.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); } catch {}
      throw e;
    }
  }
  async close() { this.db.close(); }

  async init() {
    this.db.exec(DDL.replace(/\{ID\}/g, "INTEGER PRIMARY KEY AUTOINCREMENT"));
    for (const [t, c] of ADDED) try { this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch {}
    try { this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(id UNINDEXED, title, body, tokenize='porter unicode61')`); }
    catch { this.fts = false; }
    if (this.fts) this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title, body, tags, content='knowledge', content_rowid='id', tokenize='porter unicode61')`);
  }

  // ── full-text search ───────────────────────────────────────────────────────
  // the task index holds each task's effective text (owner edits applied); ids = which tasks, or all
  async indexTasks(q: Q, rows: { id: string; title: string; body: string }[], ids?: string[]) {
    if (!this.fts) return;
    if (!ids) await q.run("DELETE FROM tasks_fts"); else for (const i of ids) await q.run("DELETE FROM tasks_fts WHERE id=?", [i]);
    for (const r of rows) await q.run("INSERT INTO tasks_fts (id, title, body) VALUES (?,?,?)", [r.id, r.title, r.body]);
  }
  private fts5(q: string, op: " " | " OR ") { return q.split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"*`).join(op); }
  // tasks matching every word: {id, title, hit}, best first; null when the index cannot answer
  async searchTasks(q: string): Promise<Row[] | null> {
    if (!this.fts) return null;
    try { return await this.all(`SELECT id, title, snippet(tasks_fts, 2, '«', '»', ' … ', 14) AS hit FROM tasks_fts WHERE tasks_fts MATCH ? ORDER BY rank LIMIT 80`, [this.fts5(q, " ")]); }
    catch { return null; }
  }
  // knowledge rows matching any word, with a snippet of the body in hit and a relevance score (higher is better)
  async searchKnowledge(q: string, limit: number): Promise<Row[]> {
    try {
      return await this.all(`SELECT k.*, snippet(knowledge_fts, 1, '«', '»', ' … ', 18) AS hit, -f.rank AS score FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid
        WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?`, [this.fts5(q, " OR "), limit]);
    } catch { return []; }
  }
  // a new knowledge row joins the index
  async indexKnowledge(q: Q, r: Row, tags: string[]) {
    if (this.fts) await q.run("INSERT INTO knowledge_fts (rowid, title, body, tags) VALUES (?,?,?,?)", [r.id, r.title, r.body, tags.join(" ")]);
  }
}
