/**
 * Colours and icons by meaning. Components reach colour only through the semantic tokens defined in app.css
 * (success, warning, danger, info, muted, series-1…8), which map onto Catppuccin Mocha in dark mode and Latte
 * in light mode. Status is never colour-alone: every tone travels with an icon or a word.
 */
import type { IconName } from "./icons.ts";

export type Range = "5m" | "1h" | "24h";

export const RANGE_MS: Record<Range, number> = { "5m": 300_000, "1h": 3_600_000, "24h": 86_400_000 };

/** Chart series in order: blue, mauve, green, peach, teal, pink, yellow, lavender. */
export const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
] as const;

/** One colour per token kind, used by the token-flow chart, the drawer and every stacked bar. */
export const TOKEN_KINDS = [
  { key: "input", label: "Input", color: "var(--series-1)" },
  { key: "output", label: "Output", color: "var(--series-2)" },
  { key: "cacheRead", label: "Cache read", color: "var(--series-5)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--series-4)" },
] as const;

/** Latency against the view's p95: under 60% is fine, under 80% is a warning, the rest is slow. */
export function latencyClass(ratio: number): string {
  if (ratio < 0.6) return "var(--success)";
  if (ratio < 0.8) return "var(--warning)";
  return "var(--danger)";
}

export type StatusTone = "ok" | "warn" | "err" | "idle" | "info";

/** Fill colour of a tone (dots, bars, tinted icon backgrounds). */
export const STATUS_COLOR: Record<StatusTone, string> = {
  ok: "var(--success)",
  warn: "var(--warning)",
  err: "var(--danger)",
  idle: "var(--muted)",
  info: "var(--info)",
};

export type EventMeta = { icon: IconName; tone: StatusTone; label: string };

const EVENTS: Record<string, EventMeta> = {
  SessionStart: { icon: "play", tone: "ok", label: "Session started" },
  SessionEnd: { icon: "stop", tone: "idle", label: "Session ended" },
  UserPromptSubmit: { icon: "message", tone: "info", label: "Prompt" },
  PreToolUse: { icon: "wrench", tone: "info", label: "Tool started" },
  PostToolUse: { icon: "check", tone: "ok", label: "Tool finished" },
  PostToolUseFailure: { icon: "close", tone: "err", label: "Tool failed" },
  SubagentStart: { icon: "branch", tone: "info", label: "Subagent started" },
  SubagentStop: { icon: "merge", tone: "idle", label: "Subagent finished" },
  Stop: { icon: "pause", tone: "idle", label: "Turn ended" },
  PreCompact: { icon: "fold", tone: "warn", label: "Compacting" },
  Notification: { icon: "bell", tone: "warn", label: "Notification" },
  route: { icon: "arrows", tone: "info", label: "Routed" },
  Interrupted: { icon: "stop", tone: "idle", label: "Interrupted by you" },
};

/** Icon, tone and plain-language label per hook event kind; unknown kinds keep their raw name. */
export function eventMeta(kind: string): EventMeta {
  return EVENTS[kind] ?? { icon: "dot", tone: "idle", label: kind === "" ? "Event" : kind };
}

/** Provider → series colour, used consistently in charts, badges and the agents tree. */
export const PROVIDER_COLOR: Record<string, string> = {
  Anthropic: "var(--series-4)",
  "Z.ai": "var(--series-1)",
  Moonshot: "var(--series-5)",
  DeepSeek: "var(--series-2)",
  MiniMax: "var(--series-6)",
  Qwen: "var(--series-8)",
  other: "var(--muted)",
  route: "var(--series-1)",
};

export function providerColor(provider: string | null | undefined): string {
  return PROVIDER_COLOR[provider ?? "other"] ?? "var(--muted)";
}
