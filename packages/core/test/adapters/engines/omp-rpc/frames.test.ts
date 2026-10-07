import { describe, expect, it } from "vitest";
import {
  createFrameDecoder,
  encodeChunks,
  MAX_FRAME_BYTES,
} from "../../../../src/adapters/engines/omp-rpc/frames.ts";

function chunkLines(text: string, chunkBytes: number, chunkId = "c1"): string[] {
  const bytes = Buffer.from(text, "utf8");
  const count = Math.ceil(bytes.byteLength / chunkBytes);
  return Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
    }),
  );
}

const bigFrame = (bytes: number): string =>
  JSON.stringify({
    id: "e1",
    type: "response",
    command: "get_entries",
    success: true,
    data: "é".repeat(bytes / 2),
  });

/** A decoder past the negotiation step, as the client hands it after ready + negotiate_protocol. */
function chunkedDecoder(maxFrameBytes?: number): ReturnType<typeof createFrameDecoder> {
  const decoder = createFrameDecoder();
  decoder.negotiated(maxFrameBytes);
  return decoder;
}

describe("createFrameDecoder", () => {
  it("decodes a v1 line into its frame and keeps the exact text", () => {
    const decoder = createFrameDecoder();
    const line = '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}';
    expect(decoder.push(line)).toEqual({
      kind: "frame",
      frame: { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] },
      text: line,
    });
  });

  it("tolerates a trailing carriage return", () => {
    const decoder = createFrameDecoder();
    expect(decoder.push('{"type":"session_settled"}\r')).toMatchObject({
      kind: "frame",
      text: '{"type":"session_settled"}',
    });
  });

  it.each([
    ["not json", "Still starting"],
    ["a JSON array", "[1,2]"],
    ["a frame without a type", '{"id":"x"}'],
    ["a JSON string", '"ready"'],
  ])("reports %s as malformed instead of throwing", (_, line) => {
    expect(createFrameDecoder().push(line)).toMatchObject({ kind: "malformed", line });
  });

  it("skips blank lines", () => {
    expect(createFrameDecoder().push("")).toEqual({ kind: "partial" });
  });

  it("rejects rpc_chunk before protocol 2 has been negotiated", () => {
    const decoder = createFrameDecoder();
    for (const line of chunkLines(bigFrame(MAX_FRAME_BYTES + 2_000), 512 * 1024)) {
      expect(decoder.push(line)).toMatchObject({
        kind: "error",
        reason: "rpc chunk before protocol negotiation",
      });
    }
  });

  it("honours the peer's ready.maxFrameBytes as the chunk threshold", () => {
    const decoder = chunkedDecoder(64 * 1024);
    const text = bigFrame(100 * 1024);
    const lines = chunkLines(text, 32 * 1024);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(0, -1)) expect(decoder.push(line)).toEqual({ kind: "partial" });
    expect(decoder.push(lines.at(-1) ?? "")).toMatchObject({ kind: "frame", text });
  });

  it("reassembles a v2 rpc_chunk sequence (chunks carry no id) and checks byteLength", () => {
    const text = bigFrame(MAX_FRAME_BYTES + 10_000);
    const decoder = chunkedDecoder();
    const lines = chunkLines(text, 256 * 1024);
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines.slice(0, -1)) expect(decoder.push(line)).toEqual({ kind: "partial" });
    const last = decoder.push(lines.at(-1) ?? "");
    expect(last).toMatchObject({ kind: "frame", text, frame: { id: "e1", command: "get_entries" } });
  });

  it("round-trips its own encoder", () => {
    const text = bigFrame(MAX_FRAME_BYTES * 3);
    const decoder = chunkedDecoder();
    const results = encodeChunks(text, "x9").map((line) => decoder.push(line));
    expect(results.at(-1)).toMatchObject({ kind: "frame", text });
  });

  it("encodes a frame within the limit as one line", () => {
    expect(encodeChunks('{"type":"session_settled"}', "x")).toEqual(['{"type":"session_settled"}']);
  });

  describe("chunk sequence violations are protocol errors", () => {
    const text = bigFrame(MAX_FRAME_BYTES + 2_000);
    const lines = (): string[] => chunkLines(text, 256 * 1024);

    it("a sequence that does not start at index 0", () => {
      expect(chunkedDecoder().push(lines()[1] ?? "")).toMatchObject({
        kind: "error",
        reason: "rpc chunk sequence must start at index 0",
      });
    });

    it("a frame interrupting a sequence", () => {
      const decoder = chunkedDecoder();
      decoder.push(lines()[0] ?? "");
      expect(decoder.push('{"type":"session_settled"}')).toMatchObject({
        kind: "error",
        reason: "rpc chunk sequence interrupted",
      });
    });

    it("a chunk from another sequence", () => {
      const decoder = chunkedDecoder();
      decoder.push(lines()[0] ?? "");
      const other = chunkLines(text, 256 * 1024, "other")[1] ?? "";
      expect(decoder.push(other)).toMatchObject({ kind: "error", reason: "rpc chunk sequence mismatch" });
    });

    it("a chunk that skips an index (0 then 2, with 1 still missing)", () => {
      const decoder = chunkedDecoder();
      expect(decoder.push(lines()[0] ?? "")).toEqual({ kind: "partial" });
      expect(decoder.push(lines()[2] ?? "")).toMatchObject({
        kind: "error",
        reason: "rpc chunk sequence mismatch",
      });
      // The skipped chunk cannot be joined in late either: the sequence failed, not paused.
      expect(decoder.push(lines()[1] ?? "")).toMatchObject({
        kind: "error",
        reason: "rpc chunk sequence must start at index 0",
      });
    });

    it("a repeated index", () => {
      const decoder = chunkedDecoder();
      expect(decoder.push(lines()[0] ?? "")).toEqual({ kind: "partial" });
      expect(decoder.push(lines()[0] ?? "")).toMatchObject({
        kind: "error",
        reason: "rpc chunk sequence mismatch",
      });
    });

    it("a byteLength that does not match the data", () => {
      const decoder = chunkedDecoder();
      const all = lines().map((line) => ({ ...JSON.parse(line), byteLength: MAX_FRAME_BYTES }));
      for (const chunk of all.slice(0, -1)) decoder.push(JSON.stringify(chunk));
      expect(decoder.push(JSON.stringify(all.at(-1)))).toMatchObject({
        kind: "error",
        reason: "rpc chunk sequence exceeds declared length",
      });
    });

    it("data shorter than byteLength", () => {
      const decoder = chunkedDecoder();
      const big = lines().map((line) => ({ ...JSON.parse(line), byteLength: 9_000_000 }));
      for (const chunk of big.slice(0, -1)) decoder.push(JSON.stringify(chunk));
      expect(decoder.push(JSON.stringify(big.at(-1)))).toMatchObject({
        kind: "error",
        reason: "rpc chunk sequence length mismatch",
      });
    });

    it.each([
      ["missing chunkId", { chunkId: "" }],
      ["a chunkId over 128 chars", { chunkId: "c".repeat(129) }],
      ["a count below 2", { count: 1 }],
      ["a count over 256", { count: 257 }],
      ["an index past count", { index: 7 }],
      ["a byteLength under the frame limit", { byteLength: 10 }],
      ["a byteLength over the reassembly limit", { byteLength: 65 * 1024 * 1024 }],
      ["data that is not base64", { data: "not base64!" }],
      ["data that is not canonical base64", { data: "QQ" }],
    ])("bad metadata: %s", (_, patch) => {
      const chunk = { ...JSON.parse(lines()[0] ?? ""), ...patch };
      expect(chunkedDecoder().push(JSON.stringify(chunk))).toMatchObject({ kind: "error" });
    });

    it("a single chunk over omp's 256 KiB slice size", () => {
      const decoder = chunkedDecoder();
      const oversized = chunkLines(bigFrame(MAX_FRAME_BYTES + 100_000), 600 * 1024);
      expect(decoder.push(oversized[0] ?? "")).toMatchObject({
        kind: "error",
        reason: "rpc chunk data exceeds the slice size",
      });
    });

    it("a reassembled payload that is not a JSON object", () => {
      const decoder = chunkedDecoder();
      const results = chunkLines(`[${" ".repeat(MAX_FRAME_BYTES)}]`, 256 * 1024).map((line) =>
        decoder.push(line),
      );
      expect(results.at(-1)).toMatchObject({ kind: "error", reason: "rpc frame must be an object" });
    });

    it("a reassembled payload that is not UTF-8", () => {
      const decoder = chunkedDecoder();
      const bytes = Buffer.alloc(MAX_FRAME_BYTES + 10, 0xff);
      const slice = 220 * 1024;
      const count = Math.ceil(bytes.byteLength / slice);
      const chunk = (index: number): string =>
        JSON.stringify({
          type: "rpc_chunk",
          chunkId: "u",
          index,
          count,
          byteLength: bytes.byteLength,
          data: bytes.subarray(index * slice, (index + 1) * slice).toString("base64"),
        });
      for (let index = 0; index < count - 1; index += 1) decoder.push(chunk(index));
      expect(decoder.push(chunk(count - 1))).toMatchObject({ kind: "error" });
    });

    it("recovers after an error: the next sequence decodes", () => {
      const decoder = chunkedDecoder();
      decoder.push(lines()[1] ?? "");
      const results = lines().map((line) => decoder.push(line));
      expect(results.at(-1)).toMatchObject({ kind: "frame", text });
    });
  });
});
