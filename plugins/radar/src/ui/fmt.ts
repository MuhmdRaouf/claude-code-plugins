/**
 * Formatting helpers, all pure and locale-stable so tests (and the mono tabular-nums typography) see exact
 * strings. Dashes — never blanks — for "no data", so columns stay aligned.
 */

import { OUTSIDE_SESSION } from "../shared/model.ts";

/** The note every cost estimate carries: what is priced, on what terms, and what only counts tokens. */
export const ESTIMATE_NOTE =
  "Estimates at API list price from the shared price table; cache reads and writes priced at their own rates. Models it does not know show tokens only. A Claude subscription may cover Claude usage; these are API list prices.";

/** A request's cost line: the sum, then the conditions that shaped it ("$0.0123 · Anthropic list · 1 h cache
 *  writes"); a request nothing prices reads "tokens only (no price for this model)". */
export function costDetailText(cost: { usd: number; detail: string[] } | null): string {
  if (cost === null) return "tokens only (no price for this model)";
  return [fmtUsd(cost.usd), ...cost.detail].join(" · ");
}

/** "est. $1.23", or "unpriced" when nothing in it has a price. */
export function costText(cost: number | null | undefined): string {
  return cost === null || cost === undefined ? "unpriced" : `est. ${fmtUsd(cost)}`;
}

/** The name a person recognises a session by: its project folder, else the first 8 characters of its id. */
export function sessionName(item: { id: string; project: string | null }): string {
  if (item.id === OUTSIDE_SESSION) return "Outside a session";
  return item.project ?? item.id.slice(0, 8);
}

/** Hostname of an upstream URL, or the raw string when it does not parse. */
export function hostOf(upstream: string): string {
  if (upstream === "") return "–";
  try {
    return new URL(upstream).host;
  } catch {
    return upstream;
  }
}

/** 731 → "731", 1234 → "1.2k", 1_234_567 → "1.23M", 8_100_000_000 → "8.10B"; a dash for no count. */
export function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "–";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${trim(value / 1000)}k`;
  if (value < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}

function trim(value: number): string {
  const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return rounded.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

/** 12345 → "12,345". */
export function fmtNum(value: number): string {
  const whole = Math.round(value).toString();
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** null → "–", 812 → "812ms", 6300 → "6.3s", 154_000 → "2m34s", 7_200_000 → "2h00m". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${trim(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds === 60 ? `${minutes + 1}m00s` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return minutes === 60 ? `${hours + 1}h00m` : `${hours}h${String(minutes).padStart(2, "0")}m`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Local HH:MM:SS. */
export function fmtClock(ts: number): string {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Local HH:MM for a day-old timestamp; HH:MM:SS for today. */
export function fmtTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? fmtClock(ts) : `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "7s ago", "3m ago", "2h ago", "4d ago". */
export function fmtAgo(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  if (delta < 1000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** Uptime like "12s", "3m", "2h05m". */
export function fmtUptime(startedAt: number, now: number): string {
  return fmtDuration(Math.max(0, now - startedAt));
}

/** A chart's bucket width in words: "5 s", "1 min", "3 h", "1 d" — the "per bar" phrase under a chart. */
export function bucketWord(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

/** 0.842 → "84%", 0.042 → "4.2%", 0 → "0%". */
export function fmtPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "–";
  const pct = ratio * 100;
  if (pct === 0 || pct >= 10) return `${Math.round(pct)}%`;
  return `${trim(pct)}%`;
}

/** 1 → "1 request", 1200 → "1,200 requests" (regular plurals only). */
export function fmtCount(value: number, noun: string): string {
  return `${fmtNum(value)} ${noun}${Math.round(value) === 1 ? "" : "s"}`;
}

/** "$4.20", "$1,234"; zero shows as change and anything under a cent as "<$0.01" — never "$0.0000". */
export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return "<$0.01";
  if (Math.abs(value) < 1000) return `$${value.toFixed(2)}`;
  return `$${fmtNum(value)}`;
}

/** 312 → "312 B", 49_152 → "48 kB", 3_221_225 → "3.1 MB", 1_100_000_000 → "1.02 GB"; a dash for no size. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "–";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${trim(bytes / 1000)} kB`;
  if (bytes < 1_000_000_000) return `${trim(bytes / 1_000_000)} MB`;
  return `${trim(bytes / 1_000_000_000)} GB`;
}

/** A path shown from the home directory; one implementation shared with the server (shared/repo.ts). */
export { homeShort } from "../shared/repo.ts";
