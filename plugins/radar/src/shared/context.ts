/**
 * How full a session's context window is, read off the requests the store already holds: the window the
 * session's model ids and request sizes reveal (200k, or 1M), and one call's input plus cache tokens.
 * Shared by the alerts engine (compaction near) and the rail's session cards (the context gauge).
 */
import type { RequestRecord } from "./model.ts";

export const CONTEXT_SMALL = 200_000;
export const CONTEXT_LARGE = 1_000_000;
export const contextOf = (r: RequestRecord): number =>
  r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite;

/** A request whose tokens are the whole run's total from its result event, not one call's context. */
export const isRunTotal = (r: RequestRecord): boolean => r.totals === true;

/** The context window a session's agents work in: 1M once a model id or a request shows it, else 200k.
 *  A run total says nothing about any one call's context, so those requests stay out of the decision. */
export function contextWindow(requests: RequestRecord[]): number {
  const large = requests.some(
    (r) => !isRunTotal(r) && (/\[1m\]|-1m\b/i.test(r.model) || contextOf(r) > CONTEXT_SMALL),
  );
  return large ? CONTEXT_LARGE : CONTEXT_SMALL;
}
