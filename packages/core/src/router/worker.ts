// The router's worker: today's router (router.ts) on an internal loopback port, forked and supervised by the front.
// Over IPC it reports its port once it listens, a heartbeat with its resident size every second from its own event
// loop (a blocked loop stops the heartbeat and the front kills it), and an ack just before each request goes
// upstream, so the front knows which requests a crash cut and which it can retry. It drains on command: stop
// accepting, finish the streams in flight (at most the front's drain window), exit. The provider key is read only for
// a provider request, behind router.ts's 2 s budget.
import { loadKey } from "../adapters/key.ts";
import { type EnvLookup, type Provider, resolveProvider, routerEnvName } from "../domain/provider.ts";
import { createBudgetGate } from "./budget.ts";
import { installCrashHandlers, type LogFs, rotatingLog } from "./crashlog.ts";
import { createPeerLookup } from "./registry.ts";
import { createRouter, REQUEST_ID } from "./router.ts";
import { createSpoolWriter } from "./spool.ts";
import { trackConnections } from "./upstream.ts";

interface WorkerOptions {
  readonly provider: Provider;
  readonly env: EnvLookup;
  readonly stateRoot: string;
  readonly version: string;
  /** The router log file. */
  readonly logFile: string;
  readonly heartbeatMs?: number;
  readonly idleMs?: number;
  readonly logFs?: LogFs;
}

function send(message: unknown): void {
  try {
    process.send?.(message);
  } catch {
    // The front is gone; the disconnect handler ends this worker.
  }
}

/** The provider key the way setup reads it, as a source name for the key check (never the key). */
async function keySource(provider: Provider, env: EnvLookup): Promise<Record<string, unknown>> {
  const key = await loadKey(provider, env);
  return key.ok ? { ok: true, source: key.value.source } : { ok: false, error: key.error.kind };
}

/** Runs the worker until it drains or its front goes away. */
export function runWorker(options: WorkerOptions): void {
  const { env } = options;
  // Resolved once: the model ids this worker claims and the endpoint both follow the env overrides.
  const provider = resolveProvider(options.provider, env);
  installCrashHandlers("worker", options.stateRoot, options.version);
  const log = rotatingLog(options.logFile, options.logFs);
  const server = createRouter({
    provider,
    port: 0,
    anthropic: new URL(env[routerEnvName(provider, "ANTHROPIC_URL")] ?? "https://api.anthropic.com"),
    // The router follows the same endpoint overrides as the jobs: `${envPrefix}_BASE_URL` and `_REGION`, plus
    // `${envPrefix}_ROUTER_URL` for the router alone.
    providerUrl: new URL(env[routerEnvName(provider, "URL")] ?? provider.baseUrl.intl),
    key: async () => {
      const key = await loadKey(provider, env);
      return key.ok ? key.value.value : undefined;
    },
    log,
    peers: createPeerLookup(env, provider.name),
    events: createSpoolWriter(env, log),
    budget: createBudgetGate(provider.name, env),
    env,
    onUpstream: (req) => {
      const id = req.headers[REQUEST_ID];
      if (typeof id === "string") send({ t: "ack", id });
    },
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  const connections = trackConnections();
  connections.watch(server);
  server.on("error", (error: Error) => {
    log(`worker: ${error.message}`);
    process.exit(1);
  });
  // `exclusive`: the worker binds its own internal port instead of sharing one through the cluster primary.
  server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
    const address = server.address();
    send({ t: "listening", port: typeof address === "object" && address !== null ? address.port : 0 });
  });
  const heartbeat = setInterval(
    () => send({ t: "hb", rss: process.memoryUsage.rss() / (1024 * 1024) }),
    options.heartbeatMs ?? 1000,
  );
  let draining = false;
  const drain = (ms: number): void => {
    if (draining) return;
    draining = true;
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
    connections.drain();
    setTimeout(() => process.exit(0), ms).unref();
  };
  process.on("message", (raw: unknown) => {
    const message = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (message.t === "drain") drain(typeof message.ms === "number" ? message.ms : 600_000);
    else if (message.t === "key" && typeof message.id === "string") {
      const id = message.id;
      void keySource(provider, env).then(
        (answer) => send({ t: "key", id, ...answer }),
        () => send({ t: "key", id, ok: false, error: "the key lookup failed" }),
      );
    }
  });
  process.on("SIGTERM", () => drain(10_000));
  process.on("SIGINT", () => drain(10_000));
  // The front is gone (killed): nobody routes to this worker any more.
  process.on("disconnect", () => process.exit(0));
}
