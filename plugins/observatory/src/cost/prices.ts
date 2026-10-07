/**
 * What tokens cost, from the one price table every plugin in the monorepo shares (packages/core, bundled in at
 * build time). Every figure is an estimate at list price: cache reads and writes are priced at their own rates,
 * and a model the table does not know (every claude-* model, an env-overridden id) has no price at all — callers
 * show its tokens and say "unpriced" rather than print a wrong sum.
 */
import { PRICE_TABLE, PRICES_RETRIEVED } from "../../../../packages/core/src/render/prices.ts";
import type { Tokens } from "../shared/model.ts";

export { PRICES_RETRIEVED };

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Lowercased id → table id, so "GLM-5.3" and "minimax-m3" find their row. */
const BY_LOWER = new Map(Object.keys(PRICE_TABLE).map((id) => [id.toLowerCase(), id]));

/** "zai/glm-5.3[1m]" → "glm-5.3": drop a provider prefix and a context-window suffix. */
export function normalizeModel(model: string): string {
  const bare = model.trim().replace(/\[[^\]]*\]$/, "");
  const slash = bare.lastIndexOf("/");
  return (slash >= 0 ? bare.slice(slash + 1) : bare).toLowerCase();
}

/** The list price of a model in USD per million tokens, or null when the table does not know it. */
export function priceOf(model: string): Price | null {
  const id = BY_LOWER.get(normalizeModel(model));
  if (id === undefined) return null;
  const entry = PRICE_TABLE[id];
  return entry === undefined
    ? null
    : { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite };
}

/** Estimated USD for one model's tokens; null for an unpriced model. */
export function costOf(model: string, tokens: Tokens): number | null {
  const price = priceOf(model);
  if (price === null) return null;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

/** Sum of costs where null means "nothing in here had a price"; a mix sums the priced part. */
export function addCost(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Total estimated cost of some requests: null when none of them was priced. */
export function costOfAll(requests: { model: string; tokens: Tokens; provider?: string }[]): number | null {
  let total: number | null = null;
  for (const request of requests) {
    // a router's own route line repeats a request the transcript already holds: never price it twice
    if (request.provider === "route") continue;
    total = addCost(total, costOf(request.model, request.tokens));
  }
  return total;
}

const PLUGIN_PREFIXES: [string, string][] = [
  ["glm-", "zai"],
  ["kimi-", "kimi"],
  ["deepseek-", "deepseek"],
  ["minimax-", "minimax"],
  ["qwen", "qwen"],
];

/** The provider plugin that serves a model ("zai" for glm-5.3), or null for Anthropic and anything else. */
export function pluginOf(model: string): string | null {
  const id = normalizeModel(model);
  for (const [prefix, plugin] of PLUGIN_PREFIXES) if (id.startsWith(prefix)) return plugin;
  return null;
}

/** The plugin names the dashboard knows, in a stable order (the budget scope choices before any data). */
export const KNOWN_PLUGINS = ["zai", "kimi", "deepseek", "minimax", "qwen"] as const;

/** The cheaper sibling each main model has in the table, for the model advisor. */
const FLASH_OF: Record<string, string> = {
  "glm-5.3": "glm-5.3-flash",
  "deepseek-v4-pro": "deepseek-flash",
  "qwen3.8-max": "qwen3.8-flash",
};

/** The flash-sized model a main model could hand small work to, or null when there is none. */
export function flashOf(model: string): string | null {
  return FLASH_OF[normalizeModel(model)] ?? null;
}

/** True for a model that is itself the small one (flash, haiku, highspeed). */
export function isSmallModel(model: string): boolean {
  const id = normalizeModel(model);
  return /flash|haiku|highspeed/.test(id);
}
