/**
 * Model ids map to a provider by prefix; upstream base URLs show as a host. Both are display concerns that the
 * ingest layer should not have to know, so they live here as pure functions.
 */

export function providerOf(model: string | undefined | null): string {
  const id = (model ?? "").toLowerCase();
  if (id.startsWith("claude-")) return "Anthropic";
  if (id.startsWith("glm-")) return "Z.ai";
  if (id.startsWith("kimi-")) return "Moonshot";
  if (id.startsWith("deepseek-")) return "DeepSeek";
  if (id.startsWith("minimax-")) return "MiniMax";
  if (id.startsWith("qwen") || id.startsWith("qwq")) return "Qwen";
  return "other";
}

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export function upstreamHost(url: string | undefined | null): string {
  const value = url ?? "";
  if (value === "") return "not recorded";
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

const PLUGIN_DISPLAY: Record<string, string> = {
  zai: "Z.ai",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  qwen: "Qwen",
};

/** A provider plugin's display name ("zai" → "Z.ai"); unknown names show as they are. */
export function pluginLabel(plugin: string): string {
  return PLUGIN_DISPLAY[plugin] ?? plugin;
}

/** A budget scope as people read it: "total" → "Total", "provider:zai" → "Z.ai". */
export function scopeLabel(scope: string): string {
  if (scope === "total") return "Total";
  return pluginLabel(scope.startsWith("provider:") ? scope.slice("provider:".length) : scope);
}
