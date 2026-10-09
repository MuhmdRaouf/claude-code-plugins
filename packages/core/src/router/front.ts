// The router's front: the one process the plugin starts. It owns 127.0.0.1:<port> and never lets go of it while it
// runs, holds no provider logic and no key, and hands each request to one worker (today's router.ts, forked with
// node:cluster) over loopback. The worker is disposable: an exit is replaced at once, a hang (no heartbeat for 5 s) is
// killed and replaced, a worker over 512 MB or a hot update is recycled by forking the new one first and draining the
// old. A request the worker never sent upstream (it says so over IPC just before it does) is retried on the next
// worker, so a crash costs only the requests that were already talking to Anthropic. When workers will not stay up
// (3 exits in a minute, or one that never starts) the front serves requests itself through the passthrough for a
// minute, then tries one worker again. Claude traffic never sees a refused connection.
//
// When the plugin is removed (a `retire` control call from setup --remove, or the uninstall watch seeing the plugin
// uninstalled or disabled) the front retires instead of stopping: Claude Code sessions keep the base URL they started
// with, so the port stays open. A retired front drains its worker, passes every other request to Anthropic exactly as
// it came, answers this provider's models and peer hops with a non-retryable 400 that says to restart Claude Code,
// writes nothing more to the spool, and exits once its `RetiredWatch` says the sessions from before are gone.
import cluster from "node:cluster";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { claims, type ModelClaim } from "../domain/provider.ts";
import { healthEvent, type RouterHealth, type SpoolEvent } from "../domain/route-events.ts";
import { degradedMessage, type PassthroughOptions, passThrough } from "./passthrough.ts";
import { removedAnswer } from "./refusal.ts";
import type { PeerTarget } from "./registry.ts";
import { PEER_HOP, REQUEST_ID } from "./router.ts";
import {
  anthropicError,
  forwardHeaders,
  harden,
  type ProxyEnv,
  readBody,
  receive,
  refuseHost,
  requestModel,
  responseHeaders,
  TOKEN_HEADER,
  trackConnections,
  watchClient,
} from "./upstream.ts";

/** The front's protocol: its control endpoints and the worker IPC. A running front with another number cannot take a
 *  hot update; the starter hands its port to a fresh front instead. 2: the front hands its workers the data-path
 *  token, so a version-1 front, which forks workers without one, is replaced rather than hot-updated. */
export const FRONT_VERSION = 2;

/** The env name the front hands its token to a forked worker under, so the worker can require it on its data path
 *  (never logged, never sent anywhere but the loopback hop). */
export const WORKER_TOKEN_ENV = "PROVIDER_ROUTER_WORKER_TOKEN";

/** The key check's answer while the front has no worker up yet (just started, or replacing one). */
export const NO_WORKER = "no worker is running";

/** The header carrying the pid file's token on a control call (shared with the emergency passthrough). */
export { TOKEN_HEADER };

/** A forked worker as the front sees it. */
export interface WorkerHandle {
  readonly pid: number | undefined;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  send(message: unknown): void;
  kill(signal: NodeJS.Signals): void;
}

type ForkWorker = (exec: string, token: string) => WorkerHandle;

/** Forks `node <exec> worker` as a cluster worker; `cluster.setupPrimary({ exec })` is what a hot update re-points. */
function clusterFork(exec: string, token: string): WorkerHandle {
  cluster.setupPrimary({ exec, args: ["worker"] });
  // The token reaches the worker through its environment: the worker refuses its data path without it.
  const worker = cluster.fork({ [WORKER_TOKEN_ENV]: token });
  // A send to a worker that just died raises EPIPE on the worker object; the exit event handles the death.
  worker.on("error", () => undefined);
  return {
    pid: worker.process.pid,
    on: (event, listener) => {
      worker.on(event, listener as (...args: unknown[]) => void);
    },
    send: (message) => {
      try {
        if (worker.isConnected()) worker.send(message as object);
      } catch {
        // The exit handler deals with a dead worker.
      }
    },
    kill: (signal) => {
      try {
        worker.process.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
}

export interface FrontKnobs {
  /** How often the front checks its workers (and expects their heartbeat). */
  readonly heartbeatMs: number;
  /** No heartbeat for this long: the worker is hung and gets SIGKILL. */
  readonly hangMs: number;
  /** `degradeExits` worker exits inside this window put the front in degraded mode. */
  readonly exitWindowMs: number;
  readonly degradeExits: number;
  /** How long degraded mode lasts before one worker is tried again. */
  readonly degradedMs: number;
  /** A worker whose resident size passes this is recycled. */
  readonly rssLimitMb: number;
  /** A worker that does not listen within this long failed to start. */
  readonly startMs: number;
  /** How long a request waits for a worker before the front serves it itself. */
  readonly waitWorkerMs: number;
  /** How long a failed request waits to learn whether its worker had sent it upstream. */
  readonly ackWaitMs: number;
  /** The longest a draining worker (or a handed-over front) may take to finish its streams. */
  readonly drainMs: number;
  /** How long the key check waits for the worker's answer. */
  readonly keyCheckMs: number;
  /** The largest request body (64 MiB). */
  readonly bodyLimit: number;
}

const DEFAULT_KNOBS: FrontKnobs = {
  heartbeatMs: 1000,
  hangMs: 5000,
  exitWindowMs: 60_000,
  degradeExits: 3,
  degradedMs: 60_000,
  rssLimitMb: 512,
  startMs: 10_000,
  waitWorkerMs: 10_000,
  ackWaitMs: 2000,
  drainMs: 10 * 60_000,
  keyCheckMs: 3000,
  bodyLimit: 64 * 1024 * 1024,
};

/** The uninstall watch the front runs: every `everyMs`, `tick` says "retire" once the plugin is gone and its settings
 *  are restored; `cleanup` removes what the plugin left behind, just before the retired front exits. */
export interface FrontWatch {
  readonly everyMs: number;
  tick(): Promise<"stay" | "retire">;
  cleanup(): Promise<void>;
}

/** A retired front's exit check: every `everyMs`, `exit` gets the retirement time and says whether to go. */
export interface RetiredWatch {
  readonly everyMs: number;
  exit(retiredAt: number): Promise<boolean>;
}

export interface FrontOptions {
  readonly name: string;
  readonly display: string;
  readonly healthPath: string;
  /** The resolved provider's model claim, for the requests the front serves itself. */
  readonly claim: ModelClaim;
  /** The canonical port the base URL names. */
  readonly port: number;
  /** Where the front binds first: the canonical port, or a temporary one during a handover (then `/adopt`). */
  readonly listenPort?: number;
  readonly anthropic: URL;
  readonly env: ProxyEnv;
  /** The bundle's version, reported by health so the starter can tell a stale router. */
  readonly version: string;
  /** The front protocol this front speaks (default FRONT_VERSION; the chaos suite fakes an old one). */
  readonly frontVersion?: number;
  /** The pid file's token; control calls must carry it. */
  readonly token: string;
  /** The worker script. */
  readonly exec: string;
  readonly fork?: ForkWorker;
  readonly knobs?: Partial<FrontKnobs>;
  readonly idleMs?: number;
  readonly watch?: FrontWatch;
  /** Which other plugin's router serves a model: a retired front refuses those requests instead of hopping. */
  readonly peers?: (model: string) => PeerTarget | undefined;
  /** When a retired front exits; without one it stays until stopped. */
  readonly retiredWatch?: RetiredWatch;
  /** Called once when the front retires (production takes the registry entry out, so no peer forwards here). */
  readonly onRetire?: () => void;
  /** Supervision lines (exits, hangs, recycles, degraded transitions) for the router log and the crash log. */
  readonly note?: (line: string) => void;
  /** Per-request lines of the front's own passthrough. */
  readonly log?: (line: string) => void;
  /** Radar spool: a `fallback` health event per request the front serves itself, a `restart` per worker it
   *  has to replace, and one `restart` when it retires (nothing after it). */
  readonly events?: (event: SpoolEvent) => void;
  /** Called once the front is done (handed over, stopped, or retired and its sessions gone); production exits. */
  readonly done?: () => void;
  readonly now?: () => number;
}

interface Pending {
  acked: boolean;
}

interface WorkerState {
  readonly handle: WorkerHandle;
  readonly exec: string;
  readonly startedAt: number;
  port: number | undefined;
  lastHb: number;
  draining: boolean;
  exited: boolean;
  readonly inflight: Map<string, Pending>;
  readonly onExit: (() => void)[];
}

interface FrontStatus {
  readonly mode: "router" | "degraded" | "retired";
  readonly worker: "up" | "starting" | "down";
  readonly workerPid: number | undefined;
  readonly port: number | undefined;
}

export interface Front {
  /** Binds the listen port and forks the first worker; resolves with the bound port. */
  start(): Promise<number>;
  status(): FrontStatus;
  /** Stops everything at once (tests and shutdown): listeners, timers, workers. */
  close(): Promise<void>;
  /** Stops accepting (the port is free for a new front) and lets in-flight requests finish, then `done`. */
  drain(): void;
  /** Retires the front (see the header); `why` goes to the router log and the one spool event. Idempotent. */
  retire(why: string): void;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function createFront(options: FrontOptions): Front {
  const knobs: FrontKnobs = { ...DEFAULT_KNOBS, ...options.knobs };
  const now = options.now ?? Date.now;
  const note = options.note ?? (() => undefined);
  const fork = options.fork ?? clusterFork;
  // A retired front writes nothing more to the spool: the plugin is gone from the dashboard's point of view.
  const report = (event: RouterHealth, reason: string, model = ""): void => {
    if (retiredAt === undefined) options.events?.(healthEvent(options.name, event, reason, model, now()));
  };
  const passthrough = (state: string): PassthroughOptions => ({
    name: options.name,
    display: options.display,
    claim: options.claim,
    anthropic: options.anthropic,
    env: options.env,
    state,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  let exec = options.exec;
  let version = options.version;
  let current: WorkerState | undefined;
  let replacement: WorkerState | undefined;
  const draining = new Set<WorkerState>();
  let degradedUntil = 0;
  let degradeTimer: NodeJS.Timeout | undefined;
  let exits: number[] = [];
  let waiters: ((worker: WorkerState | undefined) => void)[] = [];
  let retiredAt: number | undefined;
  let closed = false;
  let accepting = true;
  let seq = 0;
  let listenPort = options.listenPort ?? options.port;
  const listeners = new Set<http.Server>();
  const connections = trackConnections((open) => {
    if (!accepting && open === 0) finish();
  });
  const keyQueries = new Map<string, (answer: unknown) => void>();

  const degraded = (): boolean => now() < degradedUntil;
  const ready = (worker: WorkerState | undefined): worker is WorkerState =>
    worker !== undefined && worker.port !== undefined && !worker.draining && !worker.exited;

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (refuseHost(req, res, options.name, [options.port, listenPort])) return;
    if (!accepting) res.setHeader("connection", "close");
    const path = req.url ?? "";
    if (path === options.healthPath && req.method === "GET") health(res);
    else if (path.startsWith(`${options.healthPath}/`))
      void control(req, res, path.slice(options.healthPath.length + 1));
    else request(req, res);
  }

  function request(req: IncomingMessage, res: ServerResponse): void {
    receive(req, res, options.name, knobs.bodyLimit, (body) => route(req, res, body, false));
  }

  function status(): FrontStatus {
    const worker = ready(current)
      ? "up"
      : current !== undefined || replacement !== undefined
        ? "starting"
        : "down";
    return {
      mode: retiredAt !== undefined ? "retired" : degraded() ? "degraded" : "router",
      worker,
      workerPid: current?.handle.pid,
      port: listenPort,
    };
  }

  function health(res: ServerResponse): void {
    const { mode, worker, workerPid } = status();
    json(res, 200, {
      ok: true,
      name: options.name,
      provider: options.display,
      mode,
      worker,
      version,
      frontVersion: options.frontVersion ?? FRONT_VERSION,
      pid: process.pid,
      ...(retiredAt === undefined ? {} : { retiredAt: new Date(retiredAt).toISOString() }),
      ...(workerPid === undefined ? {} : { workerPid }),
    });
  }

  // ── control: loopback and the pid file's token only ─────────────────────────────────────────────────────────────

  async function control(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress) || req.headers[TOKEN_HEADER] !== options.token) {
      anthropicError(res, 403, "permission_error", `${options.name} router: control refused`);
      return;
    }
    const body = await readBody(req, 64 * 1024).catch(() => "too-large" as const);
    const message = parse(body === "too-large" ? "" : body.toString("utf8"));
    const calls: Record<string, () => Promise<void> | void> = {
      "POST reload": () => reload(res, message),
      "POST handover": () => handoverNow(res),
      "POST retire": () => {
        const already = retiredAt !== undefined;
        retire("the plugin was removed (setup --remove)");
        json(res, 200, { ok: true, already, retiredAt: new Date(retiredAt ?? now()).toISOString() });
      },
      "POST adopt": async () => {
        const adopted = await adopt();
        json(res, adopted ? 200 : 500, { ok: adopted, port: listenPort });
      },
      "GET key": async () => json(res, 200, await keyCheck()),
    };
    const call = calls[`${req.method} ${action}`];
    if (call === undefined)
      anthropicError(res, 404, "not_found_error", `${options.name} router: unknown control call`);
    else await call();
  }

  /** A hot update: the next worker runs the new script; the port never closes. */
  function reload(res: ServerResponse, message: Record<string, unknown>): void {
    if (typeof message.exec === "string" && message.exec !== "") exec = message.exec;
    if (typeof message.version === "string") version = message.version;
    recycle("hot update");
    json(res, 200, { ok: true });
  }

  function handoverNow(res: ServerResponse): void {
    res.setHeader("connection", "close");
    json(res, 200, { ok: true });
    note("handover: stopped accepting; a new front takes the port");
    drain();
  }

  function parse(text: string): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Asks the worker whether it can read the provider's key (only the source comes back, never the key). */
  function keyCheck(): Promise<unknown> {
    if (!ready(current)) return Promise.resolve({ ok: false, error: NO_WORKER });
    const id = `k${++seq}`;
    const worker = current;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        keyQueries.delete(id);
        resolve({ ok: false, error: "the key lookup timed out" });
      }, knobs.keyCheckMs);
      keyQueries.set(id, (answer) => {
        clearTimeout(timer);
        keyQueries.delete(id);
        resolve(answer);
      });
      worker.handle.send({ t: "key", id });
    });
  }

  // ── requests ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A request that belongs to another plugin's router: a hop another router forwarded here, or a model this front's
   *  registry names a peer for. Anthropic cannot serve these, so the front's own paths must not send them there. */
  function peerBound(req: IncomingMessage, model: string): boolean {
    return req.headers[PEER_HOP] !== undefined || (model !== "" && options.peers?.(model) !== undefined);
  }

  /** Serves a request itself, the way the degraded front does; `why` is the fallback event's reason. A peer-bound
   *  request gets the honest 503: the front cannot hop, and the model is not Anthropic's to serve. */
  function direct(req: IncomingMessage, res: ServerResponse, body: Buffer, why: string): void {
    const model = requestModel(body);
    report("fallback", why, model);
    if (peerBound(req, model)) {
      const peer = model === "" ? undefined : options.peers?.(model);
      options.log?.(`${req.method} ${req.url} model=${model || "-"} → refused (degraded)`);
      anthropicError(
        res,
        503,
        "api_error",
        peer === undefined
          ? degradedMessage(passthrough("degraded after repeated crashes"))
          : `the ${peer.name} plugin's router serves ${model}; the degraded ${options.name} router cannot forward it; run /${peer.name}:setup.`,
      );
      return;
    }
    passThrough(passthrough("degraded after repeated crashes"), req, res, body);
  }

  /** A retired front's answer: this provider's models, peers' models and peer hops are refused with a 400 that is
   *  not retried; everything else goes to Anthropic exactly as it came. */
  function serveRetired(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const model = requestModel(body);
    const providerBound = peerBound(req, model) || claims(options.claim, model);
    if (!providerBound) {
      passThrough(passthrough("removed"), req, res, body);
      return;
    }
    options.log?.(`${req.method} ${req.url} model=${model || "-"} → refused (retired)`);
    const answer = removedAnswer(options.display);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }

  function route(req: IncomingMessage, res: ServerResponse, body: Buffer, retried: boolean): void {
    // The client is watched from the moment the body is here: one that leaves while a worker is waited for (or a
    // failed request retried) is answered by nobody, so nothing goes upstream for it.
    const gone = watchClient(res);
    if (gone()) return;
    if (retiredAt !== undefined) {
      serveRetired(req, res, body);
      return;
    }
    if (degraded()) {
      direct(req, res, body, "degraded after repeated worker exits");
      return;
    }
    void workerWithin(knobs.waitWorkerMs).then((worker) => {
      if (gone()) return;
      if (retiredAt !== undefined) serveRetired(req, res, body);
      else if (worker === undefined) direct(req, res, body, "no worker was ready");
      else toWorker(worker, req, res, body, retried);
    });
  }

  function workerWithin(ms: number): Promise<WorkerState | undefined> {
    if (ready(current)) return Promise.resolve(current);
    if (closed || degraded()) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((waiter) => waiter !== wake);
        resolve(ready(current) ? current : undefined);
      }, ms);
      const wake = (worker: WorkerState | undefined): void => {
        clearTimeout(timer);
        resolve(worker);
      };
      waiters.push(wake);
    });
  }

  function wakeWaiters(): void {
    const worker = ready(current) ? current : undefined;
    const woken = waiters;
    waiters = [];
    for (const wake of woken) wake(worker);
  }

  function toWorker(
    worker: WorkerState,
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    retried: boolean,
  ): void {
    const id = `r${++seq}`;
    const pending: Pending = { acked: false };
    worker.inflight.set(id, pending);
    const target = new URL(`http://127.0.0.1:${worker.port}`);
    const headers = forwardHeaders(req.headers, target, body.length);
    headers[REQUEST_ID] = id;
    // The worker refuses its data path without it; the worker strips it again before anything goes upstream.
    headers[TOKEN_HEADER] = options.token;
    const call = http.request({
      host: "127.0.0.1",
      port: worker.port,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    });
    let answered = false;
    call.on("response", (answer) => {
      answered = true;
      worker.inflight.delete(id);
      res.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
      answer.on("aborted", () => res.destroy());
      answer.on("close", () => {
        if (!answer.complete) res.destroy();
      });
      answer.pipe(res);
    });
    call.on("error", () => {
      if (answered || res.headersSent) {
        res.destroy();
        return;
      }
      // Whether the worker had sent it upstream is known once its IPC has drained: at its exit, or soon after.
      afterWorkerFate(worker, () => {
        worker.inflight.delete(id);
        if (!res.destroyed) afterFailure(req, res, body, pending.acked, retried);
      });
    });
    res.on("close", () => {
      if (!res.writableFinished) call.destroy();
    });
    call.end(body);
  }

  /** A request whose worker failed before answering: retried once when that worker never sent it upstream (then
   *  served directly if the retry fails too); a 502 when it may have reached the upstream. */
  function afterFailure(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    acked: boolean,
    retried: boolean,
  ): void {
    if (!acked && !retried) route(req, res, body, true);
    else if (!acked) direct(req, res, body, "the worker failed the request twice");
    else
      anthropicError(
        res,
        502,
        "api_error",
        `${options.name} router: the request was cut off by a router restart`,
      );
  }

  function afterWorkerFate(worker: WorkerState, then: () => void): void {
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      then();
    };
    if (worker.exited) {
      once();
      return;
    }
    worker.onExit.push(once);
    setTimeout(once, knobs.ackWaitMs).unref();
  }

  // ── supervision ─────────────────────────────────────────────────────────────────────────────────────────────────

  function spawn(script: string): WorkerState | undefined {
    if (closed) return undefined;
    let handle: WorkerHandle;
    try {
      handle = fork(script, options.token);
    } catch (error) {
      note(`worker fork failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const worker: WorkerState = {
      handle,
      exec: script,
      startedAt: now(),
      port: undefined,
      lastHb: now(),
      draining: false,
      exited: false,
      inflight: new Map(),
      onExit: [],
    };
    handle.on("message", (message) => onMessage(worker, message));
    handle.on("exit", (code, signal) => onExit(worker, code, signal));
    return worker;
  }

  function onMessage(worker: WorkerState, raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const { t, id, port, rss, ...answer } = raw as Record<string, unknown>;
    const ids = typeof id === "string" ? id : "";
    const handlers: Record<string, () => void> = {
      listening: () => (typeof port === "number" ? listening(worker, port) : undefined),
      hb: () => heartbeat(worker, rss),
      ack: () => acked(worker, ids),
      key: () => keyQueries.get(ids)?.(answer),
    };
    if (typeof t === "string" && Object.hasOwn(handlers, t)) handlers[t]?.();
  }

  function acked(worker: WorkerState, id: string): void {
    const pending = worker.inflight.get(id);
    if (pending !== undefined) pending.acked = true;
  }

  function listening(worker: WorkerState, port: number): void {
    worker.port = port;
    worker.lastHb = now();
    if (worker === replacement) promote(worker);
    else if (worker === current) wakeWaiters();
  }

  /** A heartbeat: proof the worker's event loop runs, and its resident size (a worker past the limit is recycled). */
  function heartbeat(worker: WorkerState, rss: unknown): void {
    worker.lastHb = now();
    if (typeof rss !== "number" || rss <= knobs.rssLimitMb || worker !== current || worker.draining) return;
    recycle(`worker at ${Math.round(rss)} MB, over ${knobs.rssLimitMb} MB`);
  }

  function promote(worker: WorkerState): void {
    const old = current;
    current = worker;
    replacement = undefined;
    wakeWaiters();
    if (old !== undefined && !old.exited) drainWorker(old);
  }

  function drainWorker(worker: WorkerState): void {
    worker.draining = true;
    draining.add(worker);
    worker.handle.send({ t: "drain", ms: knobs.drainMs });
    setTimeout(() => {
      if (!worker.exited) worker.handle.kill("SIGKILL");
    }, knobs.drainMs + 5000).unref();
  }

  function onExit(worker: WorkerState, code: number | null, signal: string | null): void {
    worker.exited = true;
    for (const then of worker.onExit.splice(0)) then();
    draining.delete(worker);
    const how = signal ?? `code ${code}`;
    if (worker === replacement) {
      replacement = undefined;
      note(`the new worker exited before it listened (${how}); the running one stays`);
    } else if (worker !== current) note(`a draining worker exited (${how})`);
    else {
      current = undefined;
      if (!closed) replaceExited(worker, how);
    }
  }

  /** The current worker exited: degrade when it never started or exits keep coming, else fork a replacement. */
  function replaceExited(worker: WorkerState, how: string): void {
    if (worker.port === undefined) {
      report("restart", `a worker failed to start (${how}); degraded`);
      degrade(`a worker failed to start (${how})`);
      return;
    }
    exits = [...exits.filter((at) => now() - at < knobs.exitWindowMs), now()];
    if (exits.length >= knobs.degradeExits) {
      report("restart", `worker exited (${how}); degraded after ${exits.length} exits`);
      degrade(`${exits.length} worker exits within ${knobs.exitWindowMs / 1000} s`);
      return;
    }
    report("restart", `worker exited (${how})`);
    note(`worker exited (${how}); forking a replacement`);
    current = spawn(worker.exec);
  }

  function degrade(why: string): void {
    degradedUntil = now() + knobs.degradedMs;
    exits = [];
    note(`degraded: ${why}; the front serves requests itself for ${knobs.degradedMs / 1000} s`);
    wakeWaiters();
    clearTimeout(degradeTimer);
    degradeTimer = setTimeout(() => {
      if (closed || current !== undefined || retiredAt !== undefined) return;
      note("degraded window over: trying one worker again");
      current = spawn(exec);
    }, knobs.degradedMs);
    degradeTimer.unref();
  }

  function recycle(why: string): void {
    if (closed || replacement !== undefined || retiredAt !== undefined) return;
    note(`${why}: forking a new worker, then draining the old one`);
    if (current === undefined) {
      degradedUntil = 0;
      current = spawn(exec);
      return;
    }
    replacement = spawn(exec);
  }

  function check(): void {
    for (const worker of [current, replacement, ...draining]) {
      const why = worker === undefined || worker.exited ? undefined : stuck(worker);
      if (why === undefined) continue;
      note(`${why}; killing it`);
      worker?.handle.kill("SIGKILL");
    }
  }

  /** Why a worker must go: it never listened, or its heartbeat stopped (a blocked event loop); undefined when well.
   *  A draining worker is exempt from the heartbeat check: it stopped heartbeating on purpose the moment its drain
   *  began (the worker clears the interval then, while its streams are still going), so the hang check read that as
   *  a hang and cut live answers mid-response. Only the drain limit — the kill timer `drainWorker` arms at
   *  `drainMs` — ends a draining worker; an active worker that stops heartbeating is killed as before. */
  function stuck(worker: WorkerState): string | undefined {
    if (worker.port === undefined)
      return now() - worker.startedAt > knobs.startMs
        ? `a worker did not listen within ${knobs.startMs / 1000} s`
        : undefined;
    if (worker.draining) return undefined;
    const silent = now() - worker.lastHb;
    return silent > knobs.hangMs ? `a worker sent no heartbeat for ${silent} ms (hung)` : undefined;
  }

  // ── listening, handover, shutdown ───────────────────────────────────────────────────────────────────────────────

  /** One server per port (the canonical one, and a handover's temporary one), all serving the same front. */
  function listen(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const listener = harden(http.createServer((req, res) => handle(req, res)));
      connections.watch(listener);
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", () => {
        listener.removeListener("error", reject);
        listeners.add(listener);
        resolve(listener);
      });
    });
  }

  /** The handover's second half, on the new front: take the canonical port, retrying for up to 2 s while the old
   *  front lets go of it, then drop the temporary one. */
  async function adopt(): Promise<boolean> {
    if (listenPort === options.port) return true;
    const temporary = [...listeners];
    for (let tried = 0; tried < 200; tried++) {
      try {
        await listen(options.port);
        listenPort = options.port;
        for (const listener of temporary) {
          listener.close();
          listeners.delete(listener);
        }
        note(`took over port ${options.port}`);
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return false;
  }

  let finished = false;
  function finish(): void {
    if (finished) return;
    finished = true;
    void close().then(() => options.done?.());
  }

  /** Stops accepting (the port is released for a new front), finishes what is in flight, then `done`. */
  function drain(): void {
    if (!accepting) return;
    accepting = false;
    for (const listener of listeners) listener.close();
    listeners.clear();
    connections.drain();
    // The worker keeps serving the connections still open; it is stopped once the last of them closes.
    if (connections.size === 0) finish();
    setTimeout(finish, knobs.drainMs).unref();
  }

  const timers: NodeJS.Timeout[] = [];

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    accepting = false;
    for (const timer of timers) clearInterval(timer);
    clearTimeout(degradeTimer);
    for (const listener of listeners) listener.close();
    listeners.clear();
    connections.closeAll();
    for (const worker of [current, replacement, ...draining]) worker?.handle.kill("SIGTERM");
    wakeWaiters();
  }

  let watching = false;
  async function watchTick(): Promise<void> {
    if (watching || closed || retiredAt !== undefined || options.watch === undefined) return;
    watching = true;
    try {
      if ((await options.watch.tick()) === "retire") retire("the plugin was uninstalled or disabled");
    } catch (error) {
      note(`uninstall watch failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      watching = false;
    }
  }

  /** The worker drains (its in-flight streams finish), the front serves everything itself from now on, and the exit
   *  check starts. */
  function retire(why: string): void {
    if (retiredAt !== undefined || closed) return;
    report("restart", `retired: ${why}; Claude requests pass through until the sessions that use it close`);
    retiredAt = now();
    note(`retired: ${why}; serving Claude requests until the sessions from before have closed`);
    clearTimeout(degradeTimer);
    degradedUntil = 0;
    drainWorkers();
    announceRetired();
    if (options.retiredWatch === undefined) return;
    const every = setInterval(() => void retiredTick(), options.retiredWatch.everyMs);
    every.unref();
    timers.push(every);
  }

  /** The current worker and any replacement drain; none is forked again. */
  function drainWorkers(): void {
    for (const worker of [current, replacement])
      if (worker !== undefined && !worker.exited) drainWorker(worker);
    current = undefined;
    replacement = undefined;
    wakeWaiters();
  }

  function announceRetired(): void {
    try {
      options.onRetire?.();
    } catch (error) {
      note(`retire hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let checkingRetired = false;
  async function retiredTick(): Promise<void> {
    if (checkingRetired || closed || !accepting || retiredAt === undefined) return;
    checkingRetired = true;
    try {
      if (!(await options.retiredWatch?.exit(retiredAt))) return;
      note(
        "retired: no Claude Code session from before the retirement is left, or the 7-day cap passed; exiting",
      );
      await options.watch?.cleanup();
      drain();
    } catch (error) {
      note(`retired exit check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      checkingRetired = false;
    }
  }

  return {
    async start() {
      await listen(listenPort);
      current = spawn(exec);
      const supervise = setInterval(check, knobs.heartbeatMs);
      supervise.unref();
      timers.push(supervise);
      if (options.watch !== undefined) {
        const watch = setInterval(() => void watchTick(), options.watch.everyMs);
        watch.unref();
        timers.push(watch);
        // One tick at once: the watch keeps the ledger in memory, and a plugin uninstalled within the first interval
        // after setup takes its data dir (and the ledger) with it before a delayed first tick could read it.
        void watchTick();
      }
      return listenPort;
    },
    status,
    close,
    drain,
    retire,
  };
}
