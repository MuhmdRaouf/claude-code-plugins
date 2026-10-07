// The chaos suite: real router processes (front, worker, emergency passthrough) on ephemeral ports, with a fake
// Anthropic and a fake provider upstream, and a fault injected in each case. The invariant every case checks: a
// `claude-*` request issued during or right after the fault gets the fake Anthropic's exact bytes, streaming and not.
// Only the provider's own models may fail, and then with an Anthropic-shaped error.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSettingsPath } from "../../src/adapters/claude-settings.ts";
import { ensureRouter } from "../../src/router/ensure.ts";
import { readPidFile } from "../../src/router/pidfile.ts";
import { commandLineOf, freePort, startRouter } from "../../src/router/process.ts";
import { saveRegistryEntry } from "../../src/router/registry.ts";
import { testRuntime } from "../support/runtime.ts";
import { tempDir } from "../support/tmp.ts";
import { sleep } from "../support/wait.ts";
import { CHAOS_PROVIDER } from "./support/chaos-provider.ts";

const SUPPORT = join(import.meta.dirname, "support");
/** The runtime every router process of the suite runs on (TEST_RUNTIME=bun runs the suite on bun). */
const RUNTIME = testRuntime();
const HEALTH = CHAOS_PROVIDER.router.healthPath;
/** The provider key every case runs with: a value that must never appear in anything the router writes or answers. */
const SENTINEL = `KEY-SENTINEL-${randomBytes(12).toString("hex")}`;

// ── the fake Anthropic and the fake provider ───────────────────────────────────────────────────────────────────────

const JSON_ANSWER =
  '{"id":"msg_chaos","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}';
const SSE_EVENTS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_chaos"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"o"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"k"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
const SSE_ANSWER = SSE_EVENTS.join("");

/** What the fake Anthropic answers a body with: a long body's size and hash, else the fixed message or stream. */
function expectedFor(body: string): string {
  if (body.length > 1024 * 1024)
    return JSON.stringify({
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  return JSON.parse(body).stream === true ? SSE_ANSWER : JSON_ANSWER;
}

interface Fake {
  readonly port: number;
  readonly url: string;
  readonly server: http.Server;
  requests: number;
}

const closers: (() => void)[] = [];

async function listen(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  closers.push(() => {
    server.close();
    server.closeAllConnections();
  });
  return (server.address() as net.AddressInfo).port;
}

/** The fake's stream: the fixed events, or `ticks` events `slowMs` apart when the body asks for them. */
function stream(res: http.ServerResponse, json: Record<string, unknown>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ticks = typeof json.ticks === "number" ? json.ticks : undefined;
  const events =
    ticks === undefined ? SSE_EVENTS : Array.from({ length: ticks }, (_, i) => `data: {"tick":${i}}\n\n`);
  const gap = typeof json.slowMs === "number" ? json.slowMs : 5;
  let i = 0;
  const next = (): void => {
    if (res.destroyed) return;
    const event = events[i++];
    if (event === undefined) return void res.end();
    res.write(event);
    setTimeout(next, gap);
  };
  next();
}

/** The fake Anthropic. A stream request whose body carries `ticks` streams that many events `slowMs` apart instead of
 *  the fixed answer; `keepAliveMs` shortens how long it keeps an idle connection. */
async function fakeAnthropic(options: { keepAliveMs?: number } = {}) {
  const fake = { requests: 0 } as { requests: number };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      fake.requests += 1;
      const body = Buffer.concat(chunks).toString("utf8") || "{}";
      const json = body.length <= 1024 * 1024 ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (json.stream === true) return stream(res, json);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(expectedFor(body));
    });
  });
  if (options.keepAliveMs !== undefined) server.keepAliveTimeout = options.keepAliveMs;
  const port = await listen(server);
  return Object.assign(fake, { port, url: `http://127.0.0.1:${port}`, server }) as Fake;
}

/** A slow stream's request body: `ticks` events, `slowMs` apart. */
const slowStream = (ticks: number, slowMs: number): string =>
  JSON.stringify({ model: "claude-sonnet-5-5", stream: true, ticks, slowMs, messages: [] });

/** The fake provider: answers its model, or hangs when `hang` is set. */
async function fakeProvider(options: { hang?: boolean } = {}) {
  const fake = { requests: 0 } as { requests: number };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      fake.requests += 1;
      if (options.hang === true) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"provider":true}');
    });
  });
  const port = await listen(server);
  return Object.assign(fake, { port, url: `http://127.0.0.1:${port}/anthropic`, server }) as Fake;
}

/** A provider that misbehaves the way the request body's `mode` asks, quoting the key it was sent wherever it can: a
 *  401 or a 429 or a 500 echoing the Authorization header, malformed JSON, a reset, silence. */
async function trickyProvider() {
  const fake = { requests: 0 } as { requests: number };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      fake.requests += 1;
      const mode = (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { mode?: string }).mode;
      const echoed = JSON.stringify({
        error: { message: `bad ${req.headers.authorization}`, headers: req.headers },
      });
      const answers: Record<string, () => void> = {
        echo401: () => res.writeHead(401, { "content-type": "application/json" }).end(echoed),
        echo429: () => res.writeHead(429, { "content-type": "application/json" }).end(echoed),
        echo500: () =>
          res.writeHead(500, { "content-type": "text/plain" }).end(`${req.headers.authorization}`),
        badjson: () => res.writeHead(200, { "content-type": "application/json" }).end("{not json"),
        reset: () => req.socket.destroy(),
        hang: () => undefined,
      };
      (answers[mode ?? ""] ?? answers.badjson)?.();
    });
  });
  const port = await listen(server);
  return Object.assign(fake, { port, url: `http://127.0.0.1:${port}/anthropic`, server }) as Fake;
}

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

// ── clients ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** One request on a fresh connection (or the given agent); rejects on a connection error or a cut stream. */
function send(
  port: number,
  model: string,
  options: { stream?: boolean; body?: string; agent?: http.Agent } = {},
) {
  const body = options.body ?? JSON.stringify({ model, stream: options.stream === true, messages: [] });
  return new Promise<Answer>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/messages?beta=true",
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-oauth" },
        agent: options.agent ?? false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("aborted", () => reject(new Error("aborted")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A claude request must come back as the fake Anthropic's exact bytes. */
async function expectClaude(port: number, stream: boolean, agent?: http.Agent): Promise<void> {
  const answer = await send(port, "claude-sonnet-5-5", { stream, ...(agent === undefined ? {} : { agent }) });
  expect(answer).toEqual({ status: 200, body: stream ? SSE_ANSWER : JSON_ANSWER });
}

async function expectClaudeBoth(port: number): Promise<void> {
  await expectClaude(port, false);
  await expectClaude(port, true);
}

/** Polls until the check passes or the time is up (then the last failure is thrown). */
async function until<T>(check: () => Promise<T>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(50);
    }
  }
}

// ── the rig: one router per case, in its own temp dir, killed afterwards ──────────────────────────────────────────

const pids = new Set<number>();

afterEach(() => {
  for (const pid of pids) {
    try {
      // The front is its own process-group leader (detached); its workers share the group.
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  pids.clear();
  for (const close of closers.splice(0)) close();
});

interface Health {
  readonly ok: boolean;
  readonly mode: string;
  readonly worker?: string;
  readonly pid: number;
  readonly workerPid?: number;
  readonly version?: string;
}

async function rig(
  options: {
    env?: Record<string, string | undefined>;
    tuning?: Record<string, number>;
    provider?: Fake;
  } = {},
) {
  const dir = tempDir("chaos-");
  const dist = join(dir, "dist");
  const state = join(dir, "state");
  mkdirSync(dist, { recursive: true });
  const writeRouter = (extra = ""): void =>
    writeFileSync(
      join(dist, "chaos-router.js"),
      `import ${JSON.stringify(join(SUPPORT, "chaos-router.ts"))};\n${extra}`,
    );
  writeRouter();
  writeFileSync(
    join(dist, "chaos-passthrough.js"),
    `import ${JSON.stringify(join(SUPPORT, "chaos-passthrough.ts"))};\n`,
  );
  const anthropic = await fakeAnthropic();
  const provider = options.provider ?? (await fakeProvider());
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: join(dir, "home"),
    CHAOS_STATE_DIR: state,
    CHAOS_ROUTER_PORT: String(port),
    CHAOS_ROUTER_ANTHROPIC_URL: anthropic.url,
    CHAOS_ROUTER_URL: provider.url,
    CHAOS_API_KEY: SENTINEL,
    PROVIDER_ROUTERS_HOME: join(dir, "routers"),
    OBSERVATORY_HOME: join(dir, "observatory"),
    CHAOS_ROUTER_TUNING: JSON.stringify({
      heartbeatMs: 250,
      hangMs: 4000,
      exitWindowMs: 10_000,
      degradedMs: 3000,
      startMs: 10_000,
      startWaitMs: 20_000,
      ...options.tuning,
    }),
    ...options.env,
  };
  const health = async (): Promise<Health> => {
    const answer = await fetch(`http://127.0.0.1:${port}${HEALTH}`, { signal: AbortSignal.timeout(2000) });
    const value = (await answer.json()) as Health;
    pids.add(value.pid);
    return value;
  };
  const start = async () => {
    const result = await startRouter({
      provider: CHAOS_PROVIDER,
      env,
      stateRoot: state,
      distDir: dist,
      node: RUNTIME,
      budgetMs: 30_000,
      healthWaitMs: 20_000,
    });
    const record = readPidFile(state);
    if (record !== undefined) pids.add(record.pid);
    return result;
  };
  /** Waits until the router has a listening worker other than `not`. */
  const workerUp = (not?: number) =>
    until(async () => {
      const value = await health();
      if (value.worker !== "up" || value.workerPid === undefined || value.workerPid === not)
        throw new Error(`worker ${value.worker} ${value.workerPid}`);
      return value;
    });
  return { dir, dist, state, port, env, anthropic, provider, health, start, workerUp, writeRouter };
}

/** The executable a process runs on: the basename of its command line's first word. */
function runtimeOf(pid: number): string | undefined {
  const first = commandLineOf(pid)?.split(" ")[0];
  return first === undefined ? undefined : basename(first);
}

/** Starts the router and waits for its worker. */
async function upRig(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  const started = await r.start();
  expect(started).toMatchObject({ ok: true });
  const up = await r.workerUp();
  // The matrix is real: the front and the worker it forked both run on the runtime under test.
  expect(runtimeOf(up.pid)).toBe(basename(RUNTIME));
  expect(runtimeOf(up.workerPid as number)).toBe(basename(RUNTIME));
  return r;
}

/** Clients hammering claude requests until stopped; counts answers that are not the exact bytes. With `retries`, a
 *  connection refused or reset before any answer is retried that many times, 10 ms apart, as Claude Code's client does
 *  with backoff (a listener that closes resets the connections still in its backlog): only one that outlasts them
 *  counts. A budget in attempts, not in wall-clock time, so a loaded machine slows the clients and the router alike. */
function load(port: number, clients: number, retries = 0, paceMs = 0) {
  let running = true;
  const stats = { ok: 0, failed: 0, errors: [] as string[] };
  const attempt = async (stream: boolean): Promise<Answer> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(port, "claude-sonnet-5-5", { stream });
      } catch (error) {
        // A reset before any answer, as Claude Code retries it: Node names one kind "socket hang up" (code ECONNRESET).
        const { message, code } = error as NodeJS.ErrnoException;
        const reset = /ECONNREFUSED|ECONNRESET|socket hang up/.test(message) || code === "ECONNRESET";
        if (!reset || attempt >= retries) throw error;
        await sleep(10);
      }
    }
  };
  /** One request's failure, or undefined when it got the exact bytes. */
  const failure = async (stream: boolean): Promise<string | undefined> => {
    try {
      const answer = await attempt(stream);
      const exact = answer.status === 200 && answer.body === (stream ? SSE_ANSWER : JSON_ANSWER);
      return exact ? undefined : `${answer.status} ${answer.body.slice(0, 120)}`;
    } catch (error) {
      return (error as Error).message;
    }
  };
  const loops = Array.from({ length: clients }, async (_, i) => {
    while (running) {
      const failed = await failure(i % 2 === 1);
      if (failed === undefined) stats.ok += 1;
      else {
        stats.failed += 1;
        stats.errors.push(failed);
      }
      if (paceMs > 0) await sleep(paceMs);
    }
  });
  return {
    stats,
    stop: async () => {
      running = false;
      await Promise.all(loops);
      return stats;
    },
  };
}

function processesRunning(pattern: string): number {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("chaos: a claude-* request gets Anthropic's exact bytes whatever happens to the router", () => {
  it("a) SIGKILL the worker mid-stream: that stream may fail, the next requests succeed", async () => {
    const r = await upRig();
    await expectClaudeBoth(r.port);
    const before = await r.health();
    const streaming = send(r.port, "claude-sonnet-5-5", { body: slowStream(20, 200) }).catch(
      (error: Error) => error,
    );
    await sleep(600);
    process.kill(before.workerPid as number, "SIGKILL");
    const cut = await streaming;
    // Cut mid-stream: the client sees the stream end early (or an error), never a hang and never the whole stream.
    const outcome =
      cut instanceof Error
        ? "error"
        : cut.body.split("\n\n").filter(Boolean).length < 20
          ? "truncated"
          : "complete";
    expect(["error", "truncated"]).toContain(outcome);
    await expectClaudeBoth(r.port);
    const after = await r.workerUp(before.workerPid);
    expect(after.workerPid).not.toBe(before.workerPid);
    await expectClaudeBoth(r.port);
  });

  it("b) SIGKILL the worker 10 times in a row under 20 parallel clients", async () => {
    const r = await upRig({ tuning: { degradedMs: 2000 } });
    const traffic = load(r.port, 20);
    let last = (await r.health()).workerPid;
    for (let kill = 0; kill < 10; kill++) {
      await sleep(150);
      const now = await r.health();
      if (now.workerPid !== undefined) {
        process.kill(now.workerPid, "SIGKILL");
        last = now.workerPid;
      }
      await expectClaudeBoth(r.port);
    }
    const stats = await traffic.stop();
    expect(last).toBeDefined();
    expect(stats.ok).toBeGreaterThan(100);
    // Only requests already talking to Anthropic when their worker died may fail.
    expect(stats.failed).toBeLessThanOrEqual(stats.ok / 10);
    await r.workerUp();
    await expectClaudeBoth(r.port);
  });

  it("c) block the worker's event loop: the front kills it and a fresh worker serves the request", async () => {
    const r = await upRig();
    const before = await r.health();
    // SIGSTOP freezes the worker exactly like a blocked event loop: no heartbeat, nothing answered.
    process.kill(before.workerPid as number, "SIGSTOP");
    await expectClaude(r.port, false);
    // The front's own record says why: the frozen worker's heartbeat stopped and it was killed.
    expect(readFileSync(join(r.state, "router", "router.log"), "utf8")).toContain("(hung); killing it");
    const after = await r.health();
    expect(after.workerPid).not.toBe(before.workerPid);
    await expectClaude(r.port, true);
  });

  it("d) a worker crash loop puts the front in degraded mode, then it recovers after the window", async () => {
    const r = await upRig({ tuning: { degradedMs: 4000 } });
    for (let kill = 0; kill < 3; kill++) {
      const now = await r.workerUp();
      process.kill(now.workerPid as number, "SIGKILL");
      await until(async () => {
        const value = await r.health();
        if (value.workerPid === now.workerPid) throw new Error("same worker");
      });
    }
    await until(async () => {
      if ((await r.health()).mode !== "degraded") throw new Error("not degraded yet");
    });
    await expectClaudeBoth(r.port);
    const provider = await send(r.port, "chaos-big");
    expect(provider.status).toBe(503);
    expect(JSON.parse(provider.body)).toMatchObject({
      type: "error",
      error: {
        message: expect.stringContaining(
          "degraded after repeated crashes; Claude models still work. Run /chaos:setup.",
        ),
      },
    });
    const recovered = await until(async () => {
      const value = await r.health();
      if (value.mode !== "router" || value.worker !== "up") throw new Error("still degraded");
      return value;
    }, 20_000);
    expect(recovered.mode).toBe("router");
    await expectClaudeBoth(r.port);
    expect((await send(r.port, "chaos-big")).status).toBe(200);
  });

  it("e) SIGKILL the front: ensure brings the router back within one prompt", async () => {
    const r = await upRig();
    const before = await r.health();
    process.kill(-before.pid, "SIGKILL");
    await until(async () => {
      if (
        await fetch(`http://127.0.0.1:${r.port}${HEALTH}`).then(
          () => true,
          () => false,
        )
      )
        throw new Error("still up");
    });
    const started = Date.now();
    const ensured = await ensureRouter({
      name: "chaos",
      envPrefix: "CHAOS",
      defaultPort: r.port,
      env: r.env,
      routerScript: join(r.dist, "chaos-router.js"),
      node: RUNTIME,
    });
    const ensureMs = Date.now() - started;
    expect(ensured).toBe("started");
    const back = await r.workerUp();
    // The hook never waits for the router: it is back before the router it started is even up.
    expect(ensureMs).toBeLessThan(Date.now() - started - ensureMs);
    expect(back.pid).not.toBe(before.pid);
    await expectClaudeBoth(r.port);
    expect(
      await ensureRouter({
        name: "chaos",
        envPrefix: "CHAOS",
        defaultPort: r.port,
        env: r.env,
        routerScript: join(r.dist, "chaos-router.js"),
        node: RUNTIME,
      }),
    ).toBe("up");
  });

  it("f) a corrupt worker bundle means degraded; a corrupt router bundle means the emergency passthrough; repair hands back", async () => {
    // The main model is overridden to an id outside the chaos- prefix: every process must still claim it.
    const r = await upRig({ env: { CHAOS_MODEL_MAIN: "odd-model-7" } });
    expect(await send(r.port, "odd-model-7")).toEqual({ status: 200, body: '{"provider":true}' });
    expect(await send(r.port, "other-vendor-1")).toEqual({ status: 200, body: JSON_ANSWER });
    const registered = JSON.parse(readFileSync(join(r.dir, "routers", "chaos.json"), "utf8")) as {
      catalogIds: string[];
    };
    expect(registered.catalogIds).toContain("odd-model-7");
    const before = await r.health();
    writeFileSync(join(r.state, "router", "chaos-router.js"), "this is not javascript {{{\n");
    process.kill(before.workerPid as number, "SIGKILL");
    await until(async () => {
      if ((await r.health()).mode !== "degraded") throw new Error("not degraded");
    });
    await expectClaudeBoth(r.port);
    expect((await send(r.port, "chaos-big")).status).toBe(503);
    expect((await send(r.port, "odd-model-7")).status).toBe(503);
    expect(await send(r.port, "other-vendor-1")).toEqual({ status: 200, body: JSON_ANSWER });

    // The whole router bundle broken by an update: a fresh start falls back to the emergency passthrough.
    process.kill(-before.pid, "SIGKILL");
    await sleep(200);
    writeFileSync(join(r.dist, "chaos-router.js"), "syntax error here (((\n");
    const emergency = await r.start();
    expect(emergency).toMatchObject({ ok: true, value: expect.stringContaining("emergency passthrough") });
    const status = await r.health();
    expect(status).toMatchObject({ ok: true, mode: "emergency" });
    await expectClaudeBoth(r.port);
    const refused = await send(r.port, "chaos-small");
    expect(refused.status).toBe(503);
    expect(refused.body).toContain("Run /chaos:setup.");
    expect((await send(r.port, "odd-model-7")).status).toBe(503);
    expect(await send(r.port, "other-vendor-1")).toEqual({ status: 200, body: JSON_ANSWER });

    // Repaired: the next start hands the port from the emergency passthrough back to the main router. The gap is
    // counted in refused connects by a client that tries every 5 ms, not in wall-clock time, so a loaded machine that
    // slows the router slows the prober with it.
    r.writeRouter();
    let refusedRun = 0;
    let longestRefusedRun = 0;
    let probing = true;
    const prober = (async () => {
      while (probing) {
        const ok = await new Promise<boolean>((resolve) => {
          const socket = net.connect({ port: r.port, host: "127.0.0.1" });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        });
        refusedRun = ok ? 0 : refusedRun + 1;
        longestRefusedRun = Math.max(longestRefusedRun, refusedRun);
        await sleep(5);
      }
    })();
    const back = await r.start();
    probing = false;
    await prober;
    expect(back).toMatchObject({
      ok: true,
      value: expect.stringContaining("replaced the emergency passthrough"),
    });
    expect(longestRefusedRun).toBeLessThanOrEqual(20);
    const main = await r.workerUp();
    expect(main.mode).toBe("router");
    await expectClaudeBoth(r.port);
    expect((await send(r.port, "chaos-small")).status).toBe(200);
    expect(await send(r.port, "odd-model-7")).toEqual({ status: 200, body: '{"provider":true}' });
  });

  it("g) a hot update to a new worker script under load fails zero requests and never closes the port", async () => {
    const r = await upRig();
    const before = await r.health();
    const traffic = load(r.port, 20);
    await sleep(300);
    r.writeRouter("// a new version\n");
    const updated = await r.start();
    expect(updated).toMatchObject({ ok: true, value: expect.stringContaining("without closing the port") });
    const after = await r.workerUp(before.workerPid);
    await sleep(500);
    const stats = await traffic.stop();
    expect(stats.errors).toEqual([]);
    expect(stats.ok).toBeGreaterThan(20);
    expect(after.pid).toBe(before.pid);
    expect(after.version).not.toBe(before.version);
    await expectClaudeBoth(r.port);
  });

  it("g') a front with another protocol is replaced by a handover no retrying client notices", async () => {
    const r = await rig({ tuning: { frontVersion: 0 } });
    expect(await r.start()).toMatchObject({ ok: true });
    const old = await r.workerUp();
    // Clients retry a refused connection up to 30 times, 10 ms apart: the handover's gap must fit in that.
    const traffic = load(r.port, 4, 30);
    // The next start speaks the current protocol: the running front must hand over.
    r.env.CHAOS_ROUTER_TUNING = JSON.stringify({ heartbeatMs: 250, hangMs: 4000, startWaitMs: 20_000 });
    const handed = await r.start();
    expect(handed).toMatchObject({ ok: true, value: expect.stringContaining("replaced an older front") });
    // The old front still finishes its open connections, so wait for the new one to answer.
    const fresh = await until(async () => {
      const value = await r.workerUp();
      if (value.pid === old.pid) throw new Error("still the old front");
      return value;
    });
    expect(fresh.pid).not.toBe(old.pid);
    await sleep(300);
    const stats = await traffic.stop();
    expect(stats.errors).toEqual([]);
    expect(stats.ok).toBeGreaterThan(4);
    await expectClaudeBoth(r.port);
  });

  it("h) a port squatted by a foreign server: nothing is killed and the base URL is unpointed", async () => {
    const r = await rig();
    const squatter = http.createServer((_req, res) => res.end("I am somebody else"));
    await listen(squatter, r.port);
    const settings = claudeSettingsPath(r.env);
    mkdirSync(join(r.dir, "home", ".claude"), { recursive: true });
    writeFileSync(
      settings,
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${r.port}`, KEEP: "1" } }, null, 2)}\n`,
    );

    const started = await r.start();

    expect(started).toMatchObject({ ok: false, error: expect.stringContaining("held by another program") });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ env: { KEEP: "1" } });
    const still = await fetch(`http://127.0.0.1:${r.port}/anything`);
    expect(await still.text()).toBe("I am somebody else");
  });

  it("i) a missing key or a hung key lookup never touches claude-*; the provider answers 400 or 503", async () => {
    const missing = await upRig({ env: { CHAOS_API_KEY: undefined } });
    const noKey = await send(missing.port, "chaos-big");
    expect(noKey.status).toBe(400);
    expect(noKey.body).toContain("Chaos Models key refused or missing: run /chaos:setup");
    await expectClaudeBoth(missing.port);

    const hung = await rig({ env: { CHAOS_API_KEY: undefined } });
    mkdirSync(join(hung.dir, "home", ".config", "chaos"), { recursive: true });
    execFileSync("mkfifo", [join(hung.dir, "home", ".config", "chaos", "env")]);
    expect(await hung.start()).toMatchObject({ ok: true });
    await hung.workerUp();
    let settled = false;
    const pending = send(hung.port, "chaos-big").finally(() => {
      settled = true;
    });
    // Claude traffic is served while the provider request still waits on its key.
    await expectClaudeBoth(hung.port);
    expect(settled).toBe(false);
    const timedOut = await pending;
    expect(timedOut.status).toBe(503);
    expect(timedOut.body).toContain("key timed out");
  });

  it("j) a provider upstream that is down or hangs never touches claude-*", async () => {
    const hanging = await fakeProvider({ hang: true });
    const r = await upRig({ provider: hanging, tuning: { idleMs: 2000 } });
    const pending = send(r.port, "chaos-big");
    await expectClaudeBoth(r.port);
    const timedOut = await pending;
    expect(timedOut.status).toBe(504);

    const gone = await freePort();
    const down = await upRig({ env: { CHAOS_ROUTER_URL: `http://127.0.0.1:${gone}/anthropic` } });
    expect((await send(down.port, "chaos-big")).status).toBe(502);
    await expectClaudeBoth(down.port);
  });

  it("k) a dead peer router fails only that peer's models", async () => {
    const r = await upRig();
    await saveRegistryEntry(r.env, {
      name: "deadpeer",
      port: await freePort(),
      modelPrefixes: ["peer-"],
      catalogIds: [],
      updatedAt: new Date().toISOString(),
    });
    // The peer lookup re-reads the registry at most every 5 s.
    const peer = await until(async () => {
      const answer = await send(r.port, "peer-model");
      if (answer.status !== 502) throw new Error(`status ${answer.status}`);
      return answer;
    }, 10_000);
    expect(peer.body).toContain("/deadpeer:setup");
    await expectClaudeBoth(r.port);
    expect((await send(r.port, "chaos-big")).status).toBe(200);
  });

  it("l) keep-alive reuse across the upstream's keepAliveTimeout never reaches the client as ECONNRESET", async () => {
    const edgy = await fakeAnthropic({ keepAliveMs: 300 });
    const r = await upRig({ env: { CHAOS_ROUTER_ANTHROPIC_URL: edgy.url } });
    const agent = new http.Agent({ keepAlive: true });
    closers.push(() => agent.destroy());
    for (let i = 0; i < 25; i++) {
      await expectClaude(r.port, i % 2 === 0, agent);
      // Land each reuse right around the upstream closing its idle socket.
      await sleep(280 + (i % 5) * 10);
    }
  });

  it("m) a 30 MiB request body goes through byte for byte", async () => {
    const r = await upRig();
    const big = JSON.stringify({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "x".repeat(30 * 1024 * 1024) }],
    });
    const answer = await send(r.port, "claude-sonnet-5-5", { body: big });
    expect(answer).toEqual({ status: 200, body: expectedFor(big) });
    await expectClaudeBoth(r.port);
  });

  it("n) a long stream is never cut: 12 s of events, six times the idle timeout", async () => {
    // Only silence ends a request (here 2 s, in production 10 min); a stream that keeps talking runs as long as it
    // needs, however many idle windows it spans.
    const r = await upRig({ tuning: { idleMs: 2000 } });
    const started = Date.now();
    const answer = await send(r.port, "claude-sonnet-5-5", { body: slowStream(24, 500) });
    expect(answer.status).toBe(200);
    expect(answer.body.split("\n\n").filter(Boolean)).toHaveLength(24);
    expect(Date.now() - started).toBeGreaterThanOrEqual(11_500);
  }, 120_000);

  it("o) upstream requests go through the caller's proxy (CONNECT, or forwarding on Bun 1.3); loopback never does", async () => {
    // A proxy that tunnels CONNECT and forwards absolute-form requests, the two ways clients use one, to 127.0.0.1
    // whatever host it is asked for. The fake Anthropic is named 127.0.0.2: still loopback for the https rule, but not
    // the router's own 127.0.0.1, which is exempt from every proxy (and nothing listens on .2, so only the proxy works).
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => {
      const target = new URL(req.url ?? "");
      seen.push(target.host);
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: target.port,
          path: target.pathname,
          method: req.method,
          headers: req.headers,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    proxy.on("connect", (req, client, head) => {
      seen.push(req.url ?? "");
      const port = Number((req.url ?? "").split(":").pop());
      const upstream = net.connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    const anthropic = await fakeAnthropic();
    const r = await upRig({
      env: {
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        CHAOS_ROUTER_ANTHROPIC_URL: `http://127.0.0.2:${anthropic.port}`,
      },
    });
    await expectClaudeBoth(r.port);
    expect(seen).toContain(`127.0.0.2:${anthropic.port}`);
    // Front to worker is loopback: nothing of it reached the proxy.
    expect(seen.every((authority) => authority === `127.0.0.2:${anthropic.port}`)).toBe(true);
  });

  it("p) a full disk for the crash log, the router log and the spool: requests are still served", async () => {
    const r = await rig();
    // Every log path is a directory or sits under a file: each write fails like ENOSPC would.
    mkdirSync(join(r.state, "router-crash.log"), { recursive: true });
    mkdirSync(join(r.state, "router", "router.log"), { recursive: true });
    mkdirSync(join(r.dir, "observatory"), { recursive: true });
    writeFileSync(join(r.dir, "observatory", "spool"), "not a directory");
    expect(await r.start()).toMatchObject({ ok: true });
    const before = await r.workerUp();
    await expectClaudeBoth(r.port);
    process.kill(before.workerPid as number, "SIGKILL");
    await r.workerUp(before.workerPid);
    await expectClaudeBoth(r.port);
  });

  it("q) two hooks starting the router at once start exactly one", async () => {
    const r = await rig();
    const [first, second] = await Promise.all([r.start(), r.start()]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const up = await r.workerUp();
    await sleep(500);
    expect(processesRunning(`${join(r.state, "router", "chaos-router.js")} run`)).toBe(1);
    expect(readPidFile(r.state)?.pid).toBe(up.pid);
    await expectClaudeBoth(r.port);
  });

  it("r) budget-status.json churning, a FIFO, garbage or stale: a stop refuses only the provider, nothing else ever breaks", async () => {
    const r = await upRig();
    const status = join(r.dir, "observatory", "budget-status.json");
    const stopped = (stopped: readonly string[], updatedAt = Date.now()) =>
      JSON.stringify({ version: 1, updatedAt, stopped, spend: [] });
    mkdirSync(join(r.dir, "observatory"), { recursive: true });
    writeFileSync(
      join(r.dir, "observatory", "budgets.json"),
      JSON.stringify({
        version: 1,
        budgets: [{ id: "b", scope: "provider:chaos", period: "month", limitUsd: 1, action: "stop" }],
      }),
    );
    // The worker has read no status yet, so this one counts at once.
    writeFileSync(status, stopped(["provider:chaos"]));
    const refused = await send(r.port, "chaos-big");
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body).error.message).toBe(
      "Chaos Models budget reached for this month: raise or lift it in the Observatory dashboard (/observatory:open)",
    );
    await expectClaudeBoth(r.port);
    const before = await r.health();

    // Chaos: the file rewritten (half-written, a FIFO, garbage, a directory, stale) under 20 claude clients. They are
    // paced: over this test's ~9 s, unpaced clients use up macOS's local ports (EADDRNOTAVAIL) before the router is tested.
    const clients = load(r.port, 20, 0, 50);
    const breakers = [
      () => writeFileSync(status, stopped(["total"]).slice(0, 20)),
      () => writeFileSync(status, "\u0000garbage"),
      () => {
        rmSync(status, { recursive: true, force: true });
        execFileSync("mkfifo", [status]);
      },
      () => {
        rmSync(status, { recursive: true, force: true });
        mkdirSync(status);
      },
      () => {
        rmSync(status, { recursive: true, force: true });
        writeFileSync(status, stopped(["total"]));
      },
    ];
    const churnUntil = Date.now() + 3000;
    for (let i = 0; Date.now() < churnUntil; i++) {
      breakers[i % breakers.length]?.();
      await sleep(25);
    }
    rmSync(status, { recursive: true, force: true });
    execFileSync("mkfifo", [status]);
    // The cached reading expires; the FIFO left there must not block the worker's next read.
    await sleep(5500);
    expect((await send(r.port, "chaos-big")).status).toBe(200);
    const stats = await clients.stop();
    expect(stats.failed).toBe(0);
    expect(stats.ok).toBeGreaterThan(20);
    // The same worker served it all: no read ever hung its event loop.
    expect((await r.health()).workerPid).toBe(before.workerPid);

    // A stale stop stops nothing; a fresh one does again.
    rmSync(status, { force: true });
    writeFileSync(status, stopped(["provider:chaos"], Date.now() - 11 * 60_000));
    await sleep(5500);
    expect((await send(r.port, "chaos-big")).status).toBe(200);
    writeFileSync(status, stopped(["total"]));
    await sleep(5500);
    expect((await send(r.port, "chaos-small")).status).toBe(400);
    await expectClaudeBoth(r.port);

    // The observatory heard about both stops, each once, and every refusal.
    const health = filesUnder(join(r.dir, "observatory", "spool"))
      .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.kind === "router.event")
      .map(({ event, reason, model }) => `${event} ${reason} ${model}`);
    expect(health).toEqual([
      "budget_stop provider:chaos budget reached for this month chaos-big",
      "refusal budget: provider:chaos chaos-big",
      "budget_stop total budget reached for this period chaos-small",
      "refusal budget: total chaos-small",
    ]);
  });

  it("the provider key never leaks: no log, crash log, spool, ledger, health, control answer or error body holds it", async () => {
    const r = await upRig({ provider: await trickyProvider(), tuning: { idleMs: 1500 } });
    const answers: string[] = [];
    const provider = (mode: string) =>
      send(r.port, "chaos-big", { body: JSON.stringify({ model: "chaos-big", mode, messages: [] }) }).then(
        (answer) => {
          answers.push(answer.body);
          return answer;
        },
      );
    // The key is a sentinel the provider fake quotes back in every failure it can produce.
    expect((await provider("echo401")).status).toBe(400);
    expect((await provider("echo429")).status).toBe(429);
    expect((await provider("echo500")).status).toBe(500);
    expect((await provider("badjson")).status).toBe(200);
    expect((await provider("reset")).status).toBe(502);
    expect((await provider("hang")).status).toBe(504);
    // A worker killed while a provider request is in flight, and the request it cut.
    const before = await r.health();
    const sent = r.provider.requests;
    const cut = provider("hang").catch((error: Error) => error.message);
    await until(async () => {
      if (r.provider.requests === sent) throw new Error("not sent yet");
    });
    process.kill(before.workerPid as number, "SIGKILL");
    await cut;
    const after = await r.workerUp(before.workerPid);
    await expectClaudeBoth(r.port);
    // Health, the key check (it names the key's source, never the key) and the processes' command lines.
    answers.push(JSON.stringify(after));
    const token = readPidFile(r.state)?.token ?? "";
    const keyCheck = await fetch(`http://127.0.0.1:${r.port}${HEALTH}/key`, {
      headers: { "x-provider-router-token": token },
    });
    const keyAnswer = await keyCheck.text();
    expect(keyAnswer).toContain('"ok":true');
    answers.push(keyAnswer);
    for (const pid of [after.pid, after.workerPid as number]) answers.push(commandLineOf(pid) ?? "");

    for (const answer of answers) expect(answer).not.toContain(SENTINEL);
    // Every file the router wrote: its log, crash log, pid file, ledger, registry entry and the observatory spool.
    const written = filesUnder(r.dir).filter((path) => !path.startsWith(r.dist));
    expect(written).toContainEqual(join(r.state, "router", "router.log"));
    expect(written).toContainEqual(expect.stringContaining(join(r.dir, "observatory", "spool")));
    expect(written).toContainEqual(join(r.state, "router.pid"));
    expect(written).toContainEqual(join(r.state, "router-crash.log"));
    for (const path of written)
      expect({ path, holdsKey: readFileSync(path).includes(SENTINEL) }).toEqual({ path, holdsKey: false });
    // The health events the faults produced are in the spool, metadata only.
    const health = written
      .filter((path) => path.includes(join(r.dir, "observatory", "spool")))
      .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.kind === "router.event");
    expect(health.map((line) => line.event)).toEqual(
      expect.arrayContaining(["refusal", "rate_limited", "restart"]),
    );
    for (const line of health)
      expect(Object.keys(line).sort()).toEqual(["event", "kind", "model", "plugin", "reason", "ts"]);
  });

  it("uninstall: the router undoes its settings, keeps serving until idle, then removes itself and exits", async () => {
    const r = await rig({ tuning: { watchEveryMs: 200, uninstallIdleMs: 1500 } });
    const configDir = join(r.dir, "home", ".claude");
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    const installed = join(configDir, "plugins", "installed_plugins.json");
    writeFileSync(
      installed,
      JSON.stringify({ version: 2, plugins: { "chaos-plugin-cc@test": [{ scope: "user" }] } }),
    );
    const settings = claudeSettingsPath(r.env);
    const original = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
    writeFileSync(settings, original);
    expect(await r.start()).toMatchObject({ ok: true });
    const up = await r.workerUp();
    // What setup would have recorded: the base URL it pointed at the router.
    writeFileSync(
      settings,
      `${JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${r.port}` } }, null, 2)}\n`,
    );
    writeFileSync(
      join(r.state, "ledger.json"),
      JSON.stringify({
        version: 1,
        plugin: "chaos",
        routerUrl: `http://127.0.0.1:${r.port}`,
        settingsPath: settings,
        settings: {
          baseUrlBefore: null,
          optionsAdded: [],
          availableAppended: [],
          createdModelPicker: false,
          createdOptions: false,
          createdEnv: true,
        },
        keystore: { created: false },
        routerFiles: [join(r.state, "router")],
        stateRoot: r.state,
      }),
    );
    writeFileSync(installed, JSON.stringify({ version: 2, plugins: {} }));
    await until(async () => {
      if (readFileSync(settings, "utf8") !== original) throw new Error("settings not restored yet");
    });
    // Sessions that still hold the URL are served until the router has been idle for the window.
    await expectClaudeBoth(r.port);
    await until(async () => {
      if (existsSync(join(r.state, "router")))
        throw new Error(
          `router files still there: ${readFileSync(join(r.state, "router", "router.log"), "utf8")}`,
        );
    }, 15_000);
    await until(async () => {
      if (
        await fetch(`http://127.0.0.1:${r.port}${HEALTH}`).then(
          () => true,
          () => false,
        )
      )
        throw new Error("still up");
    }, 15_000);
    // The front exits once it has removed its files: the pid goes away.
    await until(async () => {
      try {
        process.kill(up.pid, 0);
      } catch {
        return;
      }
      throw new Error("still running");
    });
  });
});
