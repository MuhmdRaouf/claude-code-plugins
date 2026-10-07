/**
 * Byte-offset tailing for jsonl files: read only what appeared since last poll, buffer a partial trailing line
 * until it completes, restart when the file shrinks (rotation/truncation), and never read more than the initial
 * cap — a multi-gigabyte transcript must not be loaded whole on first sight.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const TAIL_CAP_BYTES = 50 * 1024 * 1024;

export type TailState = {
  path: string;
  offset: number;
  partial: string;
  /** true right after an opening skip: the first chunk starts mid-file and must drop to the next line. */
  align: boolean;
};

export type TailResult = {
  lines: string[];
  restarted: boolean;
};

/** Pure buffer math: carry + chunk → complete lines and the new carry. */
export function splitLines(carry: string, chunk: string): { lines: string[]; partial: string } {
  const text = carry + chunk;
  const parts = text.split("\n");
  const partial = parts.pop() ?? "";
  const lines = parts.filter((line) => line.trim() !== "");
  return { lines, partial };
}

/** Open a tail at the end of the file's last `cap` bytes (aligned to the next line boundary). */
export function openTail(path: string, cap = TAIL_CAP_BYTES): TailState {
  try {
    const size = statSync(path).size;
    if (size <= cap) return { path, offset: 0, partial: "", align: false };
    return { path, offset: size - cap, partial: "", align: true };
  } catch {
    return { path, offset: 0, partial: "", align: false };
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Read everything new; empty result when the file is quiet, gone, or unreadable. */
export function tailFile(state: TailState): TailResult {
  const size = sizeOf(state.path);
  if (size === null || size === state.offset) return { lines: [], restarted: false };
  let restarted = false;
  if (size < state.offset) {
    // truncated or replaced: start over and take the whole new file
    state.offset = 0;
    state.partial = "";
    state.align = false;
    restarted = true;
  }
  let fd: number;
  try {
    fd = openSync(state.path, "r");
  } catch {
    return { lines: [], restarted };
  }
  try {
    const length = size - state.offset;
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, state.offset);
    state.offset += read;
    let chunk = buffer.toString("utf8", 0, read);
    if (state.align) {
      const firstNewline = chunk.indexOf("\n");
      state.align = false;
      chunk = firstNewline >= 0 ? chunk.slice(firstNewline + 1) : "";
    }
    const { lines, partial } = splitLines(state.partial, chunk);
    state.partial = partial;
    return { lines, restarted };
  } catch {
    return { lines: [], restarted: true };
  } finally {
    closeSync(fd);
  }
}
