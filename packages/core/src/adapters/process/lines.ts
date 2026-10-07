// Stream plumbing for child processes: a byte stream cut into lines, and the queue that turns stream callbacks into an
// async iterable a consumer drains at its own pace.
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** The default line budget: one MiB, omp's longest single frame. */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

/** Calls `onLine` per line (`complete` unless it is the unterminated last one) and `onEnd` once, at EOF or when the
 *  stream is destroyed. A line that passes `maxLineBytes` with no newline is dropped rather than buffered: the stream
 *  is destroyed and `onOverflow` fired. */
export function eachLine(
  stream: Readable,
  onLine: (line: string, complete: boolean) => void,
  onEnd: () => void,
  onOverflow?: () => void,
  maxLineBytes: number = DEFAULT_MAX_LINE_BYTES,
): void {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let partialBytes = 0;
  let ended = false;
  const end = (flush: boolean): void => {
    if (ended) return;
    ended = true;
    const rest = flush ? partial + decoder.end() : "";
    partial = "";
    partialBytes = 0;
    if (rest !== "") onLine(rest, false);
    onEnd();
  };
  stream.on("data", (chunk: Buffer) => {
    if (ended) return;
    partialBytes += chunk.byteLength;
    const parts = (partial + decoder.write(chunk)).split("\n");
    partial = parts.pop() ?? "";
    if (parts.length > 0) partialBytes = Buffer.byteLength(partial);
    for (const line of parts) onLine(line, true);
    if (partialBytes > maxLineBytes) {
      end(false);
      onOverflow?.();
      stream.destroy();
    }
  });
  stream.on("end", () => end(true));
  stream.on("close", () => end(true));
}

/** Unbounded single-consumer queue bridging stream callbacks to an async iterable. Items are held until read, so a
 *  consumer that stops iterating lets memory grow without bound — keep draining until `close` ends the stream. */
export interface Queue<T> {
  push(item: T): void;
  close(): void;
  readonly items: AsyncIterable<T>;
}

/** Consumed items are compacted away in batches, so a long run does not keep its whole history in memory. */
const COMPACT_AFTER = 1024;

export function createQueue<T>(): Queue<T> {
  let buffer: T[] = [];
  let head = 0;
  let closed = false;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    wake?.();
    wake = undefined;
  };

  const take = (): T => {
    const item = buffer[head] as T;
    head += 1;
    if (head >= COMPACT_AFTER) {
      buffer = buffer.slice(head);
      head = 0;
    }
    return item;
  };

  async function* items(): AsyncGenerator<T> {
    for (;;) {
      if (head < buffer.length) yield take();
      else if (closed) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  return {
    push(item) {
      if (closed) return;
      buffer.push(item);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    items: { [Symbol.asyncIterator]: items },
  };
}
