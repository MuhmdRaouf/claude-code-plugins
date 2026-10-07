import { describe, expect, it } from "vitest";
import { createFrameDecoder, MAX_FRAME_BYTES } from "../../../../src/adapters/engines/pi-rpc/frames.ts";

describe("createFrameDecoder", () => {
  it("decodes a transcript line into its frame and keeps the exact text", () => {
    const decoder = createFrameDecoder();
    const line = '{"type":"agent_settled"}';
    expect(decoder.push(line)).toEqual({
      kind: "frame",
      frame: { type: "agent_settled" },
      text: line,
    });
  });

  it("decodes a response with its id and data", () => {
    const decoder = createFrameDecoder();
    const line =
      '{"id":"c1","type":"response","command":"get_state","success":true,"data":{"sessionId":"s"}}';
    expect(decoder.push(line)).toEqual({
      kind: "frame",
      frame: {
        id: "c1",
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "s" },
      },
      text: line,
    });
  });

  it("keeps the fields it does not know: unknown types still decode", () => {
    const decoder = createFrameDecoder();
    const line = '{"type":"future_event","payload":{"anything":[1,2]}}';
    expect(decoder.push(line)).toMatchObject({ kind: "frame", frame: { type: "future_event" } });
  });

  it("tolerates a trailing carriage return", () => {
    const decoder = createFrameDecoder();
    expect(decoder.push('{"type":"agent_settled"}\r')).toMatchObject({
      kind: "frame",
      text: '{"type":"agent_settled"}',
    });
  });

  it("parses JSON with its own surrounding whitespace, keeping the text verbatim", () => {
    const decoder = createFrameDecoder();
    const line = ' { "type" : "agent_settled" } ';
    expect(decoder.push(line)).toMatchObject({ kind: "frame", text: line });
  });

  it.each([
    ["not json", "Still starting…", "not JSON"],
    ["a JSON array", "[1,2]", "not an RPC frame"],
    ["a frame without a type", '{"id":"x"}', "not an RPC frame"],
    ["a JSON string", '"agent_settled"', "not an RPC frame"],
    ["a JSON number", "42", "not an RPC frame"],
    ["null", "null", "not an RPC frame"],
    ["a frame whose type is not a string", '{"type":7}', "not an RPC frame"],
  ])("reports %s as malformed instead of throwing", (_, line, reason) => {
    expect(createFrameDecoder().push(line)).toEqual({ kind: "malformed", line, reason });
  });

  it("skips blank lines", () => {
    expect(createFrameDecoder().push("")).toEqual({ kind: "partial" });
  });

  it("a blank line with a carriage return is still blank", () => {
    expect(createFrameDecoder().push("\r")).toEqual({ kind: "partial" });
  });

  it("recovers after a malformed line: the next frame decodes", () => {
    const decoder = createFrameDecoder();
    expect(decoder.push("this is not json")).toMatchObject({ kind: "malformed" });
    expect(decoder.push('{"type":"agent_settled"}')).toMatchObject({ kind: "frame" });
  });

  it("MAX_FRAME_BYTES sits above omp's default line limit, for agent_end's whole-session frames", () => {
    expect(MAX_FRAME_BYTES).toBe(64 * 1024 * 1024);
  });
});
