/** Input keys that best say what a tool call is about, in order of preference (Claude Code's built-in tools). */
const SALIENT_KEYS = [
  "file_path",
  "notebook_path",
  "command",
  "pattern",
  "path",
  "url",
  "query",
  "description",
  "prompt",
  "skill",
] as const;

const MAX_SUMMARY_CHARS = 80;

/** One short line describing a tool call's input, for progress displays. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  return oneLine(salientValue(input) ?? compactJson(input));
}

function salientValue(input: object): string | undefined {
  for (const key of SALIENT_KEYS) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value === "string") return value;
  }
  return undefined;
}

function compactJson(input: object): string {
  return Object.keys(input).length === 0 ? "" : JSON.stringify(input);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_SUMMARY_CHARS ? flat : `${flat.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}
