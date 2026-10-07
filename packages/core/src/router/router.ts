import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { type BudgetStop, budgetMessage } from "../domain/budget.ts";
import { isLoopback } from "../domain/plugin-routers.ts";
import { claims, type ModelClaim, modelClaim, type Provider } from "../domain/provider.ts";
import {
  healthEvent,
  type RouteEvent,
  type RouterHealth,
  type RouteUsage,
  type SpoolEvent,
} from "../domain/route-events.ts";
import { budgetAnswer, mayRefuse, refusalAnswer, refusalOf } from "./refusal.ts";
import type { PeerTarget } from "./registry.ts";
import {
  anthropicError,
  BODY_LIMIT_BYTES,
  forwardHeaders,
  harden,
  type ProxyEnv,
  type Replacement,
  receive,
  refuseHost,
  responseHeaders,
  sendUpstream,
  upstreamUrl,
} from "./upstream.ts";

interface RouterOptions {
  /** Whose router this is, as resolved for this process (`resolveProvider`: env model overrides applied): the model ids
   *  it claims, the fields it strips, its health path and every line it prints. */
  readonly provider: Provider;
  readonly port: number;
  /** Where every request for a model this provider does not serve goes, unchanged (https://api.anthropic.com). */
  readonly anthropic: URL;
  /** The provider's Anthropic-compatible endpoint. */
  readonly providerUrl: URL;
  /** The provider's key, read only when one of its models is requested (never on the `claude-*` path); undefined
   *  when there is none. Never logged. */
  readonly key: () => Promise<string | undefined>;
  /** One line per request: method, path, model, route, status. Never headers or bodies. */
  readonly log: (line: string) => void;
  /** Which other plugin's router serves a model this one does not; set by the service, absent in tests. */
  readonly peers?: (model: string) => PeerTarget | undefined;
  /** One spool event per forwarded request and per start/stop, and the health events (refusals, rate limits, a
   *  budget stop), when the observatory's spool is reachable. */
  readonly events?: (event: SpoolEvent) => void;
  /** The observatory budget stop in force for this provider's models, if any (cached by the caller); absent: none. */
  readonly budget?: () => BudgetStop | undefined;
  /** The proxy environment upstream requests honour (HTTPS_PROXY, NO_PROXY, …); none when absent. */
  readonly env?: ProxyEnv;
  /** Called just before a request goes upstream, so the front knows the upstream may have seen it. */
  readonly onUpstream?: (req: IncomingMessage) => void;
  /** How long a key lookup may take before a provider request is answered 503 (default 2 s). */
  readonly keyTimeoutMs?: number;
  /** Upstream silence that ends a request (default 10 min; never a total timeout). */
  readonly idleMs?: number;
  /** The body limit (default 64 MiB). */
  readonly bodyLimit?: number;
}

/** The hop header a router stamps on a request it forwards to a peer, so no request is ever forwarded twice. */
export const PEER_HOP = "x-provider-router-hop";

/** The header the front stamps on a request it hands its worker, echoed back over IPC once it goes upstream. */
export const REQUEST_ID = "x-provider-router-request";

/** The key lookup's budget: a keychain prompt or a hung store answers the provider request 503, never hangs it. */
const KEY_TIMEOUT_MS = 2000;

/** The parsed JSON body, or undefined when it is not JSON. */
function parseBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The `model` field of a parsed body, or "". */
function modelIn(json: unknown): string {
  const model: unknown =
    typeof json === "object" && json !== null ? (json as Record<string, unknown>).model : "";
  return typeof model === "string" ? model : "";
}

/** The request fields a provider rejects, removed wherever they appear (top level, content blocks, metadata). Returns
 *  the original bytes when the body is not JSON or nothing was stripped. */
export function stripRejected(body: Buffer, fields: readonly string[]): Buffer {
  return stripParsed(body, parseBody(body), fields);
}

/** stripRejected on a body already parsed once. */
function stripParsed(body: Buffer, json: unknown, fields: readonly string[]): Buffer {
  if (fields.length === 0 || json === undefined) return body;
  return stripFrom(json, new Set(fields)) ? Buffer.from(JSON.stringify(json), "utf8") : body;
}

/** Removes the fields in place; true when at least one was present anywhere. */
function stripFrom(value: unknown, rejected: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => stripFrom(item, rejected));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  let stripped = false;
  for (const key of Object.keys(record)) {
    if (rejected.has(key)) {
      delete record[key];
      stripped = true;
    } else if (stripFrom(record[key], rejected)) stripped = true;
  }
  return stripped;
}

/** The client's headers for the upstream. A provider-bound request swaps the caller's Anthropic credentials for the
 *  provider's key, so they never reach the provider; every other route keeps them untouched. */
export function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  target: URL,
  length: number,
  key?: string,
): Record<string, string | string[]> {
  const out = forwardHeaders(incoming, target, length);
  delete out[REQUEST_ID];
  delete out[PEER_HOP];
  if (key !== undefined) {
    delete out["x-api-key"];
    out.authorization = `Bearer ${key}`;
  }
  return out;
}

function forwardable(route: string, url: URL): string | undefined {
  if (url.protocol === "https:" || isLoopback(url.hostname)) return undefined;
  return `${route} upstream must be https unless it is loopback (${url.host})`;
}

/** Routes Claude Code's API requests by model: the provider's own ids to it with its key, another plugin's ids to
 *  that plugin's router unchanged, and everything else — every `claude-*` request — to Anthropic as is. Only this
 *  machine may use it: the server listens on 127.0.0.1 and refuses any other Host (DNS rebinding). */
export function createRouter(opts: RouterOptions): http.Server {
  const { provider } = opts;
  const claim = modelClaim(provider);
  const budget = budgetWatch(opts);
  return harden(
    http.createServer((req, res) => {
      // Port 0 (tests, and the worker behind its front) takes any Host: only the front faces Claude Code.
      if (opts.port !== 0 && refuseHost(req, res, provider.name, [opts.port])) return;
      if (req.method === "GET" && req.url === provider.router.healthPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: provider.name, provider: provider.display }));
        return;
      }
      receive(req, res, provider.name, opts.bodyLimit ?? BODY_LIMIT_BYTES, (body) => {
        void forward(opts, claim, budget, req, res, body);
      });
    }),
  );
}

/** Where a request for this model goes: "provider", "anthropic", or "peer:<name>". */
function routeOf(
  claim: ModelClaim,
  model: string,
  peers: ((model: string) => PeerTarget | undefined) | undefined,
): { readonly route: string; readonly peer?: PeerTarget } {
  if (claims(claim, model)) return { route: "provider" };
  const peer = model === "" ? undefined : peers?.(model);
  return peer === undefined ? { route: "anthropic" } : { route: `peer:${peer.name}`, peer };
}

type EventNote = (status: number, route: string, upstream: string, usage?: RouteUsage) => void;

/** Appends one health event for this router's plugin, when anyone listens. Never the key, a header or a body. */
function health(opts: RouterOptions, event: RouterHealth, reason: string, model: string): void {
  opts.events?.(healthEvent(opts.provider.name, event, reason, model, Date.now()));
}

/** The budget stop in force, with one `budget_stop` event each time a scope newly turns this router's models off. */
function budgetWatch(opts: RouterOptions): (model: string) => BudgetStop | undefined {
  let stopped: string | undefined;
  return (model) => {
    const stop = opts.budget?.();
    if (stop !== undefined && stop.scope !== stopped)
      health(opts, "budget_stop", `${stop.scope} budget reached for this ${stop.period ?? "period"}`, model);
    stopped = stop?.scope;
    return stop;
  };
}

/** A request header as a non-empty string, else undefined. */
function textHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The route event for one request, emitted when it completes; undefined when nobody listens. */
function eventNote(
  opts: RouterOptions,
  req: IncomingMessage,
  model: string,
  startedAt: number,
): EventNote | undefined {
  const { events, provider } = opts;
  if (events === undefined) return undefined;
  // The three ids Claude Code stamps its requests with; no other header value is ever recorded.
  const sessionId = textHeader(req, "x-claude-code-session-id");
  const agentId = textHeader(req, "x-claude-code-agent-id");
  const parentAgentId = textHeader(req, "x-claude-code-parent-agent-id");
  return (status, route, upstream, usage) => {
    const event: RouteEvent = {
      ts: new Date().toISOString(),
      event: "route",
      plugin: provider.name,
      model,
      upstream,
      route,
      status,
      latency_ms: Date.now() - startedAt,
      ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      ...(parentAgentId === undefined ? {} : { parent_agent_id: parentAgentId }),
    };
    events(event);
  };
}

/** Parses an answer's usage out of the stream as it passes through, without buffering or delaying it: a JSON body
 *  carries it at the top level, an SSE stream in message_start and the final message_delta. */
export function usageTracker(contentType: string | undefined): {
  push(chunk: Buffer): void;
  usage(): RouteUsage | undefined;
} {
  if (contentType?.includes("text/event-stream") === true) return sseUsage();
  if (contentType?.includes("application/json") === true) return jsonUsage();
  return { push: () => undefined, usage: () => undefined };
}

function jsonUsage(): { push(chunk: Buffer): void; usage(): RouteUsage | undefined } {
  const chunks: Buffer[] = [];
  let parsed: RouteUsage | undefined;
  let done = false;
  return {
    push: (chunk) => chunks.push(chunk),
    usage: () => {
      if (!done) {
        done = true;
        parsed = topLevelUsage(chunks);
      }
      return parsed;
    },
  };
}

/** The `usage` at the top level of the collected JSON body, when it parses and carries one. */
function topLevelUsage(chunks: readonly Buffer[]): RouteUsage | undefined {
  try {
    return nestedUsage(JSON.parse(Buffer.concat([...chunks]).toString("utf8")));
  } catch {
    return undefined;
  }
}

function sseUsage(): { push(chunk: Buffer): void; usage(): RouteUsage | undefined } {
  let rest = "";
  let usage: Record<string, unknown> | undefined;
  const take = (line: string): void => {
    const event = sseEvent(line);
    if (event === undefined) return;
    const found =
      event.type === "message_start"
        ? nestedUsage(event.message)
        : event.type === "message_delta"
          ? nestedUsage(event)
          : undefined;
    if (found !== undefined) usage = { ...usage, ...found };
  };
  return {
    push: (chunk) => {
      rest += chunk.toString("utf8");
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) take(line);
    },
    usage: () => (usage === undefined || Object.keys(usage).length === 0 ? undefined : usage),
  };
}

/** The `data:` line's event object — an SSE event only when it parses to one. */
function sseEvent(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("data:")) return undefined;
  try {
    const event: unknown = JSON.parse(line.slice(5).trim());
    return typeof event === "object" && event !== null ? (event as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function nestedUsage(value: unknown): RouteUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = (value as Record<string, unknown>).usage;
  return typeof usage === "object" && usage !== null ? (usage as RouteUsage) : undefined;
}

/** The provider's key within the budget: the key, "none" when there is none, "timeout" when the lookup hung. */
async function keyWithin(opts: RouterOptions): Promise<string | "none" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.keyTimeoutMs ?? KEY_TIMEOUT_MS);
  });
  try {
    const key = await Promise.race([opts.key().catch(() => undefined), timeout]);
    return key ?? "none";
  } finally {
    clearTimeout(timer);
  }
}

async function forward(
  opts: RouterOptions,
  claim: ModelClaim,
  budget: (model: string) => BudgetStop | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  original: Buffer,
): Promise<void> {
  const { provider } = opts;
  const json = parseBody(original);
  const model = modelIn(json);
  const note = eventNote(opts, req, model, Date.now());
  const { route, peer } = routeOf(claim, model, opts.peers);
  // A request another plugin's router forwarded here is served when it is this provider's model; anything else would
  // be a second hop (a loop, or two routers disagreeing about who serves the model), so it is refused.
  if (req.headers[PEER_HOP] !== undefined && route !== "provider") {
    opts.log(`${req.method} ${req.url ?? "/"} model=${model || "-"} → refused: second peer hop`);
    anthropicError(res, 508, "api_error", `${provider.name} router: refusing to forward a request twice`);
    note?.(508, "refused", "-");
    return;
  }
  if (peer !== undefined)
    return dispatch(
      opts,
      req,
      res,
      original,
      model,
      route,
      new URL(`http://127.0.0.1:${peer.port}`),
      note,
      peer,
    );
  if (route !== "provider")
    return dispatch(opts, req, res, original, model, route, opts.anthropic, note, undefined);
  // A stopped budget turns the provider's models off before anything else, the key included; Claude traffic never
  // reaches this line.
  const stop = budget(model);
  if (stop !== undefined) return budgetStopped(opts, req, res, model, stop, note);
  // Only a provider request ever reads the key: a keychain prompt or a missing key never delays Claude traffic.
  const key = await keyWithin(opts);
  if (key === "none" || key === "timeout") return noKey(opts, req, res, model, key, note);
  const body = stripParsed(original, json, provider.strip);
  return dispatch(opts, req, res, body, model, route, opts.providerUrl, note, undefined, key);
}

/** A provider request while its budget is stopped: the same non-retryable 400 as a refused key, naming the dashboard. */
function budgetStopped(
  opts: RouterOptions,
  req: IncomingMessage,
  res: ServerResponse,
  model: string,
  stop: BudgetStop,
  note: EventNote | undefined,
): void {
  const { provider } = opts;
  opts.log(`${req.method} ${req.url ?? "/"} model=${model} → provider: budget stopped (${stop.scope})`);
  const answer = budgetAnswer(budgetMessage(provider.display, stop));
  res.writeHead(answer.status, answer.headers);
  res.end(answer.body);
  health(opts, "refusal", `budget: ${stop.scope}`, model);
  note?.(answer.status, "provider", opts.providerUrl.host);
}

/** A provider request without a key: a non-retryable 400 that names setup when there is none (never a 401, which
 *  Claude Code would read as its own login failing), 503 when the lookup timed out. */
function noKey(
  opts: RouterOptions,
  req: IncomingMessage,
  res: ServerResponse,
  model: string,
  why: "none" | "timeout",
  note: EventNote | undefined,
): void {
  const { provider } = opts;
  const timedOut = why === "timeout";
  opts.log(
    `${req.method} ${req.url ?? "/"} model=${model} → provider: ${timedOut ? "key lookup timed out" : "no key"}`,
  );
  if (timedOut)
    anthropicError(
      res,
      503,
      "api_error",
      `${provider.name} router: reading the ${provider.display} key timed out`,
    );
  else {
    const answer = refusalAnswer(provider, "key", "no key is set");
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
    health(opts, "refusal", "key: no key is set", model);
  }
  note?.(timedOut ? 503 : 400, "provider", opts.providerUrl.host);
}

/** What a provider's error answer becomes: a refused key or an empty balance the non-retryable refusal, an error that
 *  quotes the key itself the same answer with the key blanked out; undefined to send it as it came. A refusal and a
 *  rate limit are reported as health events (the status only, never the body). */
function providerError(
  opts: RouterOptions,
  answer: IncomingMessage,
  body: Buffer,
  key: string,
  model: string,
): (Replacement & { readonly why: string }) | undefined {
  const { provider } = opts;
  const status = answer.statusCode ?? 0;
  const refusal = refusalOf(status, body);
  if (refusal === undefined && status === 429) health(opts, "rate_limited", "HTTP 429", model);
  if (refusal !== undefined) health(opts, "refusal", `${refusal}: HTTP ${status}`, model);
  if (refusal !== undefined)
    return {
      ...refusalAnswer(provider, refusal, `${provider.display} answered HTTP ${status}`),
      why: refusal === "key" ? "key refused" : "out of balance",
    };
  const text = body.toString("utf8");
  if (key === "" || !text.includes(key)) return undefined;
  const { "content-length": _length, ...headers } = responseHeaders(answer.headers);
  return {
    status,
    headers,
    body: text.replaceAll(key, "[key redacted]"),
    why: "key redacted",
  };
}

function dispatch(
  opts: RouterOptions,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  model: string,
  route: string,
  target: URL,
  note: EventNote | undefined,
  peer: PeerTarget | undefined,
  key?: string,
): void {
  const { provider } = opts;
  const url = upstreamUrl(target, req.url ?? "/");
  const refused = forwardable(route, url);
  if (refused !== undefined) {
    opts.log(`${req.method} ${url.pathname} model=${model || "-"} → ${route} refused`);
    anthropicError(res, 502, "api_error", `${provider.name} router: ${refused}`);
    note?.(502, route, url.host);
    return;
  }
  const headers = upstreamHeaders(req.headers, target, body.length, key);
  if (peer !== undefined) headers[PEER_HOP] = "1";
  let tracker: ReturnType<typeof usageTracker> | undefined;
  // What the client was answered instead of the provider's own status, when the router rewrote its answer.
  let rewritten: number | undefined;
  opts.onUpstream?.(req);
  sendUpstream(
    {
      url,
      method: req.method ?? "POST",
      headers,
      body,
      env: opts.env ?? {},
      ...(peer === undefined ? {} : { direct: true }),
      ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
    },
    res,
    {
      answered: (answer) => {
        opts.log(`${req.method} ${url.pathname} model=${model || "-"} → ${route} ${answer.statusCode}`);
        // Usage is parsed out of the passing stream; the pipe comes first, so the client never waits on it.
        tracker = note === undefined ? undefined : usageTracker(answer.headers["content-type"]);
        if (tracker !== undefined) answer.on("data", (chunk: Buffer) => tracker?.push(chunk));
      },
      finished: (answer) => note?.(rewritten ?? answer.statusCode ?? 502, route, url.host, tracker?.usage()),
      // Only a provider route (the one carrying the key) has its error answers read; Anthropic's and a peer's always
      // go through as they came.
      ...(key === undefined
        ? {}
        : {
            inspect: (answer: IncomingMessage) =>
              mayRefuse(answer.statusCode ?? 0)
                ? (text: Buffer) => {
                    const replacement = providerError(opts, answer, text, key, model);
                    if (replacement !== undefined) {
                      rewritten = replacement.status;
                      opts.log(
                        `${req.method} ${url.pathname} model=${model || "-"} → ${route} ${answer.statusCode} answered ${replacement.status} (${replacement.why})`,
                      );
                    }
                    return replacement;
                  }
                : undefined,
          }),
      failed: ({ code, afterHeaders }) => {
        opts.log(`${req.method} ${url.pathname} model=${model || "-"} → ${route} error ${code}`);
        if (!afterHeaders)
          anthropicError(
            res,
            code === "ETIMEDOUT" ? 504 : 502,
            "api_error",
            peer === undefined
              ? `${provider.name} router: ${route} unreachable (${code})`
              : `${provider.name} router: the ${peer.name} plugin's router is down; run /${peer.name}:setup to restart it`,
          );
        note?.(code === "ETIMEDOUT" && !afterHeaders ? 504 : 502, route, url.host);
      },
    },
  );
}
