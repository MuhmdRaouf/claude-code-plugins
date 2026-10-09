/**
 * One time range for the whole dashboard: the presets the picker offers, the pure resolve that turns a range
 * into concrete { from, to } epochs, the URL-hash codec, and the bucket plan a chart (or the history route)
 * needs to draw a span as bars. Shared by server and UI, and locale-stable on purpose — the helpers build
 * their strings by hand so tests and the dashboard see exactly the same words in every environment.
 */

export type Preset = "5m" | "15m" | "1h" | "6h" | "24h" | "7d" | "30d" | "all";

/**
 * The range as the dashboard holds it: a preset (with `to: null` meaning "until now", following the clock)
 * or a custom span (`preset: null`; `to: null` there also reads as now). `from` only carries meaning for a
 * custom range; presets derive it from `now` at resolve time.
 */
export type TimeRange = { preset: Preset | null; from: number; to: number | null };

export type PresetEntry = {
  key: Preset;
  label: string;
  /** How far back the preset reaches; null = all. */
  ms: number | null;
};

/** The picker's presets in display order. */
export const PRESETS: readonly PresetEntry[] = [
  { key: "5m", label: "Last 5 minutes", ms: 5 * 60_000 },
  { key: "15m", label: "Last 15 minutes", ms: 15 * 60_000 },
  { key: "1h", label: "Last 1 hour", ms: 3_600_000 },
  { key: "6h", label: "Last 6 hours", ms: 6 * 3_600_000 },
  { key: "24h", label: "Last 24 hours", ms: 24 * 3_600_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { key: "all", label: "All time", ms: null },
];

/** The range everything falls back to: last 1 hour, ending now. */
export const DEFAULT_RANGE: TimeRange = { preset: "1h", from: 0, to: null };

/** Concrete epochs a chart or query needs; `from` inclusive, `to` inclusive. */
export function resolveRange(range: TimeRange, now: number, oldest?: number): { from: number; to: number } {
  if (range.preset === null) return { from: range.from, to: range.to ?? now };
  const preset = PRESETS.find((entry) => entry.key === range.preset);
  if (preset === undefined || preset.ms === null) return { from: oldest ?? 0, to: now };
  return { from: now - preset.ms, to: now };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** "6 Oct 14:00"; the year joins in only when it is not the current one. */
export function stampOf(ts: number, year: number): string {
  const date = new Date(ts);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()] ?? ""}`;
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return date.getFullYear() === year ? `${day} ${time}` : `${day} ${date.getFullYear()} ${time}`;
}

/** The range in words: a preset's label, or both ends as "6 Oct 14:00 – 6 Oct 18:30" (en-GB, 24 h). */
export function rangeLabel(range: TimeRange, now: number): string {
  if (range.preset !== null) {
    return PRESETS.find((entry) => entry.key === range.preset)?.label ?? "All time";
  }
  const year = new Date(now).getFullYear();
  const from = stampOf(range.from, year);
  const to = range.to === null ? "now" : stampOf(range.to, year);
  return `${from} – ${to}`;
}

/** A finite number from a hash value, or null for anything else (missing, empty, "abc"). */
function numOf(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read the range out of the hash's params: `range=1h`, or a custom `from=<ms>&to=<ms>` (`to` = now when
 *  absent). Anything missing or malformed falls back to the default 1h. */
export function parseRangeHash(params: URLSearchParams): TimeRange {
  const preset = PRESETS.find((entry) => entry.key === params.get("range"));
  if (preset !== undefined) return { preset: preset.key, from: 0, to: null };
  const from = numOf(params.get("from"));
  if (from === null) return { ...DEFAULT_RANGE };
  return { preset: null, from, to: numOf(params.get("to")) };
}

/** The hash params for a range: `range=1h` for a preset, `from=<ms>` plus `to=<ms>` for a custom one
 *  (`to` omitted while it means now). */
export function rangeToHash(range: TimeRange): string {
  if (range.preset !== null) return `range=${range.preset}`;
  return range.to === null ? `from=${range.from}` : `from=${range.from}&to=${range.to}`;
}

/** Readable bucket widths, in ms, smallest to largest: 1 s, 5 s, 15 s, 30 s, 1 min, 5 min, 15 min, 30 min,
 *  1 h, 3 h, 6 h, 12 h, 1 d. */
export const BUCKET_STEPS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000,
  43_200_000, 86_400_000,
] as const;

/** A chart never draws more bars than this. */
export const MAX_BUCKETS = 240;

/** The bars a chart draws over [from, to]: the smallest readable step that fits `target` of them, then
 *  however many of those steps the span holds, capped at MAX_BUCKETS. */
export function bucketPlan(from: number, to: number, target = 60): { bucketMs: number; buckets: number } {
  const need = Math.max(0, to - from) / target;
  const last = BUCKET_STEPS.at(-1) ?? 86_400_000;
  const bucketMs = BUCKET_STEPS.find((step) => step >= need) ?? last;
  return { bucketMs, buckets: Math.min(MAX_BUCKETS, Math.ceil(Math.max(0, to - from) / bucketMs)) };
}
