/**
 * The HTTP server. Loopback only, and only for us: a Host header naming anything but this exact port on
 * 127.0.0.1/localhost is a DNS-rebinding probe and gets 403 — no CORS headers exist to relax. GET/HEAD for
 * everything; the dashboard's own three writes (budgets, settings, dismissing an alert) also take PUT/POST, but
 * only as application/json (so another site cannot send one without a preflight we never answer), only from our
 * own origin when the browser names one, and only up to 64 KiB.
 * Static files come from a fixed allowlist (no user-controlled paths anywhere), and /api/stream is SSE: one
 * snapshot, then incremental updates and a heartbeat until the client goes away.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { publicDir } from "../shared/paths.ts";
import type { Store } from "../store/store.ts";
import type { Insights } from "./insights.ts";
import { handleApi, handleWrite } from "./routes.ts";

export type HttpOptions = {
  store: Store;
  version: string;
  startedAt: number;
  /** Tests pin the port before listen; production sets it after binding. */
  port?: number;
  heartbeatMs?: number;
  now?: () => number;
  /** Costs, budgets, alerts and the rest; absent in tests that only need the store. */
  insights?: Insights;
};

const WRITE_PATHS: Record<string, string> = {
  "/api/budgets": "PUT",
  "/api/settings": "PUT",
  "/api/alerts/dismiss": "POST",
};
const MAX_BODY = 64 * 1024;

type StaticEntry = { file: string; type: string };

const STATIC_FILES: Record<string, StaticEntry> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

const NO_STORE = { "Cache-Control": "no-store" };

export type FlightTracker = {
  /** Count one request until its response closes; SSE responses are not counted — they never finish. */
  track(res: ServerResponse): void;
  /** Resolve once nothing is counted, or after `timeoutMs` — whatever comes first. */
  whenIdle(timeoutMs: number): Promise<void>;
};

/**
 * The requests a shutdown must let finish. An SSE response is not one of them (it has answered;
 * its events run forever), so those are closed by the shutdown instead of awaited.
 */
export function createFlightTracker(): FlightTracker {
  let inFlight = 0;
  const waiting = new Set<() => void>();
  return {
    track(res) {
      inFlight += 1;
      res.on("close", () => {
        inFlight -= 1;
        if (inFlight > 0) return;
        for (const wake of waiting) wake();
        waiting.clear();
      });
    },
    whenIdle(timeoutMs) {
      if (inFlight === 0) return Promise.resolve();
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const wake = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          waiting.delete(wake);
          resolve();
        };
        timer = setTimeout(wake, timeoutMs);
        timer.unref();
        waiting.add(wake);
      });
    },
  };
}

function send(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  // byteLength, not .length: any non-ASCII glyph (an em-dash, say) is >1 UTF-8 byte per code unit, and a
  // short Content-Length makes the overflow parse as a phantom next response on the keep-alive connection
  res.writeHead(status, { "Content-Length": String(Buffer.byteLength(body, "utf8")), ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, `${JSON.stringify(body)}\n`, {
    "Content-Type": "application/json; charset=utf-8",
    ...NO_STORE,
  });
}

/**
 * A write must come from the dashboard itself: JSON (a cross-site form or a "simple" fetch cannot send that without a
 * preflight we never answer), and when the browser says where it came from, from our own origin.
 */
export function writeAllowed(headers: IncomingMessage["headers"], port: number): boolean {
  const type = headers["content-type"];
  if (typeof type !== "string" || !type.toLowerCase().startsWith("application/json")) return false;
  const origin = headers.origin;
  if (
    origin !== undefined &&
    origin !== `http://127.0.0.1:${port}` &&
    origin !== `http://localhost:${port}`
  ) {
    return false;
  }
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/** Only 127.0.0.1:<port> / localhost:<port> — an attacker's domain resolving here fails this check. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== "string") return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** One SSE client: snapshot on connect, store deltas after that, heartbeat to keep intermediaries honest. */
function streamClient(
  store: Store,
  res: ServerResponse,
  heartbeatMs: number,
  streams: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  writeSse(res, {
    type: "snapshot",
    summary: store.summary(),
    sessions: store.sessionList(),
    models: store.models(),
  });
  const unsubscribe = store.onUpdate((change) => {
    for (const request of change.requests) writeSse(res, { type: "request", request });
    for (const tool of change.tools) writeSse(res, { type: "tool", tool });
    for (const event of change.events) writeSse(res, { type: "event", event });
    if (change.sessions) {
      writeSse(res, {
        type: "sessions",
        sessions: store.sessionList(),
        summary: store.summary(),
        models: store.models(),
      });
    }
  });
  const beat = setInterval(() => res.write(":hb\n\n"), heartbeatMs);
  if (typeof beat.unref === "function") beat.unref();
  streams.add(res);
  res.on("close", () => {
    streams.delete(res);
    unsubscribe();
    clearInterval(beat);
  });
}

/**
 * Build the server. `state.port` is filled in by the caller after listen; requests that race in before that
 * are still host-checked against the eventual value because handler reads it live.
 */
export function createHttpServer(options: HttpOptions): {
  server: Server;
  state: { port: number };
  whenIdle: FlightTracker["whenIdle"];
  /** End every live SSE stream and cut the sockets; bun's closeAllConnections() leaves them open. */
  closeStreams(): void;
} {
  const { store } = options;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const state: { port: number } = { port: options.port ?? 0 };
  const dir = publicDir(process.env);
  const flights = createFlightTracker();
  const streams = new Set<ServerResponse>();

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${state.port}`);
    if (url.pathname !== "/api/stream") flights.track(res); // streams are closed on shutdown, not awaited
    if (!hostAllowed(req.headers.host, state.port)) {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeRoute(url.pathname, req, res);
      return;
    }
    route(url.pathname, req, res);
  }

  function writeRoute(path: string, req: IncomingMessage, res: ServerResponse): void {
    if (WRITE_PATHS[path] !== req.method) {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!writeAllowed(req.headers, state.port)) {
      sendJson(res, 403, { error: "writes take application/json from the dashboard only" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk); // past the limit: drained, never kept
    });
    req.on("end", () => {
      if (size > MAX_BODY) {
        sendJson(res, 413, { error: "body too large" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "body is not JSON" });
        return;
      }
      let answer: { status: number; body: unknown };
      try {
        answer = handleWrite(options.insights, req.method ?? "", path, body);
      } catch (error) {
        answer = { status: 500, body: { error: `could not save: ${(error as Error).message}` } };
      }
      sendJson(res, answer.status, answer.body);
    });
  }

  function route(path: string, req: IncomingMessage, res: ServerResponse): void {
    if (path === "/api/stream") {
      streamRoute(req, res);
      return;
    }
    if (path.startsWith("/api/")) {
      apiRoute(path, req, res);
      return;
    }
    if (path === "/metrics") {
      metricsRoute(req, res);
      return;
    }
    staticRoute(path, res);
  }

  function streamRoute(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "HEAD") {
      send(res, 200, "", { "Content-Type": "text/event-stream; charset=utf-8" });
      return;
    }
    streamClient(store, res, heartbeatMs, streams);
  }

  function metricsRoute(req: IncomingMessage, res: ServerResponse): void {
    const body = options.insights?.metrics(options.version) ?? "";
    const headers = { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", ...NO_STORE };
    if (req.method === "HEAD") {
      send(res, 200, "", headers);
      return;
    }
    send(res, 200, body, headers);
  }

  function apiRoute(path: string, req: IncomingMessage, res: ServerResponse): void {
    const answer = handleApi(
      store,
      { version: options.version, startedAt: options.startedAt, port: state.port },
      { path, query: new URL(req.url ?? "/", `http://127.0.0.1:${state.port}`).searchParams },
      options.insights,
    );
    if (req.method === "HEAD" && answer.status === 200) {
      send(res, 200, "", { "Content-Type": "application/json; charset=utf-8", ...NO_STORE });
      return;
    }
    sendJson(res, answer.status, answer.body);
  }

  function staticRoute(path: string, res: ServerResponse): void {
    const entry = STATIC_FILES[path];
    if (entry === undefined) {
      sendJson(res, 404, { error: `not found: ${path}` });
      return;
    }
    let body: string;
    try {
      body = readFileSync(join(dir, entry.file), "utf8");
    } catch {
      sendJson(res, 404, { error: `missing build artifact: ${entry.file}` });
      return;
    }
    send(res, 200, body, { "Content-Type": entry.type, ...NO_STORE });
  }

  const server = createServer(handle);
  function closeStreams(): void {
    for (const res of [...streams]) {
      res.end();
      res.socket?.destroy();
    }
    streams.clear();
  }
  return { server, state, whenIdle: flights.whenIdle, closeStreams };
}
