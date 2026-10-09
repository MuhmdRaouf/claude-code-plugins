/**
 * One model call can reach the store twice: a provider plugin's router writes a spool line when the answer
 * completes, and Claude Code writes the same answer into its transcript. This module decides when two records
 * are that one call and how they combine: the transcript knows the agent, the tokens and the stop reason; the
 * spool knows the upstream, the route, the provider and the latency.
 */
import { offeringHostOf } from "../cost/prices.ts";
import { type RequestRecord, totalTokens } from "../shared/model.ts";

/** How far apart the two clocks may read for one call: both stamp the moment the answer is written. */
export const MATCH_MS = 10_000;

/** "agent-a31cd…" (a transcript file name) and "a31cd…" (the router's header) name the same agent. */
export function bareAgent(id: string): string {
  return id.startsWith("agent-") ? id.slice("agent-".length) : id;
}

/** True for a record a router's spool line produced. */
export const fromRouter = (record: RequestRecord): boolean => record.route !== undefined;

/**
 * Fill an empty upstream with the host the model's own provider serving names (glm-… → api.z.ai): a
 * transcript copy alone never says where its call went, and the provider's own host is the honest
 * reading. Anthropic and unknown ids stay empty — a claude call with no recorded upstream went direct.
 */
export function fillUpstream(record: RequestRecord): RequestRecord {
  if (record.upstream !== "") return record;
  const host = offeringHostOf(record.model);
  return host === null ? record : { ...record, upstream: host };
}

/**
 * How well a transcript call fits a spool line: null when it cannot be the same call, else a distance where
 * smaller is closer (time apart, plus any difference in measured latency).
 */
export function matchDistance(
  transcript: RequestRecord,
  route: RequestRecord,
  routeAgent: string,
): number | null {
  if (transcript.sessionId !== route.sessionId || transcript.model !== route.model) return null;
  if (routeAgent !== "" && bareAgent(routeAgent) !== bareAgent(transcript.agentId)) return null;
  const apart = Math.abs(transcript.ts - route.ts);
  if (apart > MATCH_MS) return null;
  const latencyGap =
    transcript.latencyMs === null || route.latencyMs === null
      ? 0
      : Math.abs(transcript.latencyMs - route.latencyMs);
  return apart + latencyGap;
}

/** The single record for a call both sources saw, stored under `id`. The route line's usage wins when it
 *  carries any: the router tracked the provider's own stream before any rewrite, while the transcript's
 *  copy repeats what the (possibly rewritten) stream opened with. */
export function combine(transcript: RequestRecord, route: RequestRecord, id: string): RequestRecord {
  const merged: RequestRecord = {
    ...transcript,
    id,
    upstream: route.upstream !== "" ? route.upstream : transcript.upstream,
    latencyMs: route.latencyMs ?? transcript.latencyMs,
    tokens: totalTokens(route.tokens) > 0 ? route.tokens : transcript.tokens,
    stopReason: transcript.stopReason ?? route.stopReason,
    provider: route.provider,
  };
  if (route.route !== undefined) merged.route = route.route;
  if (route.via !== undefined) merged.via = route.via;
  // the capture the route line names must survive the pairing, or the request loses its prompt
  if (route.promptHash !== undefined) merged.promptHash = route.promptHash;
  if (route.headers !== undefined) merged.headers = route.headers;
  return fillUpstream(merged);
}

/** A later copy of a record already held (streaming writes one answer several times). */
export function refresh(existing: RequestRecord, record: RequestRecord): RequestRecord {
  const routed = fromRouter(existing);
  const merged: RequestRecord = {
    ...existing,
    model: record.model || existing.model,
    latencyMs: routed ? existing.latencyMs : (record.latencyMs ?? existing.latencyMs),
    upstream: routed || record.upstream === "" ? existing.upstream : record.upstream,
    tokens: totalTokens(record.tokens) > 0 ? record.tokens : existing.tokens,
    stopReason: record.stopReason ?? existing.stopReason,
  };
  // the result event that totals a provider-only stream lands as a later copy of the request it fills
  if (record.totals === true) merged.totals = true;
  // a streamed answer's later copies carry the fuller `what` (the tools the message ended with)
  if (record.what !== undefined) merged.what = record.what;
  return fillUpstream(merged);
}
