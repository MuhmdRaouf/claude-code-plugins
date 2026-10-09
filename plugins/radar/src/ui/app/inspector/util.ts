/**
 * The inspector's pure helpers: the HTTP status a request's stop reason carries, the failed attempts the
 * view holds around it, and the JSON shapes the Raw tab renders. No Preact here, so tests can call every
 * one of them directly.
 */

import type { RequestRecord } from "../../../shared/model.ts";
import { fmtNum } from "../../fmt.ts";
import type { CapturedTool } from "../../state.ts";

/** A stop reason that is a bare three-digit code is the HTTP status a router recorded for the call. */
const HTTP_CODE = /^\d{3}$/;

/** The HTTP status a request's stop reason carries ("429" from a router line), null for a real stop reason. */
export function httpStatusOf(request: RequestRecord): number | null {
  return request.stopReason !== null && HTTP_CODE.test(request.stopReason)
    ? Number(request.stopReason)
    : null;
}

/** How far back from a request a failed attempt still counts as its retry. */
export const RETRY_LOOKBACK_MS = 2 * 60_000;

/** The failed attempts the view holds for the same agent chain just before this one, newest first: the
 *  retries the router recorded (a transcript retry leaves the same mark once it gave up). */
export function nearbyRetries(requests: RequestRecord[], request: RequestRecord): RequestRecord[] {
  return requests
    .filter(
      (candidate) =>
        candidate.id !== request.id &&
        candidate.sessionId === request.sessionId &&
        candidate.agentId === request.agentId &&
        candidate.ts < request.ts &&
        request.ts - candidate.ts <= RETRY_LOOKBACK_MS &&
        (httpStatusOf(candidate) ?? 0) >= 400,
    )
    .sort((a, b) => b.ts - a.ts);
}

/** The retries field's value: "none" or the count with the statuses that made them. */
export function retriesText(retries: RequestRecord[]): string {
  if (retries.length === 0) return "None recorded";
  const statuses = [...new Set(retries.map((retry) => httpStatusOf(retry) ?? 0))]
    .sort((a, b) => a - b)
    .map((status) => (Number.isFinite(status) && status > 0 ? String(status) : "?"));
  return `${fmtNum(retries.length)} within ${Math.round(RETRY_LOOKBACK_MS / 60_000)} min (${statuses.join(", ")})`;
}

/** Pretty JSON for the Raw tab; a value that cannot stringify reads as its string form instead of throwing. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A block text's first line, for a collapsed conversation row. */
export function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? "").trim();
}

/** The record and, once they are fetched, the stored sides, as one JSON document. */
export function rawDocument(
  request: RequestRecord,
  content: { input: unknown; output: unknown } | null,
): unknown {
  return {
    request,
    ...(content === null ? {} : { input: content.input, output: content.output }),
  };
}

/** A captured system prompt as one text: the string it was, or its text blocks joined; anything else is
 *  the JSON it actually is, so nothing the request carried is silently dropped. */
export function captureSystemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return system === null || system === undefined ? "" : prettyJson(system);
  const blocks = system.filter(
    (block): block is { text: string } =>
      typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string",
  );
  return blocks.map((block) => block.text).join("\n\n");
}

/** A captured prompt's tools, as the wire carried them; anything that is not an object is dropped. */
export function captureTools(tools: unknown): CapturedTool[] {
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool): tool is CapturedTool => typeof tool === "object" && tool !== null && !Array.isArray(tool),
  );
}

/** A captured tool's display name, for its collapsed row. */
export function captureToolName(tool: CapturedTool): string {
  return typeof tool.name === "string" && tool.name !== "" ? tool.name : "tool";
}
