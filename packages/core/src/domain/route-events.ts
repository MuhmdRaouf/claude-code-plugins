// What a plugin's router writes to the observatory spool: one event per forwarded request, one per router start or
// stop, and a health event when something went other than plainly. Metadata only, never a header value or a byte of
// any body.

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
  readonly latency_ms: number;
  readonly usage?: RouteUsage;
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly parent_agent_id?: string;
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
 *  route off, or a worker the front had to replace. */
export const ROUTER_HEALTH = ["fallback", "refusal", "rate_limited", "budget_stop", "restart"] as const;
export type RouterHealth = (typeof ROUTER_HEALTH)[number];

/** One router health event (the observatory's `router.event` line): what happened and why, the model the request
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

export type SpoolEvent = RouteEvent | RouterEvent | RouterHealthEvent;

/** True for a router health event; route and router events are told apart by their `event` field. */
export function isHealthEvent(event: SpoolEvent): event is RouterHealthEvent {
  return "kind" in event && event.kind === "router.event";
}
