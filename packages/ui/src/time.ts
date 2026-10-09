/** A timestamp as an ISO string or epoch ms; null or empty when unknown. */
export type Stamp = string | number | null | undefined;

/** Epoch ms of a stamp, or null when it is missing or does not parse. */
export function stampMs(ts: Stamp): number | null {
  if (ts === null || ts === undefined || ts === "") return null;
  const ms = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" relative to `now`; "—" when the stamp is unknown. */
export function timeAgo(ts: Stamp, now: number): string {
  const ms = stampMs(ts);
  if (ms === null) return "—";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
