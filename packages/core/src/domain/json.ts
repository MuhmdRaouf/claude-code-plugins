import type { z } from "zod";

/** `text` as JSON matching `schema`, or undefined when it does not parse or does not match. */
export function parseJson<T>(text: string, schema: z.ZodType<T>): T | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const checked = schema.safeParse(value);
  return checked.success ? checked.data : undefined;
}
