// The emergency passthrough: what `start` runs on the router port when the main router cannot start at all (a bundle
// broken by an update, a syntax error, a missing module). It is a pure Anthropic pipe with nothing to break: built as
// its own bundle from Node built-ins only, it sends every request that is not for this provider's models to Anthropic
// untouched and answers the provider's models 503 with what to run. Its health answers `"mode":"emergency"`; the next
// hook retries the main router and takes the port over through `/handover`, exactly as a front restart does.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { ModelClaim } from "../domain/provider.ts";
import { healthEvent, type SpoolEvent } from "../domain/route-events.ts";
import { stateLayout } from "../domain/state-layout.ts";
import { installCrashHandlers, rotatingLog } from "./crashlog.ts";
import { passThrough } from "./passthrough.ts";
import { createSpoolWriter } from "./spool-write.ts";
import {
  anthropicError,
  BODY_LIMIT_BYTES,
  harden,
  type ProxyEnv,
  receive,
  refuseHost,
  requestModel,
  TOKEN_HEADER,
  trackConnections,
} from "./upstream.ts";

interface EmergencyOptions {
  readonly name: string;
  readonly display: string;
  readonly healthPath: string;
  /** The resolved provider's model claim: these requests are answered 503. */
  readonly claim: ModelClaim;
  readonly port: number;
  readonly anthropic: URL;
  readonly env: ProxyEnv;
  /** The pid file's token, for `/handover`. */
  readonly token: string;
  readonly log?: (line: string) => void;
  /** Radar spool: one `fallback` health event per request served here. */
  readonly events?: (event: SpoolEvent) => void;
  /** Called once a handover has drained the last connection. */
  readonly done?: () => void;
}

/** The emergency server on its port; resolves once it listens. */
export async function startEmergency(options: EmergencyOptions): Promise<http.Server> {
  let accepting = true;
  const connections = trackConnections((open) => {
    if (!accepting && open === 0) options.done?.();
  });
  const passthrough = {
    name: options.name,
    display: options.display,
    claim: options.claim,
    anthropic: options.anthropic,
    env: options.env,
    state: "in emergency passthrough (the main router could not start)",
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  const handover = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers[TOKEN_HEADER] !== options.token) {
      anthropicError(res, 403, "permission_error", `${options.name} router: control refused`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end('{"ok":true}');
    accepting = false;
    server.close();
    connections.drain();
    if (connections.size === 0) options.done?.();
  };
  const server = harden(
    http.createServer((req, res) => {
      if (refuseHost(req, res, options.name, [options.port])) return;
      if (!accepting) res.setHeader("connection", "close");
      if (req.method === "GET" && req.url === options.healthPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, mode: "emergency", name: options.name, provider: options.display }),
        );
      } else if (req.method === "POST" && req.url === `${options.healthPath}/handover`) handover(req, res);
      else
        receive(req, res, options.name, BODY_LIMIT_BYTES, (body) => {
          options.events?.(
            healthEvent(options.name, "fallback", "emergency passthrough", requestModel(body), Date.now()),
          );
          passThrough(passthrough, req, res, body);
        });
    }),
  );
  connections.watch(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

/** The emergency bundle's entry: everything from the environment the starter set, then serve until handed over. */
export async function runEmergency(
  provider: {
    readonly name: string;
    readonly display: string;
    readonly envPrefix: string;
    readonly healthPath: string;
    readonly port: number;
    readonly claim: ModelClaim;
  },
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const prefix = provider.envPrefix;
  const stateRoot = env[`${prefix}_STATE_DIR`] ?? ".";
  installCrashHandlers("emergency", stateRoot, "emergency");
  const log = rotatingLog(stateLayout(stateRoot).routerLog);
  await startEmergency({
    name: provider.name,
    display: provider.display,
    healthPath: provider.healthPath,
    claim: provider.claim,
    port: Number(env[`${prefix}_ROUTER_PORT`]) || provider.port,
    anthropic: new URL(env[`${prefix}_ROUTER_ANTHROPIC_URL`] ?? "https://api.anthropic.com"),
    env,
    token: env[`${prefix}_ROUTER_TOKEN`] ?? "",
    log,
    events: createSpoolWriter(env, log),
    done: () => process.exit(0),
  });
  log(`${provider.name}-router emergency passthrough listening on 127.0.0.1`);
  process.on("SIGTERM", () => process.exit(0));
}
