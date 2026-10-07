/**
 * API routing as a pure function: parse a pathname + query, return status/body. No sockets here, so tests
 * cover every route without an HTTP server. Query values are strings (or repeated); limits are clamped.
 */
import {
  ATTRIBUTION_BY,
  ATTRIBUTION_RANGES,
  type AttributionBy,
  type AttributionRange,
} from "../cost/attribution.ts";
import { PRICES_RETRIEVED } from "../cost/prices.ts";
import type { Store } from "../store/store.ts";
import type { Insights } from "./insights.ts";

export type ApiRequest = { path: string; query: URLSearchParams };
export type ApiResponse = { status: number; body: unknown };

export type AppInfo = { version: string; startedAt: number; port: number };

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

function clampLimit(raw: string | null): number {
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function numParam(query: URLSearchParams, key: string): number | null {
  const raw = query.get(key);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `{key: value}` when present, `{}` when not — keeps exactOptionalPropertyTypes honest. */
function maybe<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V };
}

function json(status: number, body: unknown): ApiResponse {
  return { status, body };
}

/** The paged record lists: requests, events and tool calls, newest first. */
function listRoute(store: Store, path: string, query: URLSearchParams): ApiResponse | null {
  if (path === "/api/requests") {
    return json(200, {
      requests: store.requests({
        ...maybe("session", query.get("session")),
        ...maybe("agent", query.get("agent")),
        ...maybe("model", query.get("model")),
        ...maybe("since", numParam(query, "since")),
        limit: clampLimit(query.get("limit")),
      }),
    });
  }
  if (path === "/api/events") {
    return json(200, {
      events: store.events({
        ...maybe("session", query.get("session")),
        ...maybe("since", numParam(query, "since")),
        limit: clampLimit(query.get("limit")),
      }),
    });
  }
  if (path === "/api/tools") {
    return json(200, {
      tools: store.tools({
        ...maybe("session", query.get("session")),
        ...(query.get("failed") === "1" ? { failed: true } : {}),
        limit: clampLimit(query.get("limit")),
      }),
    });
  }
  return null;
}

function oneOf<T extends string>(allowed: readonly T[], raw: string | null, fallback: T): T | null {
  if (raw === null || raw === "") return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** The derived views: costs, budgets, alerts, settings, router health, the model advisor. */
function insightRoute(insights: Insights, path: string, query: URLSearchParams): ApiResponse | null {
  switch (path) {
    case "/api/alerts":
      return json(200, { alerts: insights.alerts() });
    case "/api/attribution": {
      const by = oneOf<AttributionBy>(ATTRIBUTION_BY, query.get("by"), "project");
      const range = oneOf<AttributionRange>(ATTRIBUTION_RANGES, query.get("range"), "day");
      if (by === null) return json(400, { error: `by: one of ${ATTRIBUTION_BY.join(", ")}` });
      if (range === null) return json(400, { error: `range: one of ${ATTRIBUTION_RANGES.join(", ")}` });
      return json(200, { by, range, rows: insights.attribution(by, range) });
    }
    case "/api/budgets":
      return json(200, { budgets: insights.budgets(), providers: insights.providers() });
    case "/api/budget-status":
      return json(200, insights.budgetStatus());
    case "/api/spend":
      return json(200, { todayUsd: insights.spendToday(), pricesRetrieved: PRICES_RETRIEVED });
    case "/api/settings":
      return json(200, { settings: insights.settings() });
    case "/api/router":
      return json(200, insights.routerHealth());
    case "/api/advisor":
      return json(200, insights.advisor());
    default:
      return null;
  }
}

function saved<T>(key: string, result: T | string): ApiResponse {
  return typeof result === "string" ? json(400, { error: result }) : json(200, { [key]: result });
}

function dismissAlert(insights: Insights, body: unknown): ApiResponse {
  const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !insights.dismiss(id)) return json(400, { error: "id: the alert's id" });
  return json(200, { dismissed: id });
}

/** PUT /api/budgets, PUT /api/settings, POST /api/alerts/dismiss: validated JSON in, the saved value out. */
export function handleWrite(
  insights: Insights | undefined,
  method: string,
  path: string,
  body: unknown,
): ApiResponse {
  if (insights === undefined) return json(503, { error: "not available" });
  const route = `${method} ${path}`;
  if (route === "PUT /api/budgets") return saved("budgets", insights.setBudgets(body));
  if (route === "PUT /api/settings") return saved("settings", insights.setSettings(body));
  if (route === "POST /api/alerts/dismiss") return dismissAlert(insights, body);
  return json(405, { error: "method not allowed" });
}

/** Route one request; unknown /api paths get a 404 with the known routes listed. */
export function handleApi(
  store: Store,
  info: AppInfo,
  request: ApiRequest,
  insights?: Insights,
): ApiResponse {
  const { path, query } = request;
  const derived = insights === undefined ? null : insightRoute(insights, path, query);
  if (derived !== null) return derived;
  if (path === "/api/summary") {
    return json(200, { summary: store.summary() });
  }
  if (path === "/api/sessions") {
    return json(200, { sessions: store.sessionList() });
  }
  if (path.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(path.slice("/api/sessions/".length));
    if (id === "") return json(404, { error: "missing session id" });
    const session = store.sessionDetail(id);
    return session === null ? json(404, { error: `unknown session: ${id}` }) : json(200, { session });
  }
  const listed = listRoute(store, path, query);
  if (listed !== null) return listed;
  if (path === "/api/models") {
    return json(200, store.models());
  }
  if (path === "/api/health") {
    return json(200, {
      ok: true,
      version: info.version,
      startedAt: info.startedAt,
      port: info.port,
      sessions: store.sessionList().length,
      uptimeMs: Date.now() - info.startedAt,
    });
  }
  return json(404, { error: `no such route: ${path}`, routes: ROUTES });
}

export const ROUTES = [
  "/api/summary",
  "/api/sessions",
  "/api/sessions/:id",
  "/api/requests",
  "/api/events",
  "/api/tools",
  "/api/models",
  "/api/health",
  "/api/alerts",
  "/api/attribution",
  "/api/budgets",
  "/api/budget-status",
  "/api/spend",
  "/api/settings",
  "/api/router",
  "/api/advisor",
] as const;
