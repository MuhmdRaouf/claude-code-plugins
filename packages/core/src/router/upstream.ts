// The HTTP plumbing every router process shares: the front, the worker and the emergency passthrough. Node built-ins
// only, so the emergency bundle that imports it stays free of any dependency. It owns the hardening every server
// gets, the Anthropic-shaped error, the bounded body read, the single-leading-slash path rule, and the upstream
// request: keep-alive agents, the caller's proxy environment, one retry on a socket the upstream had already closed,
// an idle timeout on silence (never a total one) and a client stream that always ends when the upstream does.
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** The environment a router process reads its proxy settings from. */
export type ProxyEnv = Readonly<Record<string, string | undefined>>;

/** The largest request body any router process accepts; a larger one gets an Anthropic-shaped 413. */
export const BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/** An upstream that sends nothing (no headers, no byte of the body) for this long is given up on: silence, not a
 *  total duration, so a stream that keeps talking is never cut however long it runs. */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/** Headers that describe one connection, never the message: they are not copied across a hop. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Answers with Anthropic's error shape, so Claude Code shows the message instead of a parse failure. */
export function anthropicError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/** Server settings that never cut a Claude connection: keep-alive longer than any client's, no request timeout (long
 *  uploads), headers bounded. Streamed responses carry no timeout at all. */
export function harden(server: http.Server): http.Server {
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

/** The sockets of one or more servers, tracked the same way on Node and Bun. Bun's closeAllConnections() leaves a
 *  streaming response open, Bun 1.3's closeIdleConnections() leaves idle keep-alive sockets open, and Bun 1.3 cannot
 *  serve a socket handed to a server that does not listen itself, so every router server listens on its own port and
 *  the router closes sockets itself: drain() ends each one with no request in flight now and each other one as soon as
 *  its last response is done, closeAll() ends every one at once. */
interface Connections {
  /** Tracks this server's sockets from now on. */
  watch(server: http.Server): void;
  /** Open sockets. */
  readonly size: number;
  drain(): void;
  closeAll(): void;
}

/** Connection tracking; `closed` runs after each socket closes, with how many are still open. */
export function trackConnections(closed: (open: number) => void = () => undefined): Connections {
  // Each open socket and its requests in flight.
  const sockets = new Map<Duplex, number>();
  let draining = false;
  const closeIdle = (): void => {
    for (const [socket, inFlight] of sockets) if (inFlight === 0) socket.destroy();
  };
  const opened = (socket: Duplex): void => {
    sockets.set(socket, 0);
    socket.on("close", () => {
      sockets.delete(socket);
      closed(sockets.size);
    });
  };
  const responded = (socket: Duplex): void => {
    const inFlight = sockets.get(socket);
    if (inFlight === undefined) return;
    sockets.set(socket, Math.max(0, inFlight - 1));
    // Draining: a keep-alive socket whose last response just went out closes now, not at the drain deadline.
    if (draining && inFlight <= 1) setImmediate(closeIdle);
  };
  const requested = (req: IncomingMessage, res: ServerResponse): void => {
    const socket = req.socket;
    sockets.set(socket, (sockets.get(socket) ?? 0) + 1);
    let done = false;
    const end = (): void => {
      if (done) return;
      done = true;
      responded(socket);
    };
    res.on("finish", end);
    res.on("close", end);
  };
  return {
    watch(server) {
      server.on("connection", opened);
      server.on("request", requested);
    },
    get size() {
      return sockets.size;
    },
    drain() {
      draining = true;
      closeIdle();
    },
    closeAll() {
      for (const socket of sockets.keys()) socket.destroy();
    },
  };
}

/** A request path the router may forward: exactly one leading slash. `//host/x` would make the upstream URL resolve to
 *  another host, so it is refused (and so is anything absolute). */
export function safePath(path: string | undefined): string | undefined {
  if (path === undefined || !path.startsWith("/") || path.startsWith("//")) return undefined;
  return path;
}

/** The upstream URL: the target's origin, its path prefix, then the request path, never `new URL(path, base)`. */
export function upstreamUrl(target: URL, path: string): URL {
  return new URL(`${target.origin}${target.pathname.replace(/\/$/, "")}${path}`);
}

/** Reads the whole body, or "too-large" once it passes the limit (the rest is drained, not buffered). */
export function readBody(
  req: IncomingMessage,
  limit: number = BODY_LIMIT_BYTES,
): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? "too-large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The header carrying the pid file's token on a control call to a front or an emergency passthrough. */
export const TOKEN_HEADER = "x-provider-router-token";

/** The Host check every router server runs first (DNS rebinding): true, after answering 421, when the request does not
 *  name one of the ports as 127.0.0.1 or localhost. */
export function refuseHost(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  ports: readonly number[],
): boolean {
  const host = req.headers.host ?? "";
  if (ports.some((port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return false;
  anthropicError(res, 421, "invalid_request_error", `${name} router: wrong Host`);
  return true;
}

/** Reads a request to be forwarded: a path that would change the host is answered 400, a body over the limit 413
 *  (closing the connection); otherwise `then` gets the whole body. A request stream that errors is destroyed. */
export function receive(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  limit: number,
  then: (body: Buffer) => void,
): void {
  if (safePath(req.url) === undefined) {
    anthropicError(res, 400, "invalid_request_error", `${name} router: bad request path`);
    return;
  }
  readBody(req, limit).then(
    (body) => {
      if (body !== "too-large") return then(body);
      res.setHeader("connection", "close");
      anthropicError(res, 413, "request_too_large", `${name} router: request body over 64 MiB`);
    },
    () => res.destroy(),
  );
}

/** The `model` field of a JSON body, or "" when there is none (unparsable bodies included: never block on them). */
export function requestModel(body: Buffer): string {
  try {
    const model: unknown = JSON.parse(body.toString("utf8"))?.model;
    return typeof model === "string" ? model : "";
  } catch {
    return "";
  }
}

/** Watches a client's close from the moment its request body is in: `gone()` turns true once the client has left —
 *  a close that fired before this was called included — so nothing is forwarded for a request nobody waits for. */
export function watchClient(res: ServerResponse): () => boolean {
  let gone = res.destroyed;
  res.on("close", () => (gone = true));
  return () => gone;
}

/** The client's headers for the next hop: hop-by-hop ones dropped, Host and Content-Length set for the target. */
export function forwardHeaders(
  incoming: IncomingHttpHeaders,
  target: URL,
  length: number,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  }
  out.host = target.host;
  out["content-length"] = String(length);
  return out;
}

/** Response headers that describe one hop's connection or framing, not the answer. */
const RESPONSE_HOP: ReadonlySet<string> = new Set(["connection", "keep-alive", "transfer-encoding"]);

/** The upstream's response headers for the client: the connection-level ones belong to each hop, and so does the
 *  framing. Each server frames the body it sends itself (chunked when no length is known); a copied
 *  `transfer-encoding: chunked` over a body ended in one piece made Bun 1.3 send it unchunked next to a
 *  Content-Length, an answer the next hop rejects as invalid. */
export function responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !RESPONSE_HOP.has(name)) out[name] = value;
  }
  return out;
}

// ── the proxy environment ────────────────────────────────────────────────────────────────────────────────────────────

function envValue(env: ProxyEnv, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** True when NO_PROXY exempts the host: `*`, the host itself, or a domain suffix (`.corp`, `corp`, `*.corp`). */
export function noProxy(host: string, port: string, env: ProxyEnv): boolean {
  const list = envValue(env, "NO_PROXY");
  if (list === undefined) return false;
  return list
    .split(/[\s,]+/)
    .filter((entry) => entry !== "")
    .some((entry) => {
      if (entry === "*") return true;
      const [name = "", only] = entry.split(":");
      if (only !== undefined && only !== port) return false;
      const domain = name.replace(/^\*?\./, "").toLowerCase();
      const lower = host.toLowerCase();
      return lower === domain || lower.endsWith(`.${domain}`);
    });
}

/** The router's own environment with loopback exempt from any proxy: NO_PROXY (and no_proxy) gain 127.0.0.1 and
 *  localhost whenever a proxy is set. The front, its worker and the peer routers talk over loopback, and Bun 1.3's
 *  HTTP client applies HTTP_PROXY to every request it sends unless NO_PROXY exempts the host. */
export function exemptLoopback(env: Readonly<Record<string, string>>): Record<string, string> {
  const keys = Object.keys(env);
  if (!keys.some((key) => /^https?_proxy$/i.test(key) && env[key]?.trim() !== "")) return { ...env };
  const noProxyKeys = keys.filter((key) => key.toLowerCase() === "no_proxy");
  const current =
    env.no_proxy ?? env.NO_PROXY ?? (noProxyKeys[0] === undefined ? "" : env[noProxyKeys[0]]) ?? "";
  const entries = current.split(/[\s,]+/).filter((entry) => entry !== "");
  for (const loopback of ["127.0.0.1", "localhost"]) if (!entries.includes(loopback)) entries.push(loopback);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() !== "no_proxy") out[key] = value;
  return { ...out, NO_PROXY: entries.join(","), no_proxy: entries.join(",") };
}

/** The proxy a request to the target goes through, from HTTPS_PROXY/HTTP_PROXY (either case), or undefined. */
export function proxyFor(target: URL, env: ProxyEnv): URL | undefined {
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  if (noProxy(target.hostname.replace(/^\[|\]$/g, ""), port, env)) return undefined;
  const raw = envValue(env, target.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY");
  if (raw === undefined) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

/** Node's own proxy support (NODE_USE_ENV_PROXY=1, Node 24.5+) handles agents given `proxyEnv`; otherwise the agent
 *  opens a CONNECT tunnel itself, the same on every Node version. */
function builtinProxy(env: ProxyEnv): boolean {
  return env.NODE_USE_ENV_PROXY === "1";
}

type Connect = (
  options: Record<string, unknown>,
  done: (error: Error | null, socket?: Duplex) => void,
) => void;

/** A call's view of the CONNECT tunnel it may ask for: the CONNECT hangs here while the proxy has not answered it, so
 *  the call can abort it, and it is gone again once the tunnel is up (destroying it then would kill the live socket).
 *  It rides on the request options, the only channel into the agent's createConnection. */
interface Tunnel {
  /** How long the CONNECT may go unanswered: the call's idle budget. */
  readonly idleMs: number;
  /** The unanswered CONNECT, when there is one. */
  connect?: http.ClientRequest | undefined;
}

/** The request options a tunnel reads. */
type TunnelOptions = http.RequestOptions & { readonly tunnel?: Tunnel };

/** Opens a CONNECT tunnel through the proxy to host:port, wrapped in TLS for an https target. */
function tunnel(proxy: URL, secure: boolean): Connect {
  return (options, done) => {
    const host = String(options.host ?? options.hostname ?? "");
    const port = Number(options.port) || (secure ? 443 : 80);
    const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const headers: Record<string, string> = { host: authority };
    if (proxy.username !== "")
      headers["proxy-authorization"] =
        `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const { tunnel } = options as TunnelOptions;
    const connect = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: authority,
      headers,
      agent: false,
    });
    // A proxy that accepts the connection and never answers CONNECT hangs the call here — the idle timeout cannot
    // reach this phase (no socket belongs to the call yet), so the CONNECT keeps its own, the same idle budget.
    const settle = (): void => {
      clearTimeout(guard);
      if (tunnel !== undefined) tunnel.connect = undefined;
    };
    let guard: NodeJS.Timeout | undefined;
    if (tunnel !== undefined) {
      tunnel.connect = connect;
      guard = setTimeout(() => {
        connect.destroy(Object.assign(new Error("proxy CONNECT timed out"), { code: "ETIMEDOUT" }));
      }, tunnel.idleMs);
    }
    connect.once("connect", (answer, socket) => {
      settle();
      if (answer.statusCode !== 200) {
        socket.destroy();
        done(new Error(`proxy CONNECT ${authority} answered ${answer.statusCode}`));
        return;
      }
      if (!secure) return done(null, socket);
      const { host: _host, port: _port, path: _path, ...rest } = options;
      done(null, tls.connect({ ...rest, socket, servername: String(options.servername ?? host) }));
    });
    connect.once("error", (error) => {
      settle();
      done(error);
    });
    connect.end();
  };
}

const agents = new Map<string, http.Agent>();

/** True on Bun 1.3: its node:http client proxies from the environment by itself (see agentFor). */
export function bunProxiesItself(bun: string | undefined = process.versions.bun): boolean {
  if (bun === undefined) return false;
  const [major = 0, minor = 0] = bun.split(".").map(Number);
  return major < 1 || (major === 1 && minor < 4);
}

const BUN_PROXIES_ITSELF = bunProxiesItself();

/** The keep-alive agent for a target: direct, through Node's built-in proxy support, or through our own tunnel. A
 *  fresh one (no pooling) is made for a retry, so it can never be handed the same dead socket again. */
export function agentFor(target: URL, env: ProxyEnv, fresh = false): http.Agent {
  const secure = target.protocol === "https:";
  const proxy = proxyFor(target, env);
  const key = `${target.protocol}|${proxy?.href ?? "direct"}|${builtinProxy(env)}`;
  const cached = fresh ? undefined : agents.get(key);
  if (cached !== undefined) return cached;
  const Agent = secure ? https.Agent : http.Agent;
  const options: Record<string, unknown> = { keepAlive: !fresh, maxSockets: 256 };
  if (proxy !== undefined && builtinProxy(env)) options.proxyEnv = { ...env };
  const agent = new Agent(options);
  // Bun before 1.4 ignores an agent's createConnection (and cannot send CONNECT) but applies the proxy environment to
  // every request itself, NO_PROXY included; on it the tunnel is left out and Bun's own proxying does the same job.
  if (proxy !== undefined && !builtinProxy(env) && !BUN_PROXIES_ITSELF) {
    (agent as unknown as { createConnection: Connect }).createConnection = tunnel(proxy, secure);
  }
  if (!fresh) agents.set(key, agent);
  return agent;
}

// ── one request upstream ─────────────────────────────────────────────────────────────────────────────────────────────

interface UpstreamCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string | string[]>;
  readonly body: Buffer;
  readonly env: ProxyEnv;
  /** Loopback peers and the worker are dialled directly and never through a proxy. */
  readonly direct?: boolean;
  readonly idleMs?: number;
}

/** What a reused keep-alive socket fails with when the upstream had closed it — Node's reused-socket heuristic for a
 *  request that usually never arrived (see sendUpstream for the honest reading). */
const STALE_SOCKET: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE"]);

export type UpstreamFailure = { readonly code: string; readonly afterHeaders: boolean };

/** What the client gets instead of an upstream answer the caller chose to rewrite. */
export interface Replacement {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
}

/** The most of an answer `inspect` may hold back before deciding; a longer one goes out unchanged. */
export const INSPECT_LIMIT_BYTES = 64 * 1024;

/** The content encodings an inspection can read through. */
const INSPECT_ENCODINGS: ReadonlySet<string> = new Set(["gzip", "deflate", "br"]);

/** The body an inspection reads: the answer's own bytes when they are plain, their decompressed copy when the
 *  provider compressed them — never more decompressed than the inspect limit — and the raw bytes back when they
 *  cannot be read (an encoding that fails says nothing; it never fails the request). */
export function inspectBody(body: Buffer, encoding: string | string[] | undefined): Buffer {
  const name = (Array.isArray(encoding) ? encoding[0] : encoding)?.trim().toLowerCase() ?? "";
  if (!INSPECT_ENCODINGS.has(name)) return body;
  try {
    const options = { maxOutputLength: INSPECT_LIMIT_BYTES };
    if (name === "gzip") return gunzipSync(body, options);
    if (name === "deflate") return inflateSync(body, options);
    return brotliDecompressSync(body, options);
  } catch {
    return body;
  }
}

/** Sends one request and pipes the answer into `res`, byte for byte except where `rewrite` rewrites the passing
 *  bytes. An ECONNRESET or EPIPE on a reused keep-alive socket, before any answer byte, is retried once on a fresh
 *  connection: Node's documented reused-socket heuristic, which is usually right — the upstream closed the idle
 *  socket before the request arrived — but cannot be proven from the error alone, and in the rare case the upstream
 *  had already read the request the retry executes it a second time (an accepted risk; dropping the retry would
 *  surface an idle-socket reset to Claude Code instead). Every other failure is reported once through `failed`;
 *  after the headers went out an event-stream answer ends with Anthropic's terminal error event and any other client
 *  stream is destroyed, so it ends instead of hanging. The client going away aborts the upstream call. */
export function sendUpstream(
  call: UpstreamCall,
  res: ServerResponse,
  hooks: {
    readonly answered?: (answer: IncomingMessage) => void;
    /** Called with each straight answer before it is piped: return a stream to pipe the answer through first — a
     *  rewrite of the bytes as they pass — or undefined to pipe it as it came. Never called when `inspect` held the
     *  answer back. */
    readonly rewrite?: (answer: IncomingMessage) => Duplex | undefined;
    readonly failed: (failure: UpstreamFailure) => void;
    readonly finished?: (answer: IncomingMessage) => void;
    /** Called with each answer before anything is sent: return a judge to hold the (short) answer back and decide on
     *  its whole body, undefined to stream it at once. The judge returns a replacement, or undefined to send the
     *  answer as it came. An answer over INSPECT_LIMIT_BYTES is sent as it came without asking the judge. */
    readonly inspect?: (answer: IncomingMessage) => ((body: Buffer) => Replacement | undefined) | undefined;
    /** Called when a held answer outgrew the inspect limit and was released without its judge ever running — the
     *  caller's one notice that the judge (and anything it was to record) is skipped for this answer. */
    readonly oversize?: (answer: IncomingMessage) => void;
  },
): void {
  let settled = false;
  let rewrite: Duplex | undefined;
  // The answer's own content-type, kept for the failed ending below (a written head is not readable back).
  let contentType: string | string[] | undefined;
  // Whether the answer's bytes so far end between two events, so a terminal event never joins a cut one.
  let atBoundary = true;
  const fail = (code: string, afterHeaders: boolean): void => {
    if (settled) return;
    settled = true;
    if (afterHeaders)
      endFailed(res, contentType, rewrite, atBoundary, `upstream connection failed (${code})`);
    hooks.failed({ code, afterHeaders });
  };
  const attempt = (retry: boolean): void => {
    const secure = call.url.protocol === "https:";
    const agent = call.direct === true ? undefined : agentFor(call.url, call.env, retry);
    const client = secure ? https : http;
    const idle = call.idleMs ?? IDLE_TIMEOUT_MS;
    // An agent may open the tunnel itself; this is where it finds the idle budget and hangs its unanswered CONNECT.
    const tunnel: Tunnel = { idleMs: idle };
    const options: TunnelOptions = {
      method: call.method,
      headers: call.headers,
      ...(agent === undefined ? { agent: false } : { agent }),
      tunnel,
    };
    const upstream = client.request(call.url, options);
    let errored = false;
    const onError = (error: NodeJS.ErrnoException): void => {
      if (errored) return;
      errored = true;
      const code = error.code ?? "EUPSTREAM";
      if (res.headersSent) fail(code, true);
      else if (!retry && upstream.reusedSocket && STALE_SOCKET.has(code)) attempt(true);
      else fail(code, false);
    };
    upstream.setTimeout(idle, () => {
      const error = Object.assign(new Error("idle"), { code: "ETIMEDOUT" });
      upstream.destroy(error);
      // Bun 1.3 emits no 'error' for a request destroyed with one: the timeout reports itself (once, either way).
      onError(error);
    });
    upstream.on("response", (answer) => {
      if (settled) {
        answer.destroy();
        return;
      }
      const judge = hooks.inspect?.(answer);
      hooks.answered?.(answer);
      contentType = answer.headers["content-type"];
      answer.on("data", (chunk: Buffer) => {
        if (chunk.length > 0) atBoundary = chunk.subarray(-2).toString("latin1") === "\n\n";
      });
      // A cut answer fails after the headers when they went out; a held-back one has sent nothing yet.
      answer.on("error", () => fail("EABORTED", res.headersSent));
      answer.on("aborted", () => fail("EABORTED", res.headersSent));
      answer.on("close", () => {
        if (!answer.complete) fail("EABORTED", res.headersSent);
      });
      // A held-back answer is decided (and sent) before `finished` hears of it.
      if (judge === undefined) res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
      else holdBack(answer, res, judge, () => hooks.oversize?.(answer));
      answer.on("end", () => {
        settled = true;
        hooks.finished?.(answer);
      });
      // Straight through, or through the caller's rewrite of the passing bytes first.
      rewrite = hooks.rewrite?.(answer);
      if (judge === undefined) pipeThrough(answer, res, rewrite, fail);
    });
    upstream.on("error", onError);
    // The client went away mid-answer (Esc in Claude Code): stop the upstream request too — and the CONNECT tunnel it
    // may still be waiting for (destroying the request alone never reaches an in-flight CONNECT).
    res.on("close", () => {
      if (!res.writableFinished) {
        tunnel.connect?.destroy();
        upstream.destroy();
      }
    });
    upstream.end(call.body);
  };
  attempt(false);
}

/** Ends a response whose headers already went out and whose upstream then failed: a text/event-stream answer gets
 *  Anthropic's terminal error event, so the client reads a typed end instead of a cut socket; any other answer is
 *  destroyed as before. The rewrite's unread bytes are dropped first, so nothing of the cut answer passes the error
 *  event. */
function endFailed(
  res: ServerResponse,
  contentType: string | string[] | undefined,
  rewrite: Duplex | undefined,
  atBoundary: boolean,
  message: string,
): void {
  rewrite?.destroy();
  if (!res.headersSent || res.destroyed || res.writableEnded) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  if (String(contentType).includes("text/event-stream")) {
    const event = JSON.stringify({ type: "error", error: { type: "api_error", message } });
    // A stream cut inside an event closes that event first, so the error event always arrives whole and on its own.
    res.write(`${atBoundary ? "" : "\n\n"}event: error\ndata: ${event}\n\n`);
    res.end();
    return;
  }
  res.destroy();
}

/** Pipes a straight answer into `res`, through the caller's rewrite of the passing bytes first when one is given; a
 *  rewrite that fails ends the client stream, exactly as a cut answer would. */
function pipeThrough(
  answer: IncomingMessage,
  res: ServerResponse,
  rewrite: Duplex | undefined,
  fail: (code: string, afterHeaders: boolean) => void,
): void {
  if (rewrite === undefined) {
    answer.pipe(res);
    return;
  }
  rewrite.on("error", () => fail("EABORTED", true));
  answer.pipe(rewrite).pipe(res);
}

/** Buffers a short answer for the judge, then sends its replacement or the answer itself; an answer that outgrows the
 *  limit is released as it came, the held part first, its judge never run (`released` says so). */
function holdBack(
  answer: IncomingMessage,
  res: ServerResponse,
  judge: (body: Buffer) => Replacement | undefined,
  released: () => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  const release = (): void => {
    answer.removeListener("data", collect);
    answer.removeListener("end", decide);
    released();
    res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
    for (const chunk of chunks.splice(0)) res.write(chunk);
    answer.pipe(res);
  };
  const collect = (chunk: Buffer): void => {
    chunks.push(chunk);
    size += chunk.length;
    if (size > INSPECT_LIMIT_BYTES) release();
  };
  const decide = (): void => {
    if (res.destroyed) return;
    const body = Buffer.concat(chunks);
    const replacement = judge(body);
    if (replacement === undefined) {
      res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
      res.end(body);
      return;
    }
    res.writeHead(replacement.status, replacement.headers);
    res.end(replacement.body);
  };
  answer.on("data", collect);
  answer.on("end", decide);
}
