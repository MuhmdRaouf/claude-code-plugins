import { createWriteStream } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Frame } from "../../../../src/adapters/engines/pi-rpc/frames.ts";
import {
  createRpcLogs,
  LOG_FIELD_LIMIT,
  LOG_KEEP,
  logText,
  outboundLogText,
  type TruncatedField,
} from "../../../../src/adapters/engines/shared/rpc-log.ts";

const big = (chars: number): string => "x".repeat(chars);

function logged(frame: Frame): Record<string, unknown> {
  return JSON.parse(logText(frame, JSON.stringify(frame)));
}

describe("logText", () => {
  it("keeps small frames byte for byte (the original text, not a re-serialization)", () => {
    const text = '{"type":"tool_execution_end","toolName":"read",  "result":{"details":{}}}';
    expect(logText(JSON.parse(text), text)).toBe(text);
  });

  it("cuts tool_execution_end.result.details over the limit to its head and tail with a byte count", () => {
    const details = { stdout: big(500_000) };
    const frame = {
      type: "tool_execution_end",
      toolCallId: "call_0123456789abcdef01234567",
      toolName: "bash",
      result: { content: [], details },
      isError: false,
    };
    const out = logged(frame);
    const json = JSON.stringify(details);
    expect(out).toEqual({
      ...frame,
      result: {
        content: [],
        details: {
          $truncated: Buffer.byteLength(json),
          head: json.slice(0, LOG_KEEP),
          tail: json.slice(-LOG_KEEP),
        },
      },
    });
    expect(JSON.stringify(out).length).toBeLessThan(3 * LOG_KEEP);
  });

  it("cuts a toolResult message_end's content and details, and leaves the envelope alone", () => {
    const frame = {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call_0123456789abcdef01234567",
        toolName: "read",
        content: [{ type: "text", text: big(LOG_FIELD_LIMIT + 1) }],
        details: { text: big(LOG_FIELD_LIMIT) },
        isError: false,
      },
      messageId: "msg-3",
    };
    const out = logged(frame) as { message: Record<string, unknown>; messageId: string };
    expect(out.messageId).toBe("msg-3");
    expect(out.message).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
    expect(out.message.content).toMatchObject({ $truncated: expect.any(Number) });
    expect(out.message.details).toMatchObject({ $truncated: expect.any(Number) });
  });

  it("counts UTF-8 bytes, not characters", () => {
    const details = { text: "é".repeat(LOG_FIELD_LIMIT / 2 + 10) };
    const out = logged({ type: "tool_execution_end", result: { details } }) as {
      result: { details: { $truncated: number } };
    };
    expect(out.result.details.$truncated).toBe(Buffer.byteLength(JSON.stringify(details)));
  });

  it("keeps LOG_KEEP bytes of head and tail without splitting a UTF-8 character", () => {
    // The 9-byte ASCII prefix `{"text":"` pushes the 16 KB cut into the middle of an é.
    const details = { text: "é".repeat(80_000) };
    const json = JSON.stringify(details);
    const out = logged({ type: "tool_execution_end", result: { details } }) as {
      result: { details: TruncatedField };
    };
    const cut = out.result.details;
    expect(json.startsWith(cut.head)).toBe(true);
    expect(json.endsWith(cut.tail)).toBe(true);
    for (const part of [cut.head, cut.tail]) {
      expect(Buffer.byteLength(part)).toBeGreaterThan(LOG_KEEP - 4);
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(LOG_KEEP);
      expect(part).not.toContain("\\ufffd");
    }
  });

  it.each([
    [
      "an assistant message_end",
      { type: "message_end", message: { role: "assistant", content: big(70_000) } },
    ],
    ["a frame of another type", { type: "message_update", details: big(70_000) }],
    ["a tool_execution_end without a result", { type: "tool_execution_end" }],
    ["a message_end without a message", { type: "message_end", message: "odd" }],
    ["a non-object result", { type: "tool_execution_end", result: big(70_000) }],
    ["a field at the limit", { type: "tool_execution_end", result: { details: big(LOG_FIELD_LIMIT - 2) } }],
  ])("leaves %s untouched", (_, frame) => {
    const text = JSON.stringify(frame);
    expect(logText(frame as Frame, text)).toBe(text);
  });
});

describe("createRpcLogs", () => {
  it("stops logging after a stream failure instead of throwing, and still closes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-log-"));
    const frames = createWriteStream(join(dir, "out.jsonl"));
    const commands = createWriteStream(join(dir, "in.jsonl"));
    const logs = createRpcLogs(frames, commands, "job.json#prompt");
    logs.inbound('{"type":"agent_settled"}');
    logs.outbound({ id: "c1", type: "get_state" });

    frames.destroy(new Error("disk on fire"));
    await new Promise((resolve) => frames.once("close", resolve));

    expect(logs.failure()).toBe("Error: disk on fire");
    expect(() => logs.inbound('{"type":"message_end"}')).not.toThrow();
    logs.outbound({ id: "c2", type: "get_state" });
    await logs.close();
    // The healthy stream keeps what was written before the failure and nothing after it.
    expect((await readFile(join(dir, "in.jsonl"), "utf8")).split("\n").filter(Boolean)).toEqual([
      '{"id":"c1","type":"get_state"}',
    ]);
  });
});

describe("outboundLogText", () => {
  it("replaces a prompt's text with a reference", () => {
    expect(
      outboundLogText({ id: "c5", type: "prompt", message: "secret-ish brief" }, "job.json#prompt"),
    ).toBe('{"id":"c5","type":"prompt","message":{"$ref":"job.json#prompt"}}');
  });

  it("logs other commands as sent", () => {
    expect(outboundLogText({ id: "c1", type: "get_state" }, "ref")).toBe('{"id":"c1","type":"get_state"}');
  });
});
