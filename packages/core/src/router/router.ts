import { createHash } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { type Duplex, Transform } from "node:stream";
import { gzipSync } from "node:zlib";
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
import { estimatePrompt, type PromptHint, promptKey, recordPrompt } from "./prompt-estimate.ts";
import { budgetAnswer, mayRefuse, refusalAnswer, refusalOf } from "./refusal.ts";
import type { PeerTarget } from "./registry.ts";
import {
  anthropicError,
  BODY_LIMIT_BYTES,
  forwardHeaders,
  harden,
  inspectBody,
  type ProxyEnv,
  type Replacement,
  receive,
  refuseHost,
  responseHeaders,
  sendUpstream,
  TOKEN_HEADER,
  upstreamUrl,
  watchClient,
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
   *  budget stop), when Radar's spool is reachable. */
  readonly events?: (event: SpoolEvent) => void;
  /** Radar budget stop in force for this provider's models, if any (cached by the caller); absent: none. */
  readonly budget?: () => BudgetStop | undefined;
  /** The proxy environment upstream requests honour (HTTPS_PROXY, NO_PROXY, …); none when absent. */
  readonly env?: ProxyEnv;
  /** Called just before a request goes upstream, so the front knows the upstream may have seen it. */
  readonly onUpstream?: (req: IncomingMessage) => void;
  /** The front's token, required on the data path when set: a request without it is answered 403 and never read or
   *  forwarded (the worker behind its front takes one; tests on port 0 run without). */
  readonly token?: string;
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

// ── the prompt capture ───────────────────────────────────────────────────────────────────────────────────────────────
// What a request carried at its top level — its `system` and `tools`, never a header, a key or a message —
// stored once per distinct content. Reading it costs nothing the request pays for: it reads the body the
// router already holds, and the gzip and spool write happen off the request's turn of the event loop.

/** The response headers a route event may carry, case-insensitively; nothing else ever leaves. */
const CAPTURED_HEADER =
  /^(request-id|x-request-id|retry-after|content-type|anthropic-ratelimit-.+|x-ratelimit-.+)$/i;

/** The allow-listed response headers one answer carries, named as the upstream spelled them, or undefined
 *  when it answered with none of them. */
export function capturedHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> | undefined {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const one = Array.isArray(value) ? value.join(", ") : value;
    if (CAPTURED_HEADER.test(name) && typeof one === "string") out[name] = one;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** JSON with every object's keys sorted, so the same content hashes the same however it arrived. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

/** The capture hash of a parsed body — sha256 of the canonical JSON of its `system` and `tools` alone —
 *  or undefined when the body carried neither. */
export function promptHashOf(json: unknown): string | undefined {
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : undefined;
  if (record?.system === undefined && record?.tools === undefined) return undefined;
  const content = JSON.stringify(canonical({ system: record.system, tools: record.tools }));
  return createHash("sha256").update(content).digest("hex");
}

/** The most hashes one router process remembers as already written; past it the oldest drops. */
const CAPTURE_MEMO = 512;

/** Marks the hash as seen, true when this is its first time here (so the event is due). */
function firstCapture(seen: Set<string>, hash: string): boolean {
  if (seen.has(hash)) return false;
  seen.add(hash);
  const oldest = seen.values().next();
  if (seen.size > CAPTURE_MEMO && !oldest.done) seen.delete(oldest.value);
  return true;
}

/** One request's prompt hash, filled in off the request's turn of the event loop; the route event reads it when
 *  the request completes. */
interface PromptRef {
  hash: string | undefined;
}

/** Hashes the prompt and schedules its one capture event, if this process has not written it yet — all of it after
 *  the request is on its way, so the hashing never delays it. A failure costs one log line. */
function capture(opts: RouterOptions, seen: Set<string>, prompt: PromptRef, json: unknown): void {
  const { events } = opts;
  if (events === undefined) return;
  setImmediate(() => {
    try {
      const hash = promptHashOf(json);
      prompt.hash = hash;
      if (hash === undefined || !firstCapture(seen, hash)) return;
      const carried = (json as Record<string, unknown>) ?? {};
      const body = JSON.stringify({ system: carried.system, tools: carried.tools });
      events({
        ts: new Date().toISOString(),
        event: "capture",
        plugin: opts.provider.name,
        prompt_hash: hash,
        gz: gzipSync(Buffer.from(body, "utf8")).toString("base64"),
      });
    } catch (error) {
      opts.log(`route capture: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
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
  // Every element: a field found in the first must not end the walk, or the rest keep theirs.
  if (Array.isArray(value))
    return value.reduce<boolean>((any, item) => stripFrom(item, rejected) || any, false);
  if (typeof value !== "object" || value === null) return false;
  return stripRecord(value as Record<string, unknown>, rejected);
}

function stripRecord(record: Record<string, unknown>, rejected: ReadonlySet<string>): boolean {
  let stripped = false;
  for (const key of Object.keys(record)) {
    if (rejected.has(key)) {
      delete record[key];
      stripped = true;
    } else if (stripFrom(record[key], rejected)) stripped = true;
  }
  return stripped;
}

/** A provider-bound request as this provider accepts it: rejected fields stripped (every message, every block),
 *  `max_tokens` clamped to the model's cap, and a web_search tool sent to the catalog model that serves it. Returns
 *  the original bytes and model when nothing changed, else the re-serialised body and the model it now names. */
function providerBody(
  opts: RouterOptions,
  original: Buffer,
  json: unknown,
  model: string,
  req: IncomingMessage,
): { readonly body: Buffer; readonly model: string } {
  if (typeof json !== "object" || json === null) return { body: original, model };
  const record = json as Record<string, unknown>;
  if (!adaptBody(opts, record, model, req)) return { body: original, model };
  const named = record.model;
  return {
    body: Buffer.from(JSON.stringify(record), "utf8"),
    model: typeof named === "string" ? named : model,
  };
}

/** The in-place edits a provider-bound body needs, one truth each: rejected fields stripped, `max_tokens` clamped
 *  down to the model's cap, and a web_search tool rerouted to the model that takes it (one line when it happens). */
function adaptBody(
  opts: RouterOptions,
  record: Record<string, unknown>,
  model: string,
  req: IncomingMessage,
): boolean {
  const { provider } = opts;
  let changed = provider.strip.length > 0 && stripFrom(record, new Set(provider.strip));
  const cap = [provider.catalog.main, provider.catalog.flash].find((m) => m.id === model)?.maxOutputTokens;
  if (cap !== undefined && typeof record.max_tokens === "number" && record.max_tokens > cap) {
    record.max_tokens = cap;
    changed = true;
  }
  const webSearchModel = provider.webSearchModel;
  if (webSearchModel !== undefined && model !== webSearchModel && carriesWebSearch(record.tools)) {
    record.model = webSearchModel;
    changed = true;
    opts.log(
      `${req.method} ${req.url ?? "/"} model=${model} → provider: web_search tool served by ${webSearchModel}`,
    );
  }
  return changed;
}

/** True when any tool of the request is a web_search server tool: its `type` starts with `web_search_`
 *  (`web_search_20250305`, …). A regular tool carries no `type` at all. */
function carriesWebSearch(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (typeof tool !== "object" || tool === null) return false;
    const type = (tool as Record<string, unknown>).type;
    return typeof type === "string" && type.startsWith("web_search_");
  });
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
  // The front's token belongs to the loopback hop alone; it never reaches an upstream.
  delete out[TOKEN_HEADER];
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
  // The prompt hashes this process has already captured; the oldest drops past the memo.
  const captured = new Set<string>();
  return harden(
    http.createServer((req, res) => {
      // Port 0 (tests, and the worker behind its front) takes any Host: only the front faces Claude Code.
      if (opts.port !== 0 && refuseHost(req, res, provider.name, [opts.port])) return;
      if (req.method === "GET" && req.url === provider.router.healthPath) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: provider.name, provider: provider.display }));
        return;
      }
      // The worker's data path answers with the provider's key in play, so nothing is read or forwarded before the
      // front's token is on the request (the front stamps it on the hop it hands its worker).
      if (opts.token !== undefined && req.headers[TOKEN_HEADER] !== opts.token) {
        anthropicError(res, 403, "permission_error", `${provider.name} router: data path refused`);
        return;
      }
      receive(req, res, provider.name, opts.bodyLimit ?? BODY_LIMIT_BYTES, (body) => {
        void forward(opts, claim, budget, captured, req, res, body);
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

type EventNote = (
  status: number,
  route: string,
  upstream: string,
  usage?: RouteUsage,
  error?: string,
  headers?: Readonly<Record<string, string>>,
) => void;

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

/** The ids Claude Code stamped the request with, each on the event only when the request sent one; no other
 *  header value is ever recorded. */
function eventIds(req: IncomingMessage): {
  session_id?: string;
  agent_id?: string;
  parent_agent_id?: string;
} {
  const sessionId = textHeader(req, "x-claude-code-session-id");
  const agentId = textHeader(req, "x-claude-code-agent-id");
  const parentAgentId = textHeader(req, "x-claude-code-parent-agent-id");
  return {
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    ...(parentAgentId === undefined ? {} : { parent_agent_id: parentAgentId }),
  };
}

/** The event's optional payload: the usage counters and the allow-listed response headers, each only when the
 *  answer carried one. */
function eventExtras(
  usage: RouteUsage | undefined,
  headers: Readonly<Record<string, string>> | undefined,
): { usage?: RouteUsage; headers?: Readonly<Record<string, string>> } {
  return {
    ...(usage === undefined || Object.keys(usage).length === 0 ? {} : { usage }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** The route event for one request, emitted when it completes; undefined when nobody listens. */
function eventNote(
  opts: RouterOptions,
  req: IncomingMessage,
  model: string,
  startedAt: number,
  prompt: PromptRef,
): EventNote | undefined {
  const { events, provider } = opts;
  if (events === undefined) return undefined;
  return (status, route, upstream, usage, error, headers) => {
    const event: RouteEvent = {
      ts: new Date().toISOString(),
      event: "route",
      plugin: provider.name,
      model,
      upstream,
      route,
      status,
      ...(error === undefined ? {} : { error }),
      latency_ms: Date.now() - startedAt,
      ...eventIds(req),
      ...eventExtras(usage, headers),
      ...(prompt.hash === undefined ? {} : { prompt_hash: prompt.hash }),
    };
    events(event);
  };
}

/** Reads an answer's usage as it passes through, never ahead of the pipe: an SSE stream is parsed line by line as it
 *  goes (only a partial line is ever held), a JSON body carries it at the top level and is buffered up to a cap before
 *  it is read once it ends — past the cap nothing is buffered and the route event carries no usage. A compressed
 *  answer is read through its decompressed copy. */
export function usageTracker(
  contentType: string | undefined,
  encoding?: string | string[],
): {
  push(chunk: Buffer): void;
  usage(): RouteUsage | undefined;
} {
  if (contentType?.includes("text/event-stream") === true) return sseUsage();
  if (contentType?.includes("application/json") === true) return jsonUsage(encoding);
  return { push: () => undefined, usage: () => undefined };
}

/** The most of a JSON answer usage tracking buffers: past it nothing more is kept and no usage is recorded (the same
 *  ceiling the router's other interception points keep, so a big answer is never held twice). */
const USAGE_LIMIT_BYTES = 64 * 1024;

function jsonUsage(encoding: string | string[] | undefined): {
  push(chunk: Buffer): void;
  usage(): RouteUsage | undefined;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  let parsed: RouteUsage | undefined;
  let done = false;
  return {
    push: (chunk) => {
      size += chunk.length;
      if (size > USAGE_LIMIT_BYTES) over = true;
      if (!over) chunks.push(chunk);
    },
    usage: () => {
      if (!done) {
        done = true;
        parsed = over ? undefined : topLevelUsage(chunks, encoding);
      }
      return parsed;
    },
  };
}

/** The `usage` at the top level of the collected JSON body, when it parses and carries one. */
function topLevelUsage(chunks: readonly Buffer[], encoding?: string | string[]): RouteUsage | undefined {
  try {
    return nestedUsage(JSON.parse(inspectBody(Buffer.concat([...chunks]), encoding).toString("utf8")));
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

/** The byte an SSE stream's lines are split on. */
const NEWLINE_BYTE = 0x0a;

/** The most of a provider stream the prompt rewriter may hold back while waiting for its first `message_start`; past
 *  it the stream goes out as it came, unrewritten (the estimate is a courtesy, never a delay). */
const PROMPT_REWRITE_LIMIT_BYTES = 64 * 1024;

/** The stream a provider answer's first `message_start` is rewritten through, or undefined to pipe it as it came:
 *  a provider route streaming SSE only. */
function promptRewrite(prompt: PromptHint | undefined, answer: IncomingMessage): Duplex | undefined {
  if (prompt === undefined) return undefined;
  return answer.headers["content-type"]?.includes("text/event-stream") === true
    ? promptRewriter(prompt)
    : undefined;
}

/** A pass-through stream that gives the first `message_start` of a provider answer a real prompt size: Z.ai (and
 *  other providers) send zeros there and only the real numbers in the final `message_delta`, which left Claude Code
 *  showing "183 tokens" for a subagent holding a 150k-token context. `input_tokens` becomes the conversation's
 *  estimate and the cache fields are added as 0; every other line goes out byte for byte. */
function promptRewriter(prompt: PromptHint): Transform {
  // Whole lines only are looked at (a line may straddle chunks, and no UTF-8 sequence ever contains a newline byte),
  // and bytes are held only until the first `message_start` has gone out — rewritten or not.
  let pending: Buffer = Buffer.alloc(0);
  let decided = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, next): void {
      if (decided) {
        next(null, chunk);
        return;
      }
      const head = rewriteHead(pending, chunk, prompt);
      decided = head.decided;
      if (head.decided) head.out.push(head.rest);
      pending = head.decided ? Buffer.alloc(0) : head.rest;
      if (head.out.length === 0) next();
      else next(null, Buffer.concat(head.out));
    },
    flush(next): void {
      // A stream that ended before its first `message_start` goes out as it came.
      if (decided || pending.length === 0) next();
      else next(null, pending);
      pending = Buffer.alloc(0);
    },
  });
}

/** One pass of the rewriter over the bytes held so far plus a new chunk: every line before the first `message_start`
 *  and that line itself (rewritten when it needs it) go out; the rest is held again, or given up on past the limit. */
function rewriteHead(
  held: Buffer,
  chunk: Buffer,
  prompt: PromptHint,
): { readonly out: Buffer[]; readonly rest: Buffer; readonly decided: boolean } {
  let rest: Buffer = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
  const out: Buffer[] = [];
  for (;;) {
    const at = rest.indexOf(NEWLINE_BYTE);
    if (at < 0) break;
    const line = rest.subarray(0, at + 1);
    rest = rest.subarray(at + 1);
    const text = line.toString("utf8");
    const rewritten = rewrittenStartLine(text, prompt);
    if (rewritten === undefined) {
      out.push(line);
      continue;
    }
    out.push(rewritten === text ? line : Buffer.from(rewritten, "utf8"));
    return { out, rest, decided: true };
  }
  return { out, rest, decided: rest.length > PROMPT_REWRITE_LIMIT_BYTES };
}

/** The replacement for one complete SSE line — the first `message_start`'s zero usage rewritten to this
 *  conversation's estimate, or the line unchanged when it carries a real prompt size or the cache fields already —
 *  or undefined for any other line. */
function rewrittenStartLine(line: string, prompt: PromptHint): string | undefined {
  const event = sseEvent(line);
  if (event?.type !== "message_start") return undefined;
  const usage = nestedUsage(event.message);
  // A real prompt size, or the cache fields Claude Code reads beside it, are left exactly as they came.
  if (usage === undefined || usage.input_tokens !== 0 || "cache_read_input_tokens" in usage) return line;
  const edit = usage as Record<string, unknown>;
  edit.input_tokens = estimatePrompt(prompt.key, prompt.bodyChars);
  edit.cache_creation_input_tokens = 0;
  edit.cache_read_input_tokens = 0;
  return `data: ${JSON.stringify(event)}${line.endsWith("\r\n") ? "\r\n" : "\n"}`;
}

/** The conversation a provider request belongs to, as its stream's first `message_start` may need it: the key and
 *  the request body's length, the measure the estimate grows by. */
function promptHint(json: unknown, bodyChars: number): PromptHint {
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return { key: promptKey(record.system, messages[0]), bodyChars };
}

/** Remembers a finished answer's real prompt size against its conversation, for the next turn's estimate. */
function recordFinal(
  prompt: PromptHint | undefined,
  tracker: ReturnType<typeof usageTracker> | undefined,
): void {
  if (prompt === undefined) return;
  recordPrompt(prompt.key, tracker?.usage(), prompt.bodyChars);
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
  captured: Set<string>,
  req: IncomingMessage,
  res: ServerResponse,
  original: Buffer,
): Promise<void> {
  const { provider } = opts;
  const json = parseBody(original);
  const model = modelIn(json);
  const prompt: PromptRef = { hash: undefined };
  const note = eventNote(opts, req, model, Date.now(), prompt);
  const { route, peer } = routeOf(claim, model, opts.peers);
  // A request another plugin's router forwarded here is served when it is this provider's model; anything else would
  // be a second hop (a loop, or two routers disagreeing about who serves the model), so it is refused.
  if (req.headers[PEER_HOP] !== undefined && route !== "provider") {
    opts.log(`${req.method} ${req.url ?? "/"} model=${model || "-"} → refused: second peer hop`);
    anthropicError(res, 508, "api_error", `${provider.name} router: refusing to forward a request twice`);
    note?.(508, "refused", "-", undefined, "refusing to forward a request twice");
    return;
  }
  // The request is on its way: read what its body carried off this turn of the event loop, once per content.
  capture(opts, captured, prompt, json);
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
  // The client is watched while it reads: one that leaves during the lookup is answered by nobody, so nothing goes
  // upstream for it.
  const gone = watchClient(res);
  const key = await keyWithin(opts);
  if (gone()) return;
  if (key === "none" || key === "timeout") return noKey(opts, req, res, model, key, note);
  const adapted = providerBody(opts, original, json, model, req);
  return dispatch(
    opts,
    req,
    res,
    adapted.body,
    adapted.model,
    route,
    opts.providerUrl,
    note,
    undefined,
    key,
    promptHint(json, adapted.body.length),
  );
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

/** The most of an error answer the router reads to say why it failed: the judge already holds the whole answer back,
 *  so these are its first bytes re-read — never a second read, and a success answer is never read at all. */
const REASON_BYTES = 2048;

/** The longest reason a route event or a log line carries. */
const REASON_CHARS = 300;

/** A run of key- and token-shaped characters long enough to be a credential: gone before a reason is stored. */
const SECRET_LIKE = /[A-Za-z0-9._-]{24,}/g;

/** The one-line reason an upstream error answer gives, or undefined when it gives none: its `type: message` (or the
 *  `code`-shaped errors Z.ai answers with), else the first 300 characters of its text — whitespace collapsed, the
 *  route's own key and every credential-shaped run redacted, so no secret ever reaches a log or the spool, and no
 *  request content ever appears in an error answer to begin with. */
export function upstreamErrorReason(body: Buffer, key?: string): string | undefined {
  const text = body.subarray(0, REASON_BYTES).toString("utf8");
  const said = errorMessage(text) ?? text;
  const line = (key === undefined || key === "" ? said : said.replaceAll(key, "…"))
    .replace(/\s+/g, " ")
    .replace(SECRET_LIKE, "…")
    .trim()
    .slice(0, REASON_CHARS)
    .trimEnd();
  return line === "" ? undefined : line;
}

/** A field of a parsed error body that is a non-empty string, or undefined. */
function errorField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The message an upstream error body carries, in the shapes providers actually send: Anthropic's
 *  `{error:{type,message}}` and the `code`-shaped errors Z.ai answers with (`{error:{code,message}}`, `{code,msg}`).
 *  Undefined for anything else, leaving the raw text as the reason. */
function errorMessage(text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const body = json as Record<string, unknown>;
  const error = body.error;
  if (typeof error === "object" && error !== null) {
    const inner = error as Record<string, unknown>;
    return saidWhat(errorField(inner, "type") ?? errorField(inner, "code"), errorField(inner, "message"));
  }
  return saidWhat(errorField(body, "code"), errorField(body, "msg") ?? errorField(body, "message"));
}

/** An error's `what: message`, its message alone without a `what`, undefined without both. */
function saidWhat(what: string | undefined, message: string | undefined): string | undefined {
  if (message === undefined) return what;
  return what === undefined ? message : `${what}: ${message}`;
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
  // The replacement goes out plain, so it does not claim the encoding the provider's bytes came with.
  const {
    "content-length": _length,
    "content-encoding": _encoding,
    ...headers
  } = responseHeaders(answer.headers);
  return {
    status,
    headers,
    body: text.replaceAll(key, "[key redacted]"),
    why: "key redacted",
  };
}

/** What one request's inspection decided: the status the client was answered instead of the upstream's, when the
 *  router rewrote its answer, and why the upstream failed (once its held-back body has been read). */
interface Inspection {
  rewritten: number | undefined;
  reason: string | undefined;
}

/** The hooks that read a provider route's error answers (the only route carrying a key): each held-back answer is
 *  read once — refused or not — and its one log line carries the reason. */
function providerInspection(
  opts: RouterOptions,
  req: IncomingMessage,
  url: URL,
  route: string,
  model: string,
  key: string,
  decided: Inspection,
): {
  inspect: (answer: IncomingMessage) => ((text: Buffer) => Replacement | undefined) | undefined;
  oversize: (answer: IncomingMessage) => void;
} {
  const line = (status: number | undefined, why = ""): string =>
    `${req.method} ${url.pathname} model=${model || "-"} → ${route} ${status}${why}`;
  return {
    inspect: (answer) =>
      mayRefuse(answer.statusCode ?? 0)
        ? (text) => {
            // A compressed answer is judged through its decompressed copy; its own bytes are what the client gets.
            const body = inspectBody(text, answer.headers["content-encoding"]);
            const replacement = providerError(opts, answer, body, key, model);
            // A rewritten answer's why is already on its health event, and its text never leaves the router (a
            // refusal quotes nothing upstream, one quoting the key is blanked out); only an error that went
            // through as it came records its reason — the route's key redacted out regardless.
            decided.reason = replacement === undefined ? upstreamErrorReason(body, key) : undefined;
            opts.log(line(answer.statusCode, decided.reason === undefined ? "" : ` (${decided.reason})`));
            if (replacement !== undefined) {
              decided.rewritten = replacement.status;
              opts.log(line(answer.statusCode, ` answered ${replacement.status} (${replacement.why})`));
            }
            return replacement;
          }
        : undefined,
    // An answer too big for its judge went out as it came, its reason unread: the line is logged plain.
    oversize: (answer) => opts.log(line(answer.statusCode)),
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
  prompt?: PromptHint,
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
  // The answer's allow-listed headers, read once as its head arrives, for the route event's note.
  let answerHeaders: Readonly<Record<string, string>> | undefined;
  // What this answer's inspection decided (a provider route only): the client's status when the answer was
  // rewritten, and why the upstream failed.
  const decided: Inspection = { rewritten: undefined, reason: undefined };
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
        // A provider error answer is held back for its judge, so its line waits and carries the reason; every other
        // answer is logged the moment its headers arrive.
        if (!(key !== undefined && mayRefuse(answer.statusCode ?? 0)))
          opts.log(`${req.method} ${url.pathname} model=${model || "-"} → ${route} ${answer.statusCode}`);
        // Usage is parsed out of the passing stream; the pipe comes first, so the client never waits on it.
        tracker =
          note === undefined
            ? undefined
            : usageTracker(answer.headers["content-type"], answer.headers["content-encoding"]);
        answerHeaders = note === undefined ? undefined : capturedHeaders(answer.headers);
        if (tracker !== undefined) answer.on("data", (chunk: Buffer) => tracker?.push(chunk));
      },
      rewrite: (answer) => promptRewrite(prompt, answer),
      finished: (answer) => {
        // The final numbers are the real ones: remembered here, so the conversation's next turn can estimate the
        // prompt size its provider will not report until the end.
        recordFinal(prompt, tracker);
        note?.(
          decided.rewritten ?? answer.statusCode ?? 502,
          route,
          url.host,
          tracker?.usage(),
          decided.reason,
          answerHeaders,
        );
      },
      // Only a provider route (the one carrying the key) has its error answers read; Anthropic's and a peer's always
      // go through as they came.
      ...(key === undefined ? {} : providerInspection(opts, req, url, route, model, key, decided)),
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
        note?.(
          code === "ETIMEDOUT" && !afterHeaders ? 504 : 502,
          route,
          url.host,
          undefined,
          // the errno is the whole reason a dropped connection has; never a header or a body byte
          `connection failed (${code})`,
        );
      },
    },
  );
}
