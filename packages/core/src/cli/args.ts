import { parseArgs } from "node:util";
import { err, ok, type Result } from "../domain/result.ts";
import type { OptionSpec } from "./command.ts";

interface ParsedArgs {
  readonly values: Readonly<Record<string, unknown>>;
  readonly positionals: readonly string[];
}

/** Strict flags (unknown ones are an error), any number of positionals. The error is node's first sentence. */
export function parse(
  argv: readonly string[],
  options: Readonly<Record<string, OptionSpec>>,
): Result<ParsedArgs, string> {
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: { ...options },
      strict: true,
      allowPositionals: true,
    });
    return ok({ values: parsed.values, positionals: parsed.positionals });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message.split(". ")[0] ?? message);
  }
}
