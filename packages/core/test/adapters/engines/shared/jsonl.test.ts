import { describe, expect, it } from "vitest";
import { parseJsonLine } from "../../../../src/adapters/engines/shared/jsonl.ts";

describe("parseJsonLine", () => {
  it("parses a line into its object, whitespace and all", () => {
    expect(parseJsonLine('  {"type": "ready", "protocolVersion": 2} ')).toEqual({
      type: "ready",
      protocolVersion: 2,
    });
  });

  it("returns undefined for blank, broken, array, scalar and null lines", () => {
    expect(parseJsonLine("")).toBeUndefined();
    expect(parseJsonLine("   ")).toBeUndefined();
    expect(parseJsonLine("{broken")).toBeUndefined();
    expect(parseJsonLine("[1, 2]")).toBeUndefined();
    expect(parseJsonLine('"text line"')).toBeUndefined();
    expect(parseJsonLine("null")).toBeUndefined();
  });
});
