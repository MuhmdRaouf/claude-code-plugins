import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { SpoolEvent } from "../../src/domain/route-events.ts";
import {
  createFront,
  type Front,
  type FrontKnobs,
  type FrontOptions,
  TOKEN_HEADER,
  type WorkerHandle,
} from "../../src/router/front.ts";
import { freePort } from "../../src/router/process.ts";
import { REQUEST_ID } from "../../src/router/router.ts";

const HEALTH = "/acme-router/health";
const TOKEN = "front-token";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(10);
  }
}

async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as net.AddressInfo).port;
}

/** The fake Anthropic behind the front's own passthrough. */
async function anthropic(): Promise<URL> {
  const port = await serve((req, res) => {
    req.resume();
    req.on("end", () => res.end("from anthropic"));
  });
  return new URL(`http://127.0.0.1:${port}`);
}

type Behaviour = "ok" | "cut" | "cut-after-ack" | "abort-mid-body" | "hang";

let nextPid = 70_000;

/** An in-process worker: an http server on a loopback port, talking to the front through events like IPC. */
class FakeWorker implements WorkerHandle {
  readonly pid = nextPid++;
  readonly sent: unknown[] = [];
  readonly events = new EventEmitter();
  server: http.Server | undefined;
  exited = false;
  constructor(
    readonly exec: string,
    public behaviour: Behaviour,
    readonly listen: boolean,
    readonly answerKey: boolean,
  ) {}
  on(event: "message" | "exit", listener: (...args: never[]) => void): void {
    this.events.on(event, listener as (...args: unknown[]) => void);
  }
  message(value: unknown): void {
    this.events.emit("message", value);
  }
  async boot(): Promise<void> {
    if (!this.listen) return;
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.message({ t: "listening", port: (this.server.address() as net.AddressInfo).port });
  }
  handle(req: IncomingMessage, res: ServerResponse): void {
    req.resume();
    req.on("end", () => {
      const id = req.headers[REQUEST_ID];
      if (this.behaviour === "cut") return void req.socket.destroy();
      if (this.behaviour === "hang") return;
      this.message({ t: "ack", id });
      if (this.behaviour === "cut-after-ack") return void req.socket.destroy();
      if (this.behaviour === "abort-mid-body") {
        res.writeHead(200, { "content-length": "100" });
        res.write("partial");
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" });
      res.end(`worker ${this.pid}`);
    });
  }
  send(message: unknown): void {
    this.sent.push(message);
    const value = message as { t?: string; id?: string };
    if (value.t === "key" && this.answerKey)
      this.message({ t: "key", id: value.id, ok: true, source: "ACME_KEY" });
    if (value.t === "drain") void this.stop(null);
  }
  kill(signal: NodeJS.Signals): void {
    void this.stop(signal);
  }
  async stop(signal: string | null): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    this.server?.closeAllConnections();
    this.server?.close();
    await sleep(5);
    this.events.emit("exit", signal === null ? 0 : null, signal);
  }
}

interface Rig {
  readonly front: Front;
  readonly port: number;
  readonly workers: FakeWorker[];
  readonly notes: string[];
  readonly options: FrontOptions;
  done: number;
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: string }>;
  post(
    model: string,
    extra?: { path?: string; body?: string; headers?: Record<string, string> },
  ): Promise<{
    status: number;
    body: string;
  }>;
}

async function rig(
  setup: {
    knobs?: Partial<FrontKnobs>;
    behaviours?: Behaviour[];
    listen?: (index: number) => boolean;
    answerKey?: boolean;
    forkThrows?: boolean;
    options?: Partial<FrontOptions>;
  } = {},
): Promise<Rig> {
  const port = await freePort();
  const workers: FakeWorker[] = [];
  const notes: string[] = [];
  const options: FrontOptions = {
    name: "acme",
    display: "Acme Models",
    healthPath: HEALTH,
    claim: { ids: [], prefixes: ["big-"] },
    port,
    anthropic: await anthropic(),
    env: {},
    version: "v1",
    token: TOKEN,
    exec: "/stable/acme-router.js",
    knobs: {
      heartbeatMs: 20,
      hangMs: 200,
      exitWindowMs: 5000,
      degradeExits: 3,
      degradedMs: 300,
      startMs: 300,
      waitWorkerMs: 500,
      ackWaitMs: 100,
      drainMs: 1000,
      keyCheckMs: 100,
      ...setup.knobs,
    },
    fork: (exec) => {
      if (setup.forkThrows === true) throw new Error("no fork");
      const index = workers.length;
      const worker = new FakeWorker(
        exec,
        setup.behaviours?.[index] ?? "ok",
        setup.listen?.(index) ?? true,
        setup.answerKey ?? true,
      );
      workers.push(worker);
      void worker.boot();
      return worker;
    },
    note: (line) => notes.push(line),
    ...setup.options,
  };
  const r = {
    workers,
    notes,
    options,
    done: 0,
  } as unknown as Rig & { done: number };
  const front = createFront({ ...options, done: () => (r.done += 1) });
  cleanups.push(() => front.close());
  cleanups.push(() => {
    for (const worker of workers) void worker.stop("SIGKILL");
  });
  const bound = await front.start();
  const request = (
    method: string,
    path: string,
    body: string | undefined,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: bound,
          method,
          path,
          headers: { host: `127.0.0.1:${port}`, ...headers },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
          res.on("aborted", () => reject(new Error("aborted")));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  Object.assign(r, {
    front,
    port: bound,
    get: (path: string, headers?: Record<string, string>) => request("GET", path, undefined, headers),
    post: (model: string, extra: { path?: string; body?: string; headers?: Record<string, string> } = {}) =>
      request("POST", extra.path ?? "/v1/messages", extra.body ?? JSON.stringify({ model }), extra.headers),
  });
  return r;
}

const control = (r: Rig, action: string, body = "{}", token = TOKEN) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: r.port,
        method: action === "key" ? "GET" : "POST",
        path: `${HEALTH}/${action}`,
        headers: { host: `127.0.0.1:${r.options.port}`, [TOKEN_HEADER]: token },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end(action === "key" ? undefined : body);
  });

const health = async (r: Rig) => JSON.parse((await r.get(HEALTH)).body) as Record<string, unknown>;

describe("the front: requests", () => {
  it("hands requests to its worker and reports itself in health", async () => {
    const r = await rig();
    await until(() => r.front.status().worker === "up");

    expect(await r.post("claude-x")).toEqual({ status: 200, body: `worker ${r.workers[0]?.pid}` });
    expect(await health(r)).toMatchObject({
      ok: true,
      name: "acme",
      provider: "Acme Models",
      mode: "router",
      worker: "up",
      version: "v1",
      frontVersion: 1,
      workerPid: r.workers[0]?.pid,
    });
  });

  it("refuses a foreign Host, a path that could change the upstream host, and a body over the limit", async () => {
    const r = await rig({ knobs: { bodyLimit: 10 } });

    expect((await r.get("/v1/models", { host: "evil.example" })).status).toBe(421);
    expect((await r.post("claude-x", { path: "//other-host/x" })).status).toBe(400);
    const big = await r.post("claude-x", { body: "x".repeat(100) });
    expect(big.status).toBe(413);
    expect(JSON.parse(big.body)).toMatchObject({ type: "error", error: { type: "request_too_large" } });
  });

  it("waits for a worker that is still starting instead of refusing", async () => {
    const r = await rig({ listen: (index) => index > 0 });
    // The first worker never listens; after startMs the front kills it, but meanwhile requests wait.
    expect(r.front.status().worker).toBe("starting");
    const answer = await r.post("claude-x");
    expect(answer.status).toBe(200);
  });

  it("retries a request the worker never sent upstream on the next worker", async () => {
    const r = await rig({ behaviours: ["cut", "ok"] });
    await until(() => r.front.status().worker === "up");
    const first = r.workers[0];
    const answering = r.post("claude-x");
    await sleep(30);
    void first?.stop("SIGKILL");
    const answer = await answering;
    expect(answer).toEqual({ status: 200, body: `worker ${r.workers[1]?.pid}` });
  });

  it("answers a 502 when the worker had already sent the request upstream", async () => {
    const r = await rig({ behaviours: ["cut-after-ack"] });
    await until(() => r.front.status().worker === "up");
    const answer = await r.post("claude-x");
    expect(answer.status).toBe(502);
    expect(answer.body).toContain("cut off by a router restart");
  });

  it("serves a request itself when its retry is cut too", async () => {
    const r = await rig({ behaviours: ["cut", "cut"] });
    await until(() => r.front.status().worker === "up");
    const answer = await r.post("claude-x");
    expect(answer).toEqual({ status: 200, body: "from anthropic" });
  });

  it("ends the client's answer when the worker's answer stops mid-body", async () => {
    const r = await rig({ behaviours: ["abort-mid-body"] });
    await until(() => r.front.status().worker === "up");
    await expect(r.post("claude-x")).rejects.toThrow();
  });

  it("stops the worker's request when the client goes away", async () => {
    const r = await rig({ behaviours: ["hang"] });
    await until(() => r.front.status().worker === "up");
    const socket = net.connect(r.port, "127.0.0.1");
    socket.write(
      `POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1:${r.options.port}\r\ncontent-length: 2\r\n\r\n{}`,
    );
    await sleep(50);
    socket.destroy();
    await sleep(50);
    expect(r.workers[0]?.exited).toBe(false);
  });
});

describe("the front: health events", () => {
  /** The front's events, without their timestamps. */
  const eventsOf = (events: SpoolEvent[]) => events.map(({ ts: _ts, ...rest }) => rest);

  it("records a restart per worker it replaces, the degraded one saying so, and a fallback per request it serves", async () => {
    const events: SpoolEvent[] = [];
    const r = await rig({ knobs: { degradedMs: 300 }, options: { events: (event) => events.push(event) } });
    for (let exit = 0; exit < 3; exit++) {
      await until(() => r.front.status().worker === "up");
      void r.workers.at(-1)?.stop("SIGKILL");
      await until(() => r.workers.at(-1)?.exited === true);
    }
    await until(() => r.front.status().mode === "degraded");
    await r.post("claude-x");
    await r.post("big-model", { body: '{"model":"big-model","messages":[{"content":"private"}]}' });
    expect(eventsOf(events)).toEqual([
      {
        kind: "router.event",
        plugin: "acme",
        event: "restart",
        reason: "worker exited (SIGKILL)",
        model: null,
      },
      {
        kind: "router.event",
        plugin: "acme",
        event: "restart",
        reason: "worker exited (SIGKILL)",
        model: null,
      },
      {
        kind: "router.event",
        plugin: "acme",
        event: "restart",
        reason: "worker exited (SIGKILL); degraded after 3 exits",
        model: null,
      },
      {
        kind: "router.event",
        plugin: "acme",
        event: "fallback",
        reason: "degraded after repeated worker exits",
        model: "claude-x",
      },
      {
        kind: "router.event",
        plugin: "acme",
        event: "fallback",
        reason: "degraded after repeated worker exits",
        model: "big-model",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("names why it served a request itself: a worker that failed it twice, a worker that never started", async () => {
    const twice: SpoolEvent[] = [];
    const cut = await rig({ behaviours: ["cut", "cut"], options: { events: (event) => twice.push(event) } });
    await until(() => cut.front.status().worker === "up");
    await cut.post("claude-x");
    expect(eventsOf(twice)).toContainEqual({
      kind: "router.event",
      plugin: "acme",
      event: "fallback",
      reason: "the worker failed the request twice",
      model: "claude-x",
    });
    const none: SpoolEvent[] = [];
    const forkless = await rig({
      forkThrows: true,
      knobs: { waitWorkerMs: 50 },
      options: { events: (event) => none.push(event) },
    });
    await forkless.post("claude-x", { body: "not json" });
    expect(eventsOf(none)).toEqual([
      { kind: "router.event", plugin: "acme", event: "fallback", reason: "no worker was ready", model: null },
    ]);
  });

  it("records a worker that fails to start as a restart into degraded mode", async () => {
    const events: SpoolEvent[] = [];
    const r = await rig({
      listen: () => false,
      knobs: { startMs: 5000 },
      options: { events: (event) => events.push(event) },
    });
    void r.workers[0]?.stop(null);
    await until(() => r.front.status().mode === "degraded");
    expect(eventsOf(events)).toEqual([
      {
        kind: "router.event",
        plugin: "acme",
        event: "restart",
        reason: "a worker failed to start (code 0); degraded",
        model: null,
      },
    ]);
  });
});

describe("the front: supervision", () => {
  it("replaces a worker that exits, and degrades after three exits in the window, then recovers", async () => {
    const r = await rig({ knobs: { degradedMs: 300 } });
    for (let exit = 0; exit < 3; exit++) {
      await until(() => r.front.status().worker === "up");
      void r.workers.at(-1)?.stop("SIGKILL");
      await until(() => r.workers.at(-1)?.exited === true);
    }
    await until(() => r.front.status().mode === "degraded");
    expect(r.notes.join("\n")).toContain("degraded: 3 worker exits");
    expect(await r.post("claude-x")).toEqual({ status: 200, body: "from anthropic" });
    const provider = await r.post("big-model");
    expect(provider.status).toBe(503);
    expect(provider.body).toContain(
      "Acme Models router degraded after repeated crashes; Claude models still work.",
    );
    await until(() => r.front.status().mode === "router" && r.front.status().worker === "up");
    expect((await r.post("claude-x")).status).toBe(200);
  });

  it("degrades at once when a worker exits before it listens", async () => {
    const r = await rig({ listen: () => false, knobs: { startMs: 5000 } });
    void r.workers[0]?.stop(null);
    await until(() => r.front.status().mode === "degraded");
    expect(r.notes.join("\n")).toContain("a worker failed to start");
    expect(await r.post("claude-x")).toEqual({ status: 200, body: "from anthropic" });
  });

  it("kills a worker that never listens, and one whose heartbeat stops", async () => {
    const r = await rig({ listen: (index) => index !== 0 });
    await until(() => r.notes.some((line) => line.includes("did not listen")));
    await until(() => r.front.status().worker === "up", 3000);
    // No heartbeat from the fake: it is hung.
    await until(() => r.notes.some((line) => line.includes("no heartbeat")));
  });

  it("keeps a worker that heartbeats, and recycles one over the memory limit: the new one first, then a drain", async () => {
    const r = await rig({ knobs: { rssLimitMb: 100, hangMs: 10_000 } });
    await until(() => r.front.status().worker === "up");
    const first = r.workers[0] as FakeWorker;
    first.message({ t: "hb", rss: 50 });
    first.message({ t: "hb", rss: 600 });
    await until(() => r.workers.length === 2 && r.front.status().workerPid === r.workers[1]?.pid);
    expect(first.sent).toContainEqual({ t: "drain", ms: 1000 });
    await until(() => r.notes.some((line) => line.includes("a draining worker exited")));
  });

  it("notes a fork that throws and serves requests itself", async () => {
    const r = await rig({ forkThrows: true, knobs: { waitWorkerMs: 50 } });
    expect(r.notes.join("\n")).toContain("worker fork failed: no fork");
    expect(await r.post("claude-x")).toEqual({ status: 200, body: "from anthropic" });
  });

  it("ignores messages that are not its protocol", async () => {
    const r = await rig();
    await until(() => r.front.status().worker === "up");
    const worker = r.workers[0] as FakeWorker;
    worker.message(null);
    worker.message("hello");
    worker.message({ t: "ack", id: "unknown" });
    worker.message({ t: "unknown" });
    expect(r.front.status().worker).toBe("up");
  });
});

describe("the front: control endpoints", () => {
  it("refuses a call without the token, and an unknown action", async () => {
    const r = await rig();
    expect((await control(r, "reload", "{}", "wrong")).status).toBe(403);
    expect((await control(r, "explode")).status).toBe(404);
  });

  it("reload recycles the worker onto the new script and reports the new version", async () => {
    const r = await rig({ knobs: { hangMs: 10_000, startMs: 10_000 }, listen: (index) => index !== 2 });
    await until(() => r.front.status().worker === "up");
    const reloaded = await control(r, "reload", JSON.stringify({ exec: "/stable/new.js", version: "v2" }));
    expect(reloaded).toEqual({ status: 200, body: '{"ok":true}' });
    await until(() => r.front.status().workerPid === r.workers[1]?.pid);
    expect(r.workers[1]?.exec).toBe("/stable/new.js");
    expect((await health(r)).version).toBe("v2");
    // A reload whose new worker never listens leaves the running one in place.
    await control(r, "reload", "not json");
    await sleep(10);
    void r.workers[2]?.stop("SIGKILL");
    await until(() => r.notes.some((line) => line.includes("the running one stays")));
    expect(r.front.status().workerPid).toBe(r.workers[1]?.pid);
  });

  it("answers the key check through the worker, and says when it cannot", async () => {
    const r = await rig();
    await until(() => r.front.status().worker === "up");
    expect(JSON.parse((await control(r, "key")).body)).toEqual({ ok: true, source: "ACME_KEY" });

    const silent = await rig({ answerKey: false });
    await until(() => silent.front.status().worker === "up");
    expect(JSON.parse((await control(silent, "key")).body)).toEqual({
      ok: false,
      error: "the key lookup timed out",
    });

    const none = await rig({ forkThrows: true });
    expect(JSON.parse((await control(none, "key")).body)).toEqual({
      ok: false,
      error: "no worker is running",
    });
  });

  it("hands over: stops accepting so a new front can bind, finishes open connections, then is done", async () => {
    const r = await rig();
    await until(() => r.front.status().worker === "up");
    expect(await control(r, "handover")).toEqual({ status: 200, body: '{"ok":true}' });
    await until(() => r.done === 1);
    const taker = net.createServer();
    await new Promise<void>((resolve) => taker.listen(r.port, "127.0.0.1", resolve));
    taker.close();
  });

  it("adopts the canonical port from a temporary one, retrying while it is still taken", async () => {
    const canonical = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(canonical, "127.0.0.1", resolve));
    const r = await rig({ options: { port: canonical, listenPort: await freePort() } });
    const adopting = control(r, "adopt");
    await sleep(50);
    blocker.close();
    expect(JSON.parse((await adopting).body)).toEqual({ ok: true, port: canonical });
    expect(r.front.status().port).toBe(canonical);
    expect(JSON.parse((await control({ ...r, port: canonical } as Rig, "adopt")).body)).toEqual({
      ok: true,
      port: canonical,
    });
  });

  it("gives up adopting a port that stays taken", async () => {
    const canonical = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(canonical, "127.0.0.1", resolve));
    cleanups.push(() => blocker.close());
    const r = await rig({ options: { port: canonical, listenPort: await freePort() } });
    expect((await control(r, "adopt")).status).toBe(500);
  });
});

describe("the front: the uninstall watch and shutdown", () => {
  it("runs the watch, survives a failing tick, and finishes when it says exit", async () => {
    let ticks = 0;
    const r = await rig({
      options: {
        watch: {
          everyMs: 20,
          tick: async (idle) => {
            ticks += 1;
            if (ticks === 1) throw new Error("bad tick");
            return ticks >= 3 && idle >= 0 ? "exit" : "stay";
          },
        },
      },
    });
    await until(() => r.done === 1);
    expect(r.notes.join("\n")).toContain("uninstall watch failed: bad tick");
    expect(r.notes.join("\n")).toContain("uninstalled and idle: exiting");
  });

  it("ticks once at start, before the first interval, so a quick uninstall still finds the ledger", async () => {
    let ticks = 0;
    await rig({
      options: {
        watch: {
          everyMs: 60_000,
          tick: async () => {
            ticks += 1;
            return "stay";
          },
        },
      },
    });
    await until(() => ticks === 1);
  });

  it("drain without open connections is done at once, and a second drain changes nothing", async () => {
    const r = await rig();
    r.front.drain();
    r.front.drain();
    await until(() => r.done === 1);
    await r.front.close();
    await r.front.close();
  });
});
