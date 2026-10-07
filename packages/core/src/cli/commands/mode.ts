import type { Mode } from "../../domain/brief.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import type { Invocation } from "../command.ts";

const MODES: readonly Mode[] = ["edit", "exec", "readonly"];

function isMode(text: string): text is Mode {
  return MODES.some((mode) => mode === text);
}

/** --mode, when given, must name a mode. */
export function modeOption(call: Invocation): Result<Mode | undefined, string> {
  const text = call.text("mode");
  if (text === undefined) return ok(undefined);
  return isMode(text) ? ok(text) : err("--mode must be edit, exec or readonly");
}
