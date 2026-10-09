import { describe, expect, it } from "vitest";
import type { AttributionNode } from "../src/cost/attribution.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import { attributionCsv, exportName, requestsCsv, toolsCsv } from "../src/ui/export.ts";
import { makeRequest, makeTool } from "./helpers.ts";

const at = (over: Partial<AttributionNode>): AttributionNode => ({
  kind: "model",
  key: "m",
  label: "m",
  note: null,
  requests: 1,
  tokens: { ...ZERO_TOKENS },
  costUsd: null,
  unpriced: 0,
  mix: [],
  children: [],
  ...over,
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
      "2026-10-08T12:00:00.000Z,r1,s1,main,claude-sonnet-5-5,Anthropic,https://api.anthropic.com,,1234,5,6,7,end_turn,0.002536",
    );
  });

  it("quotes fields that hold commas, quotes or line breaks", () => {
    const csv = requestsCsv([
      makeRequest({ id: "r1", model: "a,b" }),
      makeRequest({ id: "r2", model: 'say "hi"' }),
      makeRequest({ id: "r3", stopReason: "two\nlines" }),
    ]);
    const [, r1, r2, r3] = csv.trimEnd().split("\r\n");
    expect(r1).toContain('"a,b"');
    expect(r2).toContain('"say ""hi"""');
    expect(r3).toContain('"two\nlines"');
  });

  it("defuses text a spreadsheet would run as a formula, blank for null", () => {
    const csv = requestsCsv([
      makeRequest({ id: "r1", model: "=SUM(A1)" }),
      makeRequest({ id: "r2", model: "+1" }),
      makeRequest({ id: "r3", model: "-x" }),
      makeRequest({ id: "r4", model: "@cmd" }),
      makeRequest({ id: "r5", model: "=a,b" }),
      makeRequest({ id: "r6", latencyMs: null, stopReason: null }),
    ]);
    const rows = csv.trimEnd().split("\r\n");
    expect(rows[1]).toContain("'=SUM(A1)");
    expect(rows[2]).toContain("'+1");
    expect(rows[3]).toContain("'-x");
    expect(rows[4]).toContain("'@cmd");
    expect(rows[5]).toContain('"\'=a,b"');
    expect(rows[6]?.split(",")).toContain(""); // a null latency and stop reason stay blank
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
    expect(exportName("requests", at)).toBe("radar-requests-20261008-090503.csv");
  });
});

describe("attributionCsv", () => {
  it("flattens the tree to one row per model, with the repo, session and agent spelled out", () => {
    const tree: AttributionNode[] = [
      at({
        kind: "repo",
        key: "/w/app",
        label: "~/app",
        children: [
          at({
            kind: "session",
            key: "s1",
            label: "fix it",
            children: [
              at({
                kind: "agent",
                key: "s1:main",
                label: "main",
                children: [
                  at({
                    key: "glm-5.3",
                    label: "glm-5.3",
                    requests: 3,
                    tokens: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
                    costUsd: 0.5,
                  }),
                ],
              }),
              at({
                kind: "session",
                key: "j1",
                label: "night job",
                children: [
                  at({
                    kind: "agent",
                    key: "j1:main",
                    label: "runner",
                    children: [at({ key: "claude-x", label: "claude-x", unpriced: 1 })],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ];
    expect(attributionCsv("day", tree).split("\r\n")).toEqual([
      "range,repo,session,agent,model,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,est_cost_usd,unpriced_requests",
      "day,~/app,fix it,main,glm-5.3,3,10,4,2,1,0.5,0",
      "day,~/app,night job,runner,claude-x,1,0,0,0,0,,1",
      "",
    ]);
  });
});
