/**
 * Byte-offset tailing for jsonl files: read only what appeared since last poll, buffer a partial trailing line
 * until it completes, restart when the file shrinks (rotation/truncation), and take even a first sighting in
 * bounded chunks — a multi-gigabyte transcript is streamed from its first byte, never loaded whole and never
 * skipped past.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** How many bytes one read may take: a large first catch-up walks a file a chunk per poll, yielding
 *  between the lines, so the event loop keeps answering while the backlog drains. */
export const TAIL_CHUNK_BYTES = 4 * 1024 * 1024;

export type TailState = {
  path: string;
  offset: number;
  partial: string;
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

/** Open a tail at the file's first byte: a big backlog is streamed chunk by chunk, never skipped. */
export function openTail(path: string): TailState {
  return { path, offset: 0, partial: "" };
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Read everything new, up to one chunk of it; empty result when the file is quiet, gone, or unreadable. */
export function tailFile(state: TailState, chunk = TAIL_CHUNK_BYTES): TailResult {
  const size = sizeOf(state.path);
  if (size === null || size === state.offset) return { lines: [], restarted: false };
  let restarted = false;
  if (size < state.offset) {
    // truncated or replaced: start over and take the whole new file
    state.offset = 0;
    state.partial = "";
    restarted = true;
  }
  let fd: number;
  try {
    fd = openSync(state.path, "r");
  } catch {
    return { lines: [], restarted };
  }
  try {
    const length = Math.min(size - state.offset, chunk);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, state.offset);
    state.offset += read;
    const { lines, partial } = splitLines(state.partial, buffer.toString("utf8", 0, read));
    state.partial = partial;
    return { lines, restarted };
  } catch {
    return { lines: [], restarted: true };
  } finally {
    closeSync(fd);
  }
}
