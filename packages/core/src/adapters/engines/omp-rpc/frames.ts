/**
 * omp's RPC framing (protocol v1 and v2). Every frame is one JSON object per line. Under v2 a frame over
 * MAX_FRAME_BYTES arrives as a run of `rpc_chunk` lines carrying base64 slices of its UTF-8 bytes; the chunks have no
 * `id`, so correlation happens on the reassembled frame. The rules mirror omp 18.6.1's own decoder.
 */

/** A decoded frame: an object with a string `type`, otherwise opaque here. */
export type Frame = { readonly type: string } & Readonly<Record<string, unknown>>;

/** Lines up to this many bytes (newline included) travel as one frame. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** omp refuses to reassemble beyond this. */
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** omp's slice size for `rpc_chunk` data. */
const CHUNK_BYTES = 256 * 1024;
/** omp's own decoder limits: ids and chunk counts it refuses outright. */
const MAX_CHUNK_ID_CHARS = 128;
const MAX_CHUNKS = 256;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type Decoded =
  /** `text` is the frame's exact JSON text (the reassembled bytes for a chunked frame). */
  | { readonly kind: "frame"; readonly frame: Frame; readonly text: string }
  /** A blank line, or a chunk of a frame still being reassembled. */
  | { readonly kind: "partial" }
  /** A line that is not a frame (stray output); callers log and skip it. */
  | { readonly kind: "malformed"; readonly line: string; readonly reason: string }
  /** A broken chunk sequence: a frame was lost, so the stream can no longer be trusted. */
  | { readonly kind: "error"; readonly reason: string };

interface FrameDecoder {
  push(line: string): Decoded;
  /**
   * Marks protocol 2 as negotiated: `rpc_chunk` lines become legal, and `maxFrameBytes` (from the peer's ready frame)
   * sets the size a frame must exceed to arrive chunked. A peer that does not send one keeps MAX_FRAME_BYTES.
   */
  negotiated(maxFrameBytes?: number): void;
}

interface Sequence {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly chunks: Buffer[];
  received: number;
}

export function createFrameDecoder(): FrameDecoder {
  let sequence: Sequence | undefined;
  let chunked = false;
  let minChunkedBytes = MAX_FRAME_BYTES;

  const fail = (reason: string): Decoded => {
    sequence = undefined;
    return { kind: "error", reason };
  };

  const chunk = (frame: Frame): Decoded => {
    if (!chunked) return fail("rpc chunk before protocol negotiation");
    const meta = chunkMeta(frame, minChunkedBytes);
    if (typeof meta === "string") return fail(meta);
    if (sequence === undefined && meta.index !== 0) return fail("rpc chunk sequence must start at index 0");
    sequence ??= {
      chunkId: meta.chunkId,
      count: meta.count,
      byteLength: meta.byteLength,
      chunks: [],
      received: 0,
    };
    const problem = append(sequence, meta);
    if (problem !== undefined) return fail(problem);
    if (sequence.chunks.length < sequence.count) return { kind: "partial" };
    const done = sequence;
    sequence = undefined;
    return finishSequence(done);
  };

  return {
    push(raw) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") return { kind: "partial" };
      const frame = parseFrame(line);
      if (typeof frame === "string") return { kind: "malformed", line, reason: frame };
      if (frame.type === "rpc_chunk") return chunk(frame);
      if (sequence !== undefined) return fail("rpc chunk sequence interrupted");
      return { kind: "frame", frame, text: line };
    },
    negotiated(maxFrameBytes) {
      chunked = true;
      if (typeof maxFrameBytes === "number" && Number.isSafeInteger(maxFrameBytes) && maxFrameBytes > 0)
        minChunkedBytes = maxFrameBytes;
    },
  };
}

/** Splits a frame's JSON text into lines the way omp does: one line when it fits, `rpc_chunk`s otherwise. */
export function encodeChunks(text: string, chunkId: string): string[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength + 1 <= MAX_FRAME_BYTES) return [text];
  const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  return Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
    }),
  );
}

/** Adds a chunk to its sequence, or says why it does not belong there. */
function append(at: Sequence, meta: ChunkMeta): string | undefined {
  const matches =
    at.chunkId === meta.chunkId &&
    at.count === meta.count &&
    at.byteLength === meta.byteLength &&
    at.chunks.length === meta.index;
  if (!matches) return "rpc chunk sequence mismatch";
  at.chunks.push(meta.data);
  at.received += meta.data.byteLength;
  return at.received > at.byteLength ? "rpc chunk sequence exceeds declared length" : undefined;
}

/** Decodes a sequence that just received its last chunk; the bytes must add up to the declared length. */
function finishSequence(done: Sequence): Decoded {
  if (done.received !== done.byteLength)
    return { kind: "error", reason: "rpc chunk sequence length mismatch" };
  return reassemble(Buffer.concat(done.chunks));
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
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value
    ? typeof value.type === "string"
    : false;
}

interface ChunkMeta {
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: Buffer;
}

function chunkMeta(frame: Frame, minChunkedBytes: number): ChunkMeta | string {
  const { chunkId, index, count, byteLength, data } = frame;
  const valid =
    isChunkId(chunkId) &&
    isCount(index) &&
    isCount(count) &&
    count <= MAX_CHUNKS &&
    isCount(byteLength) &&
    count >= 2 &&
    index < count &&
    byteLength >= minChunkedBytes &&
    byteLength <= MAX_REASSEMBLED_BYTES;
  if (!valid) return "invalid rpc chunk metadata";
  const bytes = decodeBase64(data);
  if (bytes === undefined) return "invalid rpc chunk data";
  return bytes.byteLength > CHUNK_BYTES
    ? "rpc chunk data exceeds the slice size"
    : { chunkId, index, count, byteLength, data: bytes };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isChunkId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CHUNK_ID_CHARS;
}

/** Only canonical base64 is accepted, as omp does: anything else means the line was mangled. */
function decodeBase64(data: unknown): Buffer | undefined {
  if (typeof data !== "string" || data === "" || !BASE64.test(data)) return undefined;
  const bytes = Buffer.from(data, "base64");
  return bytes.toString("base64") === data ? bytes : undefined;
}

function reassemble(bytes: Buffer): Decoded {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "error", reason: "rpc chunk data is not UTF-8" };
  }
  const frame = parseFrame(text);
  return typeof frame === "string"
    ? { kind: "error", reason: "rpc frame must be an object" }
    : { kind: "frame", frame, text };
}
