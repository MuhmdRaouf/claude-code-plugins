/** pi's wire is one JSON object per line, each `{type, ...}`; unknown types still arrive (its event stream grows
 *  release by release), so the decoder accepts any object with a string `type` and leaves the rest of the work to the
 *  fold, which ignores what it does not know. There is no chunked framing (that was omp's `rpc_chunk`): every line
 *  either parses as a frame or is stray output the caller logs and skips. */

/** The longest stdout line pi may write (spawn's maxLineBytes): its `agent_end` frames carry the whole session, so a
 *  long one can pass the 1 MiB default while still being a frame worth reading, not a runaway. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Any frame pi sends or the worker commands: the known shapes stay untyped here (see messages.ts for why). */
export type Frame = { readonly type: string } & Readonly<Record<string, unknown>>;

export type Decoded =
  /** `text` is the frame's exact JSON text, for the attempt log. */
  | { readonly kind: "frame"; readonly frame: Frame; readonly text: string }
  /** A blank line. */
  | { readonly kind: "partial" }
  /** A line that is not a frame (stray output); callers log and skip it. */
  | { readonly kind: "malformed"; readonly line: string; readonly reason: string };

export function createFrameDecoder(): { push(raw: string): Decoded } {
  return {
    push(raw) {
      // pi tolerates a trailing CR, so its RPC peer must too (checked against pi 1.0.4).
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") return { kind: "partial" };
      const frame = parseFrame(line);
      return typeof frame === "string"
        ? { kind: "malformed", line, reason: frame }
        : { kind: "frame", frame, text: line };
    },
  };
}

function parseFrame(text: string): Frame | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  return isFrame(value) ? value : "not an RPC frame";
}

function isFrame(value: unknown): value is Frame {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
