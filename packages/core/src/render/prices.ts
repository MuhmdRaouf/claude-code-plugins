// The one price table every cost the plugins print comes from: `/<p>:usage`, the job reports, the wait lines and the
// subagent hook. Each entry names the provider's own pricing page and the day it was read; a figure that page did not
// show is marked unverified.

import { usd } from "./format.ts";

/** A model's list price in USD per million tokens. */
interface ModelPrice {
  readonly input: number;
  readonly output: number;
  /** Cached input read (a cache hit). */
  readonly cacheRead: number;
  /** Cache creation or storage; 0 where the provider charges nothing for it. */
  readonly cacheWrite: number;
}

/** One sourced row of the table. */
interface PriceEntry extends ModelPrice {
  /** The provider's pricing page the figures were read from. */
  readonly source: string;
  /** The day (YYYY-MM-DD) they were read. */
  readonly retrieved: string;
  /** False when a figure was inferred rather than seen on the page; `note` says which. */
  readonly verified: boolean;
  readonly note?: string;
}

/** The day the table was last read, printed once by `/<p>:usage`. */
export const PRICES_RETRIEVED = "2026-10-08";

const ZAI = "https://docs.z.ai/guides/overview/pricing";
const KIMI = "https://platform.kimi.ai/docs/pricing/chat";
const DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing";
const MINIMAX = "https://platform.minimax.io/docs/guides/pricing-paygo";
const QWEN = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

/** Every catalog id the five provider plugins ship, at its lowest list tier. */
export const PRICE_TABLE: Readonly<Record<string, PriceEntry>> = {
  "glm-5.3": {
    input: 1.4,
    output: 4.4,
    cacheRead: 0.26,
    cacheWrite: 0,
    source: ZAI,
    retrieved: PRICES_RETRIEVED,
    verified: true,
    note: "cached-input storage is listed as limited-time free",
  },
  "glm-5.3-flash": {
    input: 0.15,
    output: 0.5,
    cacheRead: 0.03,
    cacheWrite: 0,
    source: ZAI,
    retrieved: PRICES_RETRIEVED,
    verified: true,
    note: "cached-input storage is listed as limited-time free",
  },
  "kimi-k3": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3,
    source: KIMI,
    retrieved: PRICES_RETRIEVED,
    verified: true,
    note: "cache write at the default 5-minute lifetime; the 1-hour lifetime is 6.00",
  },
  "kimi-k2.6": {
    input: 0.95,
    output: 4,
    cacheRead: 0.16,
    cacheWrite: 0,
    source: KIMI,
    retrieved: PRICES_RETRIEVED,
    verified: true,
    note: "no cache-write price listed",
  },
  "deepseek-v4-pro": {
    input: 1.32,
    output: 3.96,
    cacheRead: 0.044,
    cacheWrite: 0,
    source: DEEPSEEK,
    retrieved: PRICES_RETRIEVED,
    verified: true,
    note: "peak price; off-peak is half (0.66 / 1.98 / 0.022)",
  },
  "deepseek-flash": {
    input: 0.3,
    output: 1.2,
    cacheRead: 0.006,
    cacheWrite: 0,
    source: DEEPSEEK,
    retrieved: PRICES_RETRIEVED,
    verified: true,
    note: "peak price; off-peak is half (0.15 / 0.60 / 0.003)",
  },
  "MiniMax-M3": {
    input: 0.3,
    output: 1.2,
    cacheRead: 0.06,
    cacheWrite: 0,
    source: MINIMAX,
    retrieved: PRICES_RETRIEVED,
    verified: true,
    note: "up to 512k input; above it 0.60 / 2.40 / 0.12; no cache-write price listed",
  },
  "MiniMax-M2.7-highspeed": {
    input: 0.6,
    output: 2.4,
    cacheRead: 0.06,
    cacheWrite: 0.375,
    source: MINIMAX,
    retrieved: PRICES_RETRIEVED,
    verified: true,
  },
  "qwen3.8-max": {
    input: 2,
    output: 6,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    source: QWEN,
    retrieved: PRICES_RETRIEVED,
    verified: false,
    note: "input and output read on the page; cache rates inferred (10% and 125% of input), the console has the real ones",
  },
  "qwen3.8-flash": {
    input: 0.15,
    output: 0.47,
    cacheRead: 0.015,
    cacheWrite: 0.19,
    source: QWEN,
    retrieved: PRICES_RETRIEVED,
    verified: false,
    note: "input and output read on the page; cache rates inferred (10% and 125% of input), the console has the real ones",
  },
};

/** One model's price, or undefined for a model the table does not know (an env-overridden id). */
export function priceOf(model: string): PriceEntry | undefined {
  return Object.hasOwn(PRICE_TABLE, model) ? PRICE_TABLE[model] : undefined;
}

/** Token counts, as the spool and the job attempts record them. */
export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** What a model's tokens cost at its list price; an unknown model costs nothing rather than the wrong sum. */
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
