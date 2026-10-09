/**
 * What a request costs, from the one price table every plugin in the monorepo shares (packages/core, bundled in
 * at build time). Every figure is an estimate at list price: the offering that served the request — read off its
 * upstream host — picks the sheet, and the conditions the request names (1-hour cache writes, fast mode, geo,
 * service tier, the time of day) shape the sum. A request neither an offering nor a unique model id prices (an
 * env-overridden id, a made-up one) has no price at all — callers show its tokens and say "unpriced" rather than
 * print a wrong sum.
 */
import {
  OFFERINGS,
  offeringOfHost,
  PRICES_RETRIEVED,
  type PriceResult,
  priceRequest,
} from "../../../../packages/core/src/render/prices.ts";
import type { RequestRecord } from "../shared/model.ts";

export { PRICES_RETRIEVED };

/** The parts of a request the price reads: a RequestRecord has all of them, a ledger row the stored ones. */
export type PricedRequest = Pick<RequestRecord, "model" | "ts" | "tokens"> &
  Partial<Pick<RequestRecord, "stopReason" | "upstream" | "cacheWrite1h" | "speed" | "geo" | "serviceTier">>;

/** "zai/glm-5.3[1m]" → "glm-5.3": drop a provider prefix and a context-window suffix. */
export function normalizeModel(model: string): string {
  const bare = model.trim().replace(/\[[^\]]*\]$/, "");
  const slash = bare.lastIndexOf("/");
  return (slash >= 0 ? bare.slice(slash + 1) : bare).toLowerCase();
}

/** The host the model's own provider offering names ("glm-5.3" → "https://api.z.ai"), or null for a
 *  model no plugin offering serves — Anthropic's own and unknown ids stay unnamed, since a claude call
 *  without a recorded upstream went direct and must keep saying so. */
export function offeringHostOf(model: string): string | null {
  const id = normalizeModel(model);
  if (id === "") return null;
  let host: string | null = null;
  for (const offering of OFFERINGS) {
    if (offering.id === "anthropic") continue;
    if (Object.keys(offering.models).some((key) => normalizeModel(key) === id)) {
      if (host !== null) return null; // two offerings serve the same id: neither is the honest answer
      host = `https://${offering.host}`;
    }
  }
  return host;
}

/** Estimated USD for one request at its offering's list price, with every condition that shaped the sum named in
 *  `detail`; null when nothing prices it. The record's 1-hour cache writes bill at the 1-hour rate and the rest
 *  of the writes at the 5-minute one. An upstream the table does not know (a direct call, a router echo) falls
 *  back to the model id alone, priced when exactly one offering names it. A request still streaming (no stop
 *  reason yet, no output) is never priced: its numbers are the opening estimate, not the bill. */
export function requestCost(r: PricedRequest): PriceResult | null {
  // a request still streaming (its stop reason null, no output yet) is never priced: its numbers are
  // the opening estimate. An object that carries no stop reason at all — a ledger row — is not a
  // request in flight and prices as it stands.
  if (r.stopReason === null && r.tokens.output === 0) return null;
  return priceRequest({
    offering: r.upstream === undefined || r.upstream === "" ? null : offeringOfHost(r.upstream),
    model: r.model,
    tokens: {
      input: r.tokens.input,
      output: r.tokens.output,
      cacheRead: r.tokens.cacheRead,
      cacheWrite5m: Math.max(0, r.tokens.cacheWrite - (r.cacheWrite1h ?? 0)),
      cacheWrite1h: r.cacheWrite1h ?? 0,
    },
    ts: r.ts,
    // only the conditions the record names; exactOptionalPropertyTypes forbids a bare `undefined`
    ...(r.speed !== undefined ? { speed: r.speed } : {}),
    ...(r.geo !== undefined ? { geo: r.geo } : {}),
    ...(r.serviceTier !== undefined ? { serviceTier: r.serviceTier } : {}),
  });
}

/** Sum of costs where null means "nothing in here had a price"; a mix sums the priced part. */
export function addCost(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** The three families a session's cost splits into: Claude's models, GLM's, everything else priced. */
export type CostFamily = "claude" | "glm" | "other";

/** Per-family estimated cost; a family nothing priced stays null. The non-null parts of a split over
 *  some requests always add up to `costOfAll` over the same requests. */
export type CostSplit = Record<CostFamily, number | null>;

/** Which family a model id prices under: GLM's (glm-…), Claude's (claude-, opus, sonnet, haiku), else other. */
export function costFamilyOf(model: string): CostFamily {
  const id = normalizeModel(model);
  if (id.startsWith("glm")) return "glm";
  if (id.startsWith("claude") || id.includes("opus") || id.includes("sonnet") || id.includes("haiku")) {
    return "claude";
  }
  return "other";
}

/** The cost of some requests split by model family, for views that show "X Claude / Y GLM": computed
 *  beside `costOfAll` over the very same requests, so the split and the total never disagree. */
export function costByFamily(requests: PricedRequest[]): CostSplit {
  const split: CostSplit = { claude: null, glm: null, other: null };
  for (const request of requests) {
    const cost = requestCost(request);
    if (cost === null) continue;
    const family = costFamilyOf(request.model);
    split[family] = addCost(split[family], cost.usd);
  }
  return split;
}

/** Total estimated cost of some requests: null when none of them was priced. */
export function costOfAll(requests: PricedRequest[]): number | null {
  let total: number | null = null;
  for (const request of requests) {
    const cost = requestCost(request);
    total = addCost(total, cost === null ? null : cost.usd);
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
