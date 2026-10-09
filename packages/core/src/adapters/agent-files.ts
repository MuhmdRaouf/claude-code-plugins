// An agent file's `model:` line: what setup rewrites so `/model`-less dispatch picks the provider's model, and what
// remove and the router's uninstall cleanup put back. Atomic writes: a hook killed mid-write never leaves a truncated
// agent file.
import { readFileSync } from "node:fs";
import { err, ok, type Result } from "../domain/result.ts";
import { writeFileAtomicSync } from "./fs-files.ts";

const MODEL_LINE = /^model:.*$/m;

/** The file's first `model:` value; null when it has no such line; undefined when the file cannot be read. */
export function readModelLine(file: string): string | null | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const match = /^model:[ \t]*(.*)$/m.exec(text);
  return match === null ? null : (match[1] ?? "").trim();
}

/** Sets the first `model:` line to `model`, or takes it out for null. ok says whether the file changed. A file with no
 *  `model:` line gets none added: the frontmatter is the plugin's, only that one line is setup's. */
export function writeModelLine(file: string, model: string | null): Result<boolean, string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return err(`${file}: not found`);
  }
  if (!MODEL_LINE.test(text)) return model === null ? ok(false) : err(`${file}: no model: line`);
  const next =
    model === null ? text.replace(/^model:.*\r?\n/m, "") : text.replace(MODEL_LINE, `model: ${model}`);
  if (next !== text) writeFileAtomicSync(file, next, { mode: "preserve" });
  return ok(next !== text);
}
