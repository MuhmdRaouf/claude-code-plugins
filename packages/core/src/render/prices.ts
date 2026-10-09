// The one price source every cost the plugins print comes from: `/<p>:usage`, the job reports, the wait lines and
// the subagent hook. Prices are per provider OFFERING — one API host and the model sheet behind it — not per
// model: the conditions each pricing page describes (input-length tiers, off-peak windows, fast mode, geo,
// service tier) live here as data, and `priceRequest` is the math that uses them. Each offering names its pricing
// page and the day it was read; a figure that page did not show is marked unverified, or 0 with a note.

import { usd } from "./format.ts";

/** A provider offering: one API host and the models it serves, all prices in USD per million tokens. */
export type OfferingId = "anthropic" | "zai" | "moonshot" | "deepseek" | "minimax" | "qwen";

/** A model's list rates in USD per million tokens. */
export interface Rates {
  readonly input: number;
  readonly output: number;
  /** A cache hit on previously written input. */
  readonly cacheRead: number;
  /** Cache write at the 5-minute lifetime; 0 where the page lists no price. */
  readonly cacheWrite5m: number;
  /** Cache write at the 1-hour lifetime, where the page lists one. */
  readonly cacheWrite1h?: number;
}

/** Rates that replace a model's base once prompt tokens pass `over`. */
export interface Tier {
  /** The prompt-token count (input + cache read + cache write) above which these rates bill. */
  readonly over: number;
  readonly rates: Rates;
}

/** A UTC window that bills at peak: weekdays (0 = Sunday … 6 = Saturday) and the hour range [start, end). */
export interface PeakWindow {
  readonly days: readonly number[];
  readonly start: number;
  readonly end: number;
}

/** What a provider discounts when a request falls outside every peak window. */
export interface OffPeak {
  readonly multiplier: number;
  readonly peak: readonly PeakWindow[];
}

/** Input and output for a request that ran in fast mode; the cache rates derive from fast input. */
export interface FastRates {
  readonly input: number;
  readonly output: number;
}

/** One model's sheet on its offering: the base rates and every condition the pricing page attaches to them. */
export interface ModelSheet {
  readonly base: Rates;
  readonly tiers?: readonly Tier[];
  readonly offPeak?: OffPeak;
  readonly fast?: FastRates;
  /** Multiplier on every rate for the provider's priority service tier. */
  readonly priority?: number;
  /** Multiplier on every rate when the request ran with inference_geo "us". */
  readonly geoUs?: number;
  /** False when a figure was inferred rather than seen on the page; `note` says which. */
  readonly verified: boolean;
  readonly note?: string;
}

/** One offering: its host, where the figures came from, and every model sheet read off that page. */
export interface Offering {
  readonly id: OfferingId;
  /** The API host that serves these models, as `offeringOfHost` matches it. */
  readonly host: string;
  /** The provider's pricing page the figures were read from. */
  readonly source: string;
  /** The day (YYYY-MM-DD) they were read. */
  readonly retrieved: string;
  readonly models: Readonly<Record<string, ModelSheet>>;
}

/** The day the sheets were last read, printed once by `/<p>:usage`. */
export const PRICES_RETRIEVED = "2026-10-08";

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const ZAI = "https://docs.z.ai/guides/overview/pricing";
const KIMI = "https://platform.kimi.ai/docs/pricing/chat";
const DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing";
const MINIMAX = "https://platform.minimax.io/docs/guides/pricing-paygo";
const QWEN = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

/** DeepSeek: peak is 01:00–04:00 and 06:00–10:00 UTC Monday to Friday; everything else bills at half. */
const DEEPSEEK_OFF_PEAK: OffPeak = {
  multiplier: 0.5,
  peak: [
    { days: [1, 2, 3, 4, 5], start: 1, end: 4 },
    { days: [1, 2, 3, 4, 5], start: 6, end: 10 },
  ],
};

const DEEPSEEK_NOTE =
  "peak price; off-peak is half outside 01:00–04:00 and 06:00–10:00 UTC Mon–Fri; Chinese public holidays are " +
  "off-peak there but billed at peak here; cache write not listed";

const QWEN_NOTE =
  "input and output read on the page; cache rates inferred (10% and 125% of input), the console has the real ones";

const ZAI_NOTE = "cache write not listed; cache storage is limited-time free";

/** Every offering the plugins can bill against, international endpoints only. */
export const OFFERINGS: readonly Offering[] = [
  {
    id: "anthropic",
    host: "api.anthropic.com",
    source: ANTHROPIC,
    retrieved: PRICES_RETRIEVED,
    models: {
      "claude-fable-5-1": {
        base: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-fable-5": {
        base: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-opus-5-5": {
        base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
        fast: { input: 8, output: 40 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-opus-5": {
        base: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
        fast: { input: 10, output: 50 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-opus-4-8": {
        base: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
        fast: { input: 10, output: 50 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-opus-4-7": {
        base: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-opus-4-6": {
        base: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-opus-4-5": {
        base: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
        verified: true,
      },
      "claude-sonnet-5-5": {
        base: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-sonnet-5": {
        base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-sonnet-4-6": {
        base: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
        geoUs: 1.1,
        verified: true,
      },
      "claude-sonnet-4-5": {
        base: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
        verified: true,
      },
      "claude-haiku-4-5": {
        base: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
        verified: true,
      },
      "claude-haiku-5-5": {
        base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
        tiers: [
          {
            over: 100_000,
            rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
          },
        ],
        geoUs: 1.1,
        verified: true,
      },
    },
  },
  {
    id: "zai",
    host: "api.z.ai",
    source: ZAI,
    retrieved: PRICES_RETRIEVED,
    models: {
      "glm-5.3": {
        base: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite5m: 0 },
        verified: true,
        note: ZAI_NOTE,
      },
      "glm-5.3-flash": {
        base: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite5m: 0 },
        verified: true,
        note: ZAI_NOTE,
      },
      "glm-5.3-flashx": {
        base: { input: 0.37, output: 1.25, cacheRead: 0.075, cacheWrite5m: 0 },
        verified: true,
        note: ZAI_NOTE,
      },
    },
  },
  {
    id: "moonshot",
    host: "api.moonshot.ai",
    source: KIMI,
    retrieved: PRICES_RETRIEVED,
    models: {
      "kimi-k3": {
        base: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3, cacheWrite1h: 6 },
        verified: true,
        note: "cache write 3.00 is the default 5-minute lifetime; the 1-hour lifetime is 6.00",
      },
      "kimi-k2.6": {
        base: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite5m: 0 },
        verified: true,
        note: "cache write not listed",
      },
    },
  },
  {
    id: "deepseek",
    host: "api.deepseek.com",
    source: DEEPSEEK,
    retrieved: PRICES_RETRIEVED,
    models: {
      "deepseek-flash": {
        base: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite5m: 0 },
        offPeak: DEEPSEEK_OFF_PEAK,
        verified: true,
        note: DEEPSEEK_NOTE,
      },
      "deepseek-v4-pro": {
        base: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite5m: 0 },
        offPeak: DEEPSEEK_OFF_PEAK,
        verified: true,
        note: DEEPSEEK_NOTE,
      },
    },
  },
  {
    id: "minimax",
    host: "api.minimax.io",
    source: MINIMAX,
    retrieved: PRICES_RETRIEVED,
    models: {
      "MiniMax-M3": {
        base: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite5m: 0 },
        tiers: [{ over: 512_000, rates: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite5m: 0 } }],
        priority: 1.5,
        verified: true,
        note:
          "up to 512k prompt tokens; above it 0.60 / 2.40 / 0.12; service_tier priority is ×1.5; " +
          "cache write not listed (passive caching is free)",
      },
      "MiniMax-M2.7": {
        base: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite5m: 0.375 },
        verified: true,
      },
      "MiniMax-M2.7-highspeed": {
        base: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite5m: 0.375 },
        verified: true,
      },
    },
  },
  {
    id: "qwen",
    host: "dashscope-intl.aliyuncs.com",
    source: QWEN,
    retrieved: PRICES_RETRIEVED,
    models: {
      "qwen3.8-max": {
        base: { input: 2, output: 6, cacheRead: 0.2, cacheWrite5m: 2.5 },
        verified: false,
        note: QWEN_NOTE,
      },
      "qwen3.8-flash": {
        base: { input: 0.15, output: 0.47, cacheRead: 0.015, cacheWrite5m: 0.19 },
        verified: false,
        note: QWEN_NOTE,
      },
    },
  },
];

/** "zai/glm-5.3[1m]" → "glm-5.3": drop a provider prefix, a context bracket and a dated snapshot suffix, lowercased. */
function canonicalModelId(model: string): string {
  const bare = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "");
  const slash = bare.lastIndexOf("/");
  const unprefixed = slash >= 0 ? bare.slice(slash + 1) : bare;
  return unprefixed.replace(/[-@]\d{8}$/, "");
}

/** Where a canonical id lives; several offerings could name the same id, so the list may hold more than one. */
interface SheetRef {
  readonly offering: Offering;
  /** The id as its offering's page spells it (the `PRICE_TABLE` key). */
  readonly id: string;
  readonly sheet: ModelSheet;
}

const BY_CANONICAL_ID: Readonly<Map<string, SheetRef[]>> = (() => {
  const index = new Map<string, SheetRef[]>();
  for (const offering of OFFERINGS) {
    for (const [id, sheet] of Object.entries(offering.models)) {
      const key = canonicalModelId(id);
      const refs = index.get(key);
      if (refs === undefined) index.set(key, [{ offering, id, sheet }]);
      else refs.push({ offering, id, sheet });
    }
  }
  return index;
})();

/** The model a request names on an offering; with no offering, a unique id across offerings decides. */
function resolveSheet(offering: OfferingId | null, model: string): SheetRef | null {
  const refs = BY_CANONICAL_ID.get(canonicalModelId(model));
  if (refs === undefined) return null;
  if (offering !== null) {
    for (const ref of refs) if (ref.offering.id === offering) return ref;
    return null;
  }
  return refs.length === 1 ? (refs[0] ?? null) : null;
}

/** The offering that serves a host, given as `https://host/…` or bare `host`; an unknown host gets null. */
export function offeringOfHost(urlOrHost: string): OfferingId | null {
  const trimmed = urlOrHost.trim().toLowerCase();
  let host: string;
  if (trimmed.includes("://")) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  } else {
    host = trimmed.slice(0, trimmed.indexOf("/") < 0 ? undefined : trimmed.indexOf("/"));
    const colon = host.indexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  for (const offering of OFFERINGS) if (host === offering.host) return offering.id;
  return null;
}

/** What a request used, as the spool and the job attempts record them. */
export interface TokenUse {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

/** One request to price: where it ran, what it used, and every condition the provider bills on. */
export interface PriceRequest {
  /** The offering that served the request, or null when only the model id is known. */
  readonly offering: OfferingId | null;
  readonly model: string;
  readonly tokens: TokenUse;
  /** When the request ran, as a Unix epoch ms — off-peak windows are UTC. */
  readonly ts: number;
  /** Fast mode when the provider names it so. */
  readonly speed?: string;
  /** inference_geo; "us" bills Claude 4.6 and later at ×1.1. */
  readonly geo?: string;
  /** The provider's service tier; "priority" bills MiniMax at ×1.5. */
  readonly serviceTier?: string;
}

/** What a request cost and, in short words, every condition that shaped the sum. */
export interface PriceResult {
  readonly usd: number;
  readonly detail: string[];
}

const LABEL: Readonly<Record<OfferingId, string>> = {
  anthropic: "Anthropic list",
  zai: "Z.ai list",
  moonshot: "Moonshot list",
  deepseek: "DeepSeek list",
  minimax: "MiniMax list",
  qwen: "Qwen list",
};

function inPeak(ts: number, peak: readonly PeakWindow[]): boolean {
  const at = new Date(ts);
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return peak.some((window) => window.days.includes(day) && hour >= window.start && hour < window.end);
}

function tierLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1_000}k`;
}

function isFast(speed: string | undefined): boolean {
  return speed !== undefined && speed.trim().toLowerCase() === "fast";
}

/** The tier a request's prompt tokens land it in, or undefined for the base rates. */
function tierOver(sheet: ModelSheet, promptTokens: number): Tier | undefined {
  let tier: Tier | undefined;
  for (const candidate of sheet.tiers ?? []) if (promptTokens > candidate.over) tier = candidate;
  return tier;
}

/** The rates a request bills, before any condition multiplies them. */
interface BilledRates {
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
}

/** The sheet rates as billed; a page with no 1-hour rate bills the 1-hour tokens at the 5-minute one. */
function billedFrom(rates: Rates): BilledRates {
  return {
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cacheRead,
    write5m: rates.cacheWrite5m,
    write1h: rates.cacheWrite1h ?? rates.cacheWrite5m,
  };
}

/** Fast mode's rates: the page prices input/output only, so the cache rates keep their ratios of input. */
function billedFast(fast: FastRates, rates: Rates): BilledRates {
  return {
    input: fast.input,
    output: fast.output,
    cacheRead: rates.input === 0 ? 0 : (fast.input * rates.cacheRead) / rates.input,
    write5m: 1.25 * fast.input,
    write1h: 2 * fast.input,
  };
}

/** Every sheet condition the request trips, as its multiplier and the short words that name it in `detail`. */
function conditionsOf(sheet: ModelSheet, request: PriceRequest): { multiplier: number; label: string }[] {
  const conditions: { multiplier: number; label: string }[] = [];
  if (sheet.priority !== undefined && request.serviceTier?.trim().toLowerCase() === "priority") {
    conditions.push({ multiplier: sheet.priority, label: `priority ×${sheet.priority}` });
  }
  if (sheet.offPeak !== undefined && !inPeak(request.ts, sheet.offPeak.peak)) {
    conditions.push({ multiplier: sheet.offPeak.multiplier, label: `off-peak ×${sheet.offPeak.multiplier}` });
  }
  if (sheet.geoUs !== undefined && request.geo?.trim().toLowerCase() === "us") {
    conditions.push({ multiplier: sheet.geoUs, label: `US geo ×${sheet.geoUs}` });
  }
  return conditions;
}

/** What one request cost at the sheet's rates, with each applied condition named in `detail`; unknown → null. */
export function priceRequest(request: PriceRequest): PriceResult | null {
  const ref = resolveSheet(request.offering, request.model);
  if (ref === null) return null;
  const detail: string[] = [LABEL[ref.offering.id]];

  // Prompt tokens are what the provider tiers on: everything the request put in front of the model.
  const tokens = request.tokens;
  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const tier = tierOver(ref.sheet, promptTokens);
  if (tier !== undefined) detail.push(`tier over ${tierLabel(tier.over)}`);
  const rates = tier === undefined ? ref.sheet.base : tier.rates;

  const fast = ref.sheet.fast !== undefined && isFast(request.speed) ? ref.sheet.fast : undefined;
  if (fast !== undefined) detail.push("fast mode");
  const billed = fast === undefined ? billedFrom(rates) : billedFast(fast, rates);

  for (const condition of conditionsOf(ref.sheet, request)) {
    billed.input *= condition.multiplier;
    billed.output *= condition.multiplier;
    billed.cacheRead *= condition.multiplier;
    billed.write5m *= condition.multiplier;
    billed.write1h *= condition.multiplier;
    detail.push(condition.label);
  }

  const perMillion = (count: number, rate: number): number => (count / 1_000_000) * rate;
  const usdTotal =
    perMillion(tokens.input, billed.input) +
    perMillion(tokens.output, billed.output) +
    perMillion(tokens.cacheRead, billed.cacheRead) +
    perMillion(tokens.cacheWrite5m, billed.write5m) +
    (tokens.cacheWrite1h > 0 ? perMillion(tokens.cacheWrite1h, billed.write1h) : 0);
  if (tokens.cacheWrite1h > 0) detail.push("1 h cache writes");

  return { usd: usdTotal, detail };
}

/** The flat table the five provider plugins price from: every catalog id they ship, at its lowest list tier.
 *  Claude is priced through `priceRequest` alone, so a claude-* id stays unpriced here. */
export const PRICE_TABLE: Readonly<Record<string, PriceEntry>> = Object.fromEntries(
  OFFERINGS.filter((offering) => offering.id !== "anthropic").flatMap((offering) =>
    Object.entries(offering.models).map(([id, sheet]): [string, PriceEntry] => [
      id,
      {
        input: sheet.base.input,
        output: sheet.base.output,
        cacheRead: sheet.base.cacheRead,
        cacheWrite: sheet.base.cacheWrite5m,
        source: offering.source,
        retrieved: offering.retrieved,
        verified: sheet.verified,
        ...(sheet.note === undefined ? {} : { note: sheet.note }),
      },
    ]),
  ),
);

/** One sourced row of the flat table. */
interface PriceEntry {
  readonly input: number;
  readonly output: number;
  /** Cached input read (a cache hit). */
  readonly cacheRead: number;
  /** Cache creation at the base rate; 0 where the provider charges nothing or lists no price. */
  readonly cacheWrite: number;
  /** The provider's pricing page the figures were read from. */
  readonly source: string;
  /** The day (YYYY-MM-DD) they were read. */
  readonly retrieved: string;
  /** False when a figure was inferred rather than seen on the page; `note` says which. */
  readonly verified: boolean;
  readonly note?: string;
}

/** One model's flat-table row, or undefined for a model the table does not know (a claude id, an env override). */
export function priceOf(model: string): PriceEntry | undefined {
  const refs = BY_CANONICAL_ID.get(canonicalModelId(model));
  const ref = refs !== undefined && refs.length === 1 ? refs[0] : undefined;
  if (ref === undefined || ref.offering.id === "anthropic") return undefined;
  return PRICE_TABLE[ref.id];
}

/** Token counts, as the spool and the job attempts record them. */
export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** What a model's tokens cost at its list price; an unknown model costs nothing rather than the wrong sum.
 *  Cache writes bill as 5-minute writes at the base (peak, pre-tier) rates — the flat table has no request to read
 *  conditions off; `priceRequest` is the one that does. */
export function costUsdOf(model: string, tokens: TokenCounts): number {
  const price = priceOf(model);
  if (price === undefined) return 0;
  const perMillion = (count: number, rate: number): number => (count / 1_000_000) * rate;
  return (
    perMillion(tokens.inputTokens, price.input) +
    perMillion(tokens.outputTokens, price.output) +
    perMillion(tokens.cacheReadTokens, price.cacheRead) +
    perMillion(tokens.cacheWriteTokens, price.cacheWrite)
  );
}

/** A cost as the reports print it: `est. $0.0123`, or `unpriced` for a model the table does not know. */
export function estimateText(model: string, tokens: TokenCounts): string {
  return priceOf(model) === undefined ? "unpriced" : `est. ${usd(costUsdOf(model, tokens))}`;
}
