/** Every model family the dashboards colour distinctly, in the order the rules below try them. */
const FAMILIES = ["opus", "sonnet", "haiku", "glm", "kimi", "deepseek", "minimax", "qwen"] as const;

export type ModelKey = (typeof FAMILIES)[number] | "glm-flash" | "other";

/**
 * Map a model name ("Claude Opus 4.6", "glm-5.3-flash", "Kimi-K2-Thinking", …) onto its colour key — the
 * `--model-<key>` custom properties theme.css defines per theme. Matching is a case-insensitive substring
 * test; "glm" containing "flash" is its own family, and anything unknown falls back to "other".
 */
export function modelKey(model: string): ModelKey {
  const s = model.toLowerCase();
  if (s.includes("glm")) return s.includes("flash") ? "glm-flash" : "glm";
  for (const family of FAMILIES) {
    if (family === "glm") continue;
    if (s.includes(family)) return family;
  }
  if (s.includes("moonshot")) return "kimi";
  return "other";
}

/** The CSS colour of `model`'s family, as a var() reference a dot, chip, series or strip can set directly. */
export function modelColor(model: string): string {
  return `var(--model-${modelKey(model)})`;
}
