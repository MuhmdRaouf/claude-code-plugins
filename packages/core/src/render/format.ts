/** Small text formatters shared by the renderers: plain ASCII layout, no colour, no ISO timestamps. */
import type { Attempt, Job, WorkerOutcome } from "../domain/job.ts";
import type { Provider } from "../domain/provider.ts";
import type { Progress } from "../domain/worker-events.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse age: now, 5m, 3h, 2d. */
function age(fromIso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(fromIso));
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** The age as prose: "just now" or "5m ago / 3h ago / 2d ago". */
export function ago(fromIso: string, now: number): string {
  const text = age(fromIso, now);
  return text === "now" ? "just now" : `${text} ago`;
}

/** 1.2s, 42s, 3m05s, 1h02m. */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 310, 4.2k, 1.2M. */
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function usd(amount: number): string {
  return `$${amount.toFixed(amount >= 1 ? 2 : 4)}`;
}

export function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

export function plural(n: number, noun: string, nouns = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : nouns}`;
}

/** Whitespace collapsed to single spaces, cut to max characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Columns padded to their widest cell, two spaces apart; the last column is not padded. */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length);
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

export function modelId(provider: Provider, job: Job): string {
  return provider.catalog[job.brief.model].id;
}

export function lastAttempt(job: Job): Attempt | undefined {
  return job.attempts.at(-1);
}

export function verdictOf(job: Job): string {
  return lastAttempt(job)?.verdict ?? "no verdict";
}

/** The worker's outcome when it did not simply complete. */
export function outcomeText(outcome: WorkerOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "api_error":
      return `${outcome.quota ? "out of balance or quota" : "API error"}${outcome.status === undefined ? "" : ` (${outcome.status})`}: ${oneLine(outcome.message, 200)}`;
    case "crashed": {
      const how = outcome.signal === null ? `exit ${outcome.exitCode ?? "?"}` : `signal ${outcome.signal}`;
      const tail = oneLine(outcome.stderrTail, 200);
      return `crashed (${how})${tail === "" ? "" : `: ${tail}`}`;
    }
    case "timeout":
      return "timed out";
    case "stopped":
      return "stopped on request";
  }
}

/** One line of live progress: what the worker is doing, tool calls, rate limiting. */
export function progressText(progress: Progress): string {
  const doing =
    progress.phase === "tool" && progress.lastTool !== undefined
      ? `tool ${progress.lastTool}`
      : progress.phase.replace("_", " ");
  const tools =
    progress.toolCalls === 0
      ? []
      : [
          `${plural(progress.toolCalls, "tool call")}${progress.toolErrors === 0 ? "" : ` (${progress.toolErrors} failed)`}`,
        ];
  const limited =
    progress.rateLimitRetries === 0
      ? []
      : [plural(progress.rateLimitRetries, "rate-limit retry", "rate-limit retries")];
  return [doing, ...tools, ...limited].join(" · ");
}
