import { describe, expect, it } from "vitest";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import { csvField, exportName, requestsCsv, toCsv, toolsCsv } from "../src/ui/export.ts";
import { makeRequest, makeTool } from "./helpers.ts";

describe("csvField", () => {
  it("leaves plain values alone and quotes the ones that need it", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(42)).toBe("42");
    expect(csvField(-3)).toBe("-3");
    expect(csvField(null)).toBe("");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("defuses text a spreadsheet would run as a formula", () => {
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-x")).toBe("'-x");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField("=a,b")).toBe('"\'=a,b"');
  });
});

describe("toCsv", () => {
  it("joins rows with CRLF and ends with one", () => {
    expect(
      toCsv([
        ["a", 1],
        ["b", null],
      ]),
    ).toBe("a,1\r\nb,\r\n");
  });
});

describe("requestsCsv and toolsCsv", () => {
  it("writes one header and one row per request, raw numbers and ISO times", () => {
    const csv = requestsCsv([
      makeRequest({
        id: "r1",
        ts: Date.UTC(2026, 9, 8, 12, 0, 0),
        latencyMs: null,
        stopReason: "end_turn",
        tokens: { ...ZERO_TOKENS, input: 1_234, output: 5, cacheRead: 6, cacheWrite: 7 },
      }),
    ]);
    const [head, row] = csv.trimEnd().split("\r\n");
    expect(head).toBe(
      "time,request_id,session_id,agent_id,model,provider,upstream,latency_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,stop_reason,est_cost_usd",
    );
    expect(row).toBe(
      "2026-10-08T12:00:00.000Z,r1,s1,main,claude-sonnet-5-5,Anthropic,https://api.anthropic.com,,1234,5,6,7,end_turn,",
    );
  });

  it("writes tool calls with their result in words", () => {
    const csv = toolsCsv([
      makeTool({ id: "t1", startedAt: Date.UTC(2026, 0, 1), ok: false, agentId: null, durationMs: null }),
      makeTool({ id: "t2", startedAt: Date.UTC(2026, 0, 2) }),
    ]);
    expect(csv.split("\r\n")).toEqual([
      "started,tool_use_id,session_id,agent_id,tool,duration_ms,result",
      "2026-01-01T00:00:00.000Z,t1,s1,main,Bash,,failed",
      "2026-01-02T00:00:00.000Z,t2,s1,main,Bash,50,succeeded",
      "",
    ]);
  });
});

describe("exportName", () => {
  it("stamps the file with the local date and time", () => {
    const at = new Date(2026, 9, 8, 9, 5, 3).getTime();
    expect(exportName("requests", at)).toBe("observatory-requests-20261008-090503.csv");
  });
});
