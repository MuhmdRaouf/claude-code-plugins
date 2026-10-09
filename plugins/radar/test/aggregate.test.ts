import { describe, expect, it } from "vitest";
import { type Tokens, ZERO_TOKENS } from "../src/shared/model.ts";
import {
  meanOf,
  modelRows,
  percentile,
  summarize,
  toolCounts,
  upstreamRows,
} from "../src/store/aggregate.ts";
import { makeAgentView, makeRequest, makeSessionView, makeTool } from "./helpers.ts";

describe("percentile", () => {
  it("returns null for no data", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("interpolates between ranks", () => {
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([4, 1, 3, 2], 50)).toBe(3); // rank 1.5 → 2.5 → 3
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 95)).toBe(4); // rank 2.85 → 3.85 → 4
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
  });
});

describe("meanOf", () => {
  it("averages and rounds, or bows out on no data", () => {
    expect(meanOf([])).toBeNull();
    expect(meanOf([1, 2])).toBe(2); // 1.5 rounds away from zero
    expect(meanOf([10, 20, 31])).toBe(20);
  });
});

describe("summarize", () => {
  it("counts sessions, live sessions, agents, requests, tools and errors", () => {
    const summary = summarize(
      [
        makeSessionView({ id: "a", live: true, startedAt: 1_000, agents: [makeAgentView()] }),
        makeSessionView({
          id: "b",
          live: false,
          startedAt: 2_000,
          agents: [makeAgentView({ id: "w1" }), makeAgentView({ id: "w2" })],
        }),
      ],
      [
        makeRequest({ id: "r1", ts: 1_200, latencyMs: 100, tokens: tokens(10, 5, 2, 1) }),
        makeRequest({
          id: "r2",
          ts: 1_400,
          latencyMs: 300,
          tokens: tokens(7, 3, 0, 0),
          stopReason: "error",
        }),
        makeRequest({ id: "r3", ts: 1_600, latencyMs: null, tokens: ZERO_TOKENS }),
      ],
      [makeTool({ ok: true }), makeTool({ id: "t2", ok: false })],
      2_000,
    );
    expect(summary.sessions).toBe(2);
    expect(summary.liveSessions).toBe(1);
    expect(summary.agents).toBe(3);
    expect(summary.requests).toBe(3);
    expect(summary.toolCalls).toBe(2);
    expect(summary.errors).toBe(2); // one failed tool + one error stop reason
    expect(summary.tokens).toEqual(tokens(17, 8, 2, 1));
    expect(summary.latencyP50).toBe(200); // interpolated between 100 and 300
    expect(summary.latencyP95).toBe(290); // 100 + (300 - 100) * 0.95
    expect(summary.startedAt).toBe(1_000);
    expect(summary.now).toBe(2_000);
  });

  it("keeps nulls honest when there is nothing to measure", () => {
    const summary = summarize([], [], [], 5_000);
    expect(summary.startedAt).toBeNull();
    expect(summary.latencyP50).toBeNull();
    expect(summary.latencyP95).toBeNull();
    expect(summary.errors).toBe(0);
    expect(summary.tokens).toEqual(ZERO_TOKENS);
  });

  it("ignores startedAt nulls and only counts stop reasons in the error set", () => {
    const summary = summarize(
      [makeSessionView({ id: "a", startedAt: null })],
      [
        makeRequest({ stopReason: "end_turn" }),
        makeRequest({ stopReason: "tool_use" }),
        makeRequest({ stopReason: "api_error" }),
        makeRequest({ stopReason: null }),
      ],
      [],
      0,
    );
    expect(summary.startedAt).toBeNull();
    expect(summary.errors).toBe(1);
  });
});

describe("modelRows", () => {
  it("groups by model with provider, errors, tokens and p50, biggest total first", () => {
    const rows = modelRows([
      makeRequest({ model: "claude-sonnet-5-5", tokens: tokens(10, 0, 0, 0), latencyMs: 100 }),
      makeRequest({ model: "claude-sonnet-5-5", tokens: tokens(0, 10, 0, 0), latencyMs: 300 }),
      makeRequest({
        model: "glm-5.3",
        tokens: tokens(100, 0, 0, 0),
        latencyMs: 50,
        stopReason: "overloaded_error",
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.model).toBe("glm-5.3");
    expect(rows[0]?.provider).toBe("Z.ai");
    expect(rows[0]?.errors).toBe(1);
    expect(rows[0]?.requests).toBe(1);
    expect(rows[1]?.model).toBe("claude-sonnet-5-5");
    expect(rows[1]?.provider).toBe("Anthropic");
    expect(rows[1]?.errors).toBe(0);
    expect(rows[1]?.requests).toBe(2);
    expect(rows[1]?.tokens).toEqual(tokens(10, 10, 0, 0));
    expect(rows[1]?.latencyP50).toBe(200);
  });

  it("returns nothing for no requests", () => {
    expect(modelRows([])).toEqual([]);
  });
});

describe("upstreamRows", () => {
  it("groups by upstream with a host column, biggest total first", () => {
    const rows = upstreamRows([
      makeRequest({ upstream: "https://api.anthropic.com", tokens: tokens(5, 0, 0, 0) }),
      makeRequest({ upstream: "http://localhost:8787/v1", tokens: tokens(50, 0, 0, 0) }),
      makeRequest({ upstream: "http://localhost:8787/v1", tokens: tokens(0, 50, 0, 0) }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.host).toBe("localhost:8787");
    expect(rows[0]?.requests).toBe(2);
    expect(rows[0]?.tokens).toEqual(tokens(50, 50, 0, 0));
    expect(rows[1]?.host).toBe("api.anthropic.com");
  });
});

describe("toolCounts", () => {
  it("counts per name, most used first, names breaking ties", () => {
    const counts = toolCounts([
      makeTool({ name: "Bash" }),
      makeTool({ name: "Bash", ok: false }),
      makeTool({ name: "Read" }),
      makeTool({ name: "Read" }),
      makeTool({ name: "Grep" }),
    ]);
    expect(counts).toEqual([
      { name: "Bash", count: 2, failures: 1 },
      { name: "Read", count: 2, failures: 0 },
      { name: "Grep", count: 1, failures: 0 },
    ]);
  });
});

function tokens(input: number, output: number, cacheRead: number, cacheWrite: number): Tokens {
  return { input, output, cacheRead, cacheWrite };
}
