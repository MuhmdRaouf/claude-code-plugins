// src/rt.ts — the runtime layer: Huddle runs on Bun (the default) and on Node ≥22.5, from its
// TypeScript sources (Bun only) or from the bundles in plugin/dist/ (both; every launch line runs
// those). Everything that differs between the two lives here:
//   sqlite(file)  bun:sqlite on Bun, node:sqlite (DatabaseSync) on Node — the same small sync driver
//   serve(o)      Bun.serve on Bun (native, fastest); on Node a node:http server around the same
//                 fetch handler (Request in, Response out, streamed bodies, req.signal on disconnect)
//   stdinText, stdoutWrite, sleep, and where the plugin's files are (PLUGIN, entry, cli)
// Everything else is a node: builtin both runtimes have.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

declare const Bun: any;
export const isBun = typeof Bun !== "undefined";
export const RUNTIME = isBun ? "bun" : "node";

// ── where the plugin is ───────────────────────────────────────────────────────
// this module's file: a source under plugin/server/src, or a bundle in plugin/dist (each bundle
// inlines this module, so import.meta.url is the bundle itself)
const SELF = fileURLToPath(import.meta.url);
export const BUNDLED = /[\\/]dist[\\/][^\\/]+\.js$/.test(SELF);
function pluginRoot(): string {
  for (let d = dirname(SELF); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".claude-plugin"))) return d;
  return join(dirname(SELF), BUNDLED ? ".." : "../..");
}
/** The plugin directory (the one holding .claude-plugin/, bin/, server/, dist/). */
export const PLUGIN = pluginRoot();
const SOURCES = { huddle: "bin/huddle.ts", "huddle-mcp": "bin/huddle-mcp.ts", server: "server/server.ts" } as const;
/** The file that runs an entry: its bundle when we run bundled, else its TypeScript source (Bun). */
export const entry = (name: keyof typeof SOURCES) => join(PLUGIN, BUNDLED ? `dist/${name}.js` : SOURCES[name]);
const q = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
/** The CLI as a command line for a shell (shown to Claude and to subagents): this runtime, by name. */
export const cli = () => `${RUNTIME} ${q(entry("huddle"))}`;
/** Arguments that make `process.execPath` run another of our entries: node:sqlite needs a flag before Node 22.13. */
export function runtimeArgs(): string[] {
  if (isBun) return [];
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj < 22 || (maj === 22 && min < 13) ? ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"] : [];
}

// ── small things ──────────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** All of stdin as text (resolves at its end). */
export function stdinText(): Promise<string> {
  if (isBun) return Bun.stdin.text();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))).on("error", reject);
  });
}
/** Write to stdout and resolve once it is flushed (a hook exits right after). */
export const stdoutWrite = (s: string) => new Promise<void>(r => { process.stdout.write(s, () => r()); });

/** fetch for a call that may stay open as long as the server says (long-polls, live streams): Bun's
 *  fetch with its client timeout off; on Node a node:http request, since Node's fetch gives up on a
 *  response whose headers take longer than 300 s. init.signal is the only deadline. */
export async function fetchUntimed(url: string, init: RequestInit = {}): Promise<Response> {
  if (isBun) return fetch(url, { ...init, timeout: false } as RequestInit);
  const u = new URL(url);
  const { request } = u.protocol === "https:" ? await import("node:https") : await import("node:http");
  const { Readable } = await import("node:stream");
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  const method = init.method ?? "GET";
  return new Promise<Response>((resolve, reject) => {
    const req = request(u, { method, headers, signal: init.signal ?? undefined }, res => {
      const h = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const status = res.statusCode ?? 502;
      const empty = method === "HEAD" || status === 204 || status === 304;
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res) as ReadableStream, { status, statusText: res.statusMessage, headers: h }));
    });
    req.on("error", e => reject(init.signal?.aborted ? init.signal.reason : e)); // as fetch: an aborted call rejects with the reason (TimeoutError)
    req.end(init.body == null ? undefined : String(init.body));
  });
}

// ── SQLite ────────────────────────────────────────────────────────────────────
export type Row = Record<string, any>;
export interface Db {
  exec(sql: string): void;                       // one or more statements, no parameters
  all(sql: string, params: unknown[]): Row[];
  run(sql: string, params: unknown[]): void;
  close(): void;
}
// both drivers bind numbers, strings, null, bigints and bytes; a boolean is 1/0 and undefined null
const bind = (p: unknown[]) => p.map(v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
export async function sqlite(file: string): Promise<Db> {
  if (isBun) {
    const { Database } = await import("bun:sqlite" as string);
    const db = new Database(file, { create: true });
    return {
      exec: s => db.exec(s),
      all: (s, p) => db.query(s).all(...bind(p)),
      run: (s, p) => { db.query(s).run(...bind(p)); },
      close: () => db.close(),
    };
  }
  let mod: any;
  try { mod = await import("node:sqlite" as string); }
  catch { throw new Error(`node:sqlite is missing: Huddle's server needs Node 22.5 or newer (before 22.13 with --experimental-sqlite), or Bun`); }
  const db = new mod.DatabaseSync(file);
  const cache = new Map<string, any>();
  const st = (s: string) => { let x = cache.get(s); if (!x) { x = db.prepare(s); cache.set(s, x); } return x; };
  return {
    exec: s => db.exec(s),
    all: (s, p) => st(s).all(...bind(p)),
    run: (s, p) => { st(s).run(...bind(p)); },
    close: () => { cache.clear(); db.close(); },
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
export interface Served { hostname: string; port: number; stop(force?: boolean): void }
export async function serve(o: { hostname: string; port: number; fetch: (req: Request) => Promise<Response> }): Promise<Served> {
  if (isBun) {
    const s = Bun.serve({ hostname: o.hostname, port: o.port, idleTimeout: 0, fetch: o.fetch }); // waits and live streams are long-lived by design
    return { hostname: s.hostname, port: s.port, stop: (force?: boolean) => s.stop(!!force) };
  }
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { void answer(o.fetch, req, res); });
  server.requestTimeout = 0; server.headersTimeout = 60_000; server.keepAliveTimeout = 5_000; server.timeout = 0;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port, o.hostname, () => { server.off("error", reject); resolve(); }); });
  const addr = server.address() as { port: number };
  return {
    hostname: o.hostname, port: addr.port,
    stop: (force?: boolean) => { server.close(); if (force) server.closeAllConnections(); else server.closeIdleConnections(); },
  };
}
// one request through the fetch handler: the body read whole (ours are small JSON), the response
// streamed as it comes (SSE), and req.signal aborted when the client goes away first
async function answer(fetch: (req: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse) {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  let response: Response;
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
    const method = req.method ?? "GET";
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = Buffer.concat(chunks);
    }
    const url = `http://${/^[\w.:[\]-]+$/.test(req.headers.host ?? "") ? req.headers.host : "invalid.host"}${req.url ?? "/"}`;
    response = await fetch(new Request(url, { method, headers, body: body?.length ? body : undefined, signal: ac.signal }));
  } catch (e) {
    response = new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, out);
  if (!response.body || req.method === "HEAD") { res.end(); return; }
  const reader = response.body.getReader();
  ac.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); }, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>(r => { res.once("drain", r); res.once("close", r); });
    }
    res.end();
  } catch { res.destroy(); }
}
