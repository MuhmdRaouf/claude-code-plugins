/**
 * The synchronous SQLite driver under both runtimes: `bun:sqlite` on Bun, `node:sqlite` (DatabaseSync)
 * on Node. Each module is loaded through a runtime string variable, so neither tsc nor a bundler ever
 * resolves the other runtime's module.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface Db {
  exec(sql: string): void;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  get<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
  close(): void;
}

declare const Bun: unknown;

type BunStatement = {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): { changes?: number | bigint } | undefined;
};
type BunDatabase = { exec(sql: string): void; query(sql: string): BunStatement; close(): void };
type BunModule = { Database: new (file: string, opts: { create: boolean }) => BunDatabase };

type NodeStatement = {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): { changes: number | bigint };
};
type NodeDatabase = { exec(sql: string): void; prepare(sql: string): NodeStatement; close(): void };
type NodeModule = { DatabaseSync: new (file: string) => NodeDatabase };

const EMPTY: readonly SqlValue[] = [];
const params = (p?: readonly SqlValue[]): readonly SqlValue[] => p ?? EMPTY;

/** The Bun adapter, pure over whatever module object it is handed (fakes test it under Node). */
export function bunDriver(file: string, mod: BunModule): Db {
  const db = new mod.Database(file, { create: true });
  return {
    exec: (sql) => db.exec(sql),
    all: <T>(sql: string, p?: readonly SqlValue[]) => db.query(sql).all(...params(p)) as T[],
    // Bun yields null for a missing row; the interface promises undefined
    get: <T>(sql: string, p?: readonly SqlValue[]) =>
      (db.query(sql).get(...params(p)) as T | null) ?? undefined,
    run: (sql, p) => {
      const out = db.query(sql).run(...params(p));
      return { changes: Number(out?.changes ?? 0) };
    },
    close: () => db.close(),
  };
}

function nodeDriver(file: string, mod: NodeModule): Db {
  const db = new mod.DatabaseSync(file);
  const cache = new Map<string, NodeStatement>();
  const prepared = (sql: string): NodeStatement => {
    const hit = cache.get(sql);
    if (hit !== undefined) return hit;
    const made = db.prepare(sql);
    cache.set(sql, made);
    return made;
  };
  return {
    exec: (sql) => db.exec(sql),
    all: <T>(sql: string, p?: readonly SqlValue[]) => prepared(sql).all(...params(p)) as T[],
    get: <T>(sql: string, p?: readonly SqlValue[]) => prepared(sql).get(...params(p)) as T | undefined,
    run: (sql, p) => ({ changes: Number(prepared(sql).run(...params(p)).changes) }),
    close: () => {
      cache.clear();
      db.close();
    },
  };
}

/** Open (and create when missing) the database file, on whichever runtime is running now. */
export async function openDb(file: string): Promise<Db> {
  if (typeof Bun !== "undefined") {
    const spec = "bun:sqlite";
    return bunDriver(file, (await import(spec)) as BunModule);
  }
  let mod: NodeModule;
  try {
    const spec = "node:sqlite";
    mod = (await import(spec)) as NodeModule;
  } catch {
    throw new Error("radar history needs Node 22.13 or newer, or Bun");
  }
  return nodeDriver(file, mod);
}
