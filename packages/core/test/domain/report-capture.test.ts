import { describe, expect, it } from "vitest";
import { correctionPrompt, extractReport, reportInstructions } from "../../src/domain/report-capture.ts";

describe("extractReport reads the report out of a final message", () => {
  it.each([
    ["the whole text", '{"summary":"done"}'],
    ["a fenced block", 'Here it is:\n```json\n{"summary":"done"}\n```\nThanks.'],
    ["an unlabelled fence", '```\n{"summary":"done"}\n```'],
    ["the outermost braces in prose", 'The report is {"summary":"done"} as asked.'],
  ])("from %s", (_, text) => {
    expect(extractReport(text)).toEqual({ summary: "done" });
  });

  it.each([
    ["no JSON at all", "all done"],
    ["an array", "[1, 2]"],
    ["a scalar", "42"],
    ["broken braces", '{"summary": '],
  ])("is null for %s", (_, text) => {
    expect(extractReport(text)).toBeNull();
  });
});

describe("the report contract in words", () => {
  it("appends the schema to the prompt and asks for one JSON object", () => {
    const text = reportInstructions("Do the thing.", { type: "object" });
    expect(text.startsWith("Do the thing.\n\n## Final report\n")).toBe(true);
    expect(text).toContain("only the report as one JSON object");
    expect(text).toContain('```json\n{\n  "type": "object"\n}\n```');
  });

  it("asks for a correction naming every problem", () => {
    expect(correctionPrompt(["summary: required", "files: expected array"])).toBe(
      "Your report was invalid: summary: required; files: expected array. Reply with only the corrected JSON object.",
    );
  });
});
