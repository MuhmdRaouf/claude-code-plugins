// Readers for the loosely typed JSON the engines send: a missing or mistyped field reads as empty, never throws.

export function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The text of a message's text parts (omp and pi split one assistant message into parts). */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts = content.map((part) => asString(asRecord(part).text)).filter((part) => part !== undefined);
  return parts.length === 0 ? "" : parts.join("");
}

/** The first string value in a tool call's arguments: the engine's own summary of what the call is about. */
export function firstStringValue(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const value of Object.values(args)) if (typeof value === "string") return value;
  return undefined;
}
