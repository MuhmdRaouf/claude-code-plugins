// Estimates a provider conversation's prompt size for the `message_start` events that report none: Z.ai (and other
// providers) send `"usage":{"input_tokens":0,"output_tokens":0}` there and only the real numbers in the final
// `message_delta`, which left Claude Code showing "183 tokens" for a subagent holding a 150k-token context. A
// conversation is recognised by its `system` and first message — the parts every turn repeats — and what its last
// finished stream really cost feeds the next turn's estimate.

import { createHash } from "node:crypto";
import type { RouteUsage } from "../domain/route-events.ts";

/** How much of each part goes into a conversation key: enough to tell conversations apart, never the whole
 *  transcript. */
const KEY_PART_CHARS = 4096;

/** The conversations remembered at most; the oldest falls out past this, so the map stays small forever. */
const LRU_MAX = 500;

/** How many body bytes a token is taken to be (the usual four-or-so characters per token). */
const BYTES_PER_TOKEN = 4;

/** What one conversation remembers about its last finished stream: its real prompt size and how long the request
 *  body was, so the next turn's growth can be priced in bytes. */
interface LastTurn {
  readonly promptTokens: number;
  readonly bodyChars: number;
}

/** The conversations, oldest first and newest last: a Map keeps insertion order, which is the LRU. */
const lastTurns = new Map<string, LastTurn>();

/** What the router needs to estimate one stream's prompt size: the conversation's key and the request body's length. */
export interface PromptHint {
  readonly key: string;
  readonly bodyChars: number;
}

/** A part's JSON cut to the key's budget; a missing part and differences past the cut read the same. */
function cut(value: unknown): string {
  return (JSON.stringify(value) ?? "").slice(0, KEY_PART_CHARS);
}

/** The conversation's key: a short hash of its `system` and first message, the parts of a request that never change
 *  from one turn to the next. */
export function promptKey(system: unknown, firstMessage: unknown): string {
  return createHash("sha1")
    .update(cut(system) + cut(firstMessage))
    .digest("hex")
    .slice(0, 16);
}

/** Remembers what a finished stream really cost, when its final usage carries a real prompt size — a zero or a
 *  missing input_tokens is the very lie this module exists to paper over, never a fact to remember. */
export function recordPrompt(key: string, final: RouteUsage | undefined, bodyChars: number): void {
  if (final === undefined) return;
  const input = final.input_tokens;
  if (typeof input !== "number" || input <= 0) return;
  const read = final.cache_read_input_tokens;
  const created = final.cache_creation_input_tokens;
  remember(key, {
    promptTokens: input + (typeof read === "number" ? read : 0) + (typeof created === "number" ? created : 0),
    bodyChars,
  });
}

/** The prompt size to report for a stream of this conversation and body length: what its last turn cost plus the
 *  bytes added since, or a quarter token per byte for a conversation never seen before. */
export function estimatePrompt(key: string, bodyChars: number): number {
  const last = lastTurns.get(key);
  if (last === undefined) return Math.round(bodyChars / BYTES_PER_TOKEN);
  remember(key, last);
  return Math.round(last.promptTokens + Math.max(0, bodyChars - last.bodyChars) / BYTES_PER_TOKEN);
}

/** Puts a conversation back at the newest end, dropping the oldest once the map is over the cap. */
function remember(key: string, last: LastTurn): void {
  lastTurns.delete(key);
  lastTurns.set(key, last);
  const oldest = lastTurns.keys().next();
  if (lastTurns.size > LRU_MAX && !oldest.done) lastTurns.delete(oldest.value);
}
