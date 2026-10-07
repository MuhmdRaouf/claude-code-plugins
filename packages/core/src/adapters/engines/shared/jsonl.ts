/** The line as a JSON object, or undefined for anything else: blank, unparseable, an array or a scalar. */
export function parseJsonLine(line: string): Readonly<Record<string, unknown>> | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
