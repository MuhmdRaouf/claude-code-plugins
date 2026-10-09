// What a plugin's router writes to Radar's spool: one event per forwarded request, one per router start or
// stop, a health event when something went other than plainly, and one capture event per distinct prompt —
// the request's own system prompt and tool definitions, gzipped. A route event stays metadata (model, route,
// status, latency, usage, the three ids Claude Code sends, the hash its prompt capture sits under and the
// allow-listed response headers); no other header value and no message body ever lands here.

/** The usage counters an answer carries, as the provider or Anthropic reports them. */
export type RouteUsage = Readonly<Record<string, unknown>>;

/** One forwarded request, appended after it completes. */
export interface RouteEvent {
  readonly ts: string;
  readonly event: "route";
  readonly plugin: string;
  readonly model: string;
  readonly upstream: string;
  readonly route: string;
  readonly status: number;
  /** Why the upstream answered an error, when it did and the router read it (provider routes only): one line, the
   *  provider's own `type: message` (or `code: msg`) or the first 300 characters of its text, credentials redacted.
   *  Never a header value, a request byte, or a success answer's anything. */
  readonly error?: string;
  readonly latency_ms: number;
  readonly usage?: RouteUsage;
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly parent_agent_id?: string;
  /** The hash the request's system prompt and tools sit under in its capture event, when the request
   *  carried either. The content itself never rides on the route event. */
  readonly prompt_hash?: string;
  /** A few allow-listed response headers the upstream answered with (request-id, retry-after, the rate
   *  limit counters, content-type); never set-cookie, a credential or anything else. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** One distinct prompt's content, appended once per hash per router process: gzip of the JSON the request
 *  carried at its top level — its `system` and `tools` and nothing else — base64. Written off the request's
 *  turn of the event loop, so the answer never waits on it. */
export interface CaptureEvent {
  readonly ts: string;
  readonly event: "capture";
  readonly plugin: string;
  /** The same sha256 the matching route events carry in `prompt_hash`. */
  readonly prompt_hash: string;
  /** base64 of gzip(JSON.stringify({system, tools})). */
  readonly gz: string;
}

/** A router coming up or shutting down cleanly. */
export interface RouterEvent {
  readonly ts: string;
  readonly event: "router";
  readonly plugin: string;
  readonly port: number;
  readonly state: "start" | "stop";
  readonly version: number;
}

/** What a router's health event reports: a request the passthrough served instead of the router, a provider request
 *  the router refused (no key, a refused key, no balance, a stopped budget), a provider rate limit, a budget turning a
 *  route off, or a worker the front had to replace (and the router retiring: the last line a retired router writes). */
export const ROUTER_HEALTH = ["fallback", "refusal", "rate_limited", "budget_stop", "restart"] as const;
export type RouterHealth = (typeof ROUTER_HEALTH)[number];

/** One router health event (Radar's `router.event` line): what happened and why, the model the request
 *  named when there was one, epoch milliseconds. Never a key, a header value or a byte of any body. */
export interface RouterHealthEvent {
  readonly kind: "router.event";
  readonly plugin: string;
  readonly event: RouterHealth;
  readonly reason: string;
  readonly model: string | null;
  readonly ts: number;
}

/** A health event, a model of "" (none named) recorded as null. */
export function healthEvent(
  plugin: string,
  event: RouterHealth,
  reason: string,
  model: string,
  ts: number,
): RouterHealthEvent {
  return { kind: "router.event", plugin, event, reason, model: model === "" ? null : model, ts };
}

export type SpoolEvent = RouteEvent | RouterEvent | RouterHealthEvent | CaptureEvent;

/** True for a router health event; route and router events are told apart by their `event` field. */
export function isHealthEvent(event: SpoolEvent): event is RouterHealthEvent {
  return "kind" in event && event.kind === "router.event";
}
