// How a worker that cannot enforce a JSON schema itself (omp, pi, opencode) still returns a checked report: the
// contract goes into the prompt in words, the report is read out of the final message, and a report that does not
// parse or does not check is sent back for correction a bounded number of times. Claude Code enforces the schema
// natively and needs none of this.

/** How many more turns a report that fails its check gets; the session is kept, so each fix lands in context. */
export const MAX_REPORT_CORRECTIONS = 2;

/** The prompt with the report contract appended in words. */
export function reportInstructions(prompt: string, jsonSchema: unknown): string {
  return [
    prompt,
    "",
    "## Final report",
    "",
    "Your final message must contain only the report as one JSON object, and nothing else.",
    "The report must satisfy this JSON schema:",
    "",
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
  ].join("\n");
}

/** The JSON object the final message carries: the whole text, a fenced block, or the outermost braces; null when
 *  none of those is an object (an array or a scalar does not count). */
export function extractReport(text: string): unknown {
  const direct = asObject(text);
  if (direct !== undefined) return direct;
  const fenced = /```[a-z]*\s*([\s\S]*?)\s*```/.exec(text)?.[1] ?? "";
  const inFence = asObject(fenced);
  if (inFence !== undefined) return inFence;
  const braces = /\{[\s\S]*\}/.exec(text)?.[0];
  return braces === undefined ? null : (asObject(braces) ?? null);
}

/** The turn that asks for a corrected report. */
export function correctionPrompt(problems: readonly string[]): string {
  return `Your report was invalid: ${problems.join("; ")}. Reply with only the corrected JSON object.`;
}

function asObject(candidate: string): unknown {
  try {
    const value: unknown = JSON.parse(candidate);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
