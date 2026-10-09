import { describe, expect, it } from "vitest";
import { type RequestRecord, totalTokens, ZERO_TOKENS } from "../src/shared/model.ts";
import { createStore, pruneWaiting, type Store } from "../src/store/store.ts";
import { makeRequest } from "./helpers.ts";

const T = Date.parse("2026-10-08T15:31:38.587Z");

/** A router's spool line as the watcher hands it over: upstream host, route kind, latency, maybe usage. */
function route(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return makeRequest({
    id: `route:s1:${T}:200`,
    agentId: "",
    model: "claude-opus-5-5",
    upstream: "api.anthropic.com",
    ts: T,
    latencyMs: 1951,
    tokens: { ...ZERO_TOKENS },
    stopReason: "200",
    provider: "Anthropic",
    route: "anthropic",
    ...overrides,
  });
}

/** The transcript's copy of the same call: its agent, tokens and stop reason, no upstream. */
function transcript(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return makeRequest({
    id: "req_011",
    agentId: "agent-a31cd3de580148dc3",
    model: "claude-opus-5-5",
    upstream: "",
    ts: T + 40,
    latencyMs: 1951,
    tokens: { input: 3, output: 120, cacheRead: 9000, cacheWrite: 400 },
    stopReason: "tool_use",
    provider: "Anthropic",
    ...overrides,
  });
}

describe("a request seen by both a router and a transcript", () => {
  it("is one request when the spool line comes first", () => {
    const store = createStore();
    store.addRequest(route({ agentId: "a31cd3de580148dc3" }));
    store.addRequest(transcript());
    const rows = store.requests({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "agent-a31cd3de580148dc3",
      upstream: "api.anthropic.com",
      latencyMs: 1951,
      stopReason: "tool_use",
      route: "anthropic",
    });
    expect(totalTokens(rows[0]?.tokens ?? ZERO_TOKENS)).toBe(9523);
    expect(store.summary().requests).toBe(1);
  });

  it("names both the router it went through and where the router sent it", () => {
    const store = createStore();
    store.addRequest(transcript({ via: "127.0.0.1:18787" }));
    store.addRequest(route({ via: "zai" }));
    expect(store.requests({})[0]).toMatchObject({ upstream: "api.anthropic.com", via: "zai" });
  });

  it("replaces the transcript's anthropic default with the upstream the router actually used", () => {
    // the watcher now writes DEFAULT_UPSTREAM on a claude-* transcript call it cannot place
    const spoolFirst = createStore();
    spoolFirst.addRequest(route({ upstream: "https://api.z.ai", via: "zai" }));
    spoolFirst.addRequest(transcript({ upstream: "https://api.anthropic.com", via: "127.0.0.1:18787" }));
    const transcriptFirst = createStore();
    transcriptFirst.addRequest(transcript({ upstream: "https://api.anthropic.com", via: "127.0.0.1:18787" }));
    transcriptFirst.addRequest(route({ upstream: "https://api.z.ai", via: "zai" }));
    for (const store of [spoolFirst, transcriptFirst]) {
      expect(store.requests({})).toEqual([
        expect.objectContaining({ upstream: "https://api.z.ai", via: "zai" }),
      ]);
    }
  });

  it("is one request when the transcript comes first, and its streamed copies stay merged", () => {
    const store = createStore();
    store.addRequest(transcript({ tokens: { input: 3, output: 1, cacheRead: 9000, cacheWrite: 400 } }));
    store.addRequest(route());
    store.addRequest(transcript());
    const rows = store.requests({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: "agent-a31cd3de580148dc3", upstream: "api.anthropic.com" });
    expect(rows[0]?.tokens.output).toBe(120);
  });

  it("keeps the route line's final usage over the transcript's streamed-opening copy, either order", () => {
    // the provider's own final numbers, which the router tracked before any rewrite of its stream
    const real = { input: 148_503, output: 902, cacheRead: 12_115, cacheWrite: 3_022 };
    // what Claude Code's transcript records when the router rewrote the stream's zero message_start
    const streamed = { input: 148_500, output: 902, cacheRead: 0, cacheWrite: 0 };
    const copy = { model: "glm-5.3", provider: "Z.ai", tokens: streamed };
    const routeLine = {
      model: "glm-5.3",
      provider: "Z.ai",
      route: "provider" as const,
      upstream: "api.z.ai",
      tokens: real,
    };
    const routeFirst = createStore();
    routeFirst.addRequest(route(routeLine));
    routeFirst.addRequest(transcript(copy));
    routeFirst.addRequest(transcript(copy)); // Claude Code's final entry repeats the opening numbers
    const transcriptFirst = createStore();
    transcriptFirst.addRequest(transcript(copy));
    transcriptFirst.addRequest(route(routeLine));
    transcriptFirst.addRequest(transcript(copy));
    for (const store of [routeFirst, transcriptFirst]) {
      const rows = store.requests({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokens).toEqual(real);
    }
  });

  it("takes tokens from the spool when the transcript has none, and the model's provider for cost", () => {
    const store = createStore();
    store.addRequest(
      route({
        model: "glm-5.3",
        upstream: "api.z.ai",
        provider: "Z.ai",
        route: "provider",
        agentId: "a77",
        tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    store.addRequest(
      transcript({ model: "glm-5.3", agentId: "agent-a77", provider: "Z.ai", tokens: { ...ZERO_TOKENS } }),
    );
    const models = store.models();
    expect(models.models).toEqual([
      expect.objectContaining({
        model: "glm-5.3",
        provider: "Z.ai",
        requests: 1,
        costUsd: expect.any(Number),
      }),
    ]);
    expect(models.upstreams.map((row) => [row.host, row.requests])).toEqual([["api.z.ai", 1]]);
    expect(totalTokens(models.models[0]?.tokens ?? ZERO_TOKENS)).toBe(1200);
  });

  it("keeps a result-filled request's run-total flag, whichever copy arrives first", () => {
    const tokens = { input: 62_639, output: 10_446, cacheRead: 857_600, cacheWrite: 0 };
    const spoolFirst = createStore();
    spoolFirst.addRequest(route());
    spoolFirst.addRequest(transcript({ totals: true, tokens }));
    const transcriptFirst = createStore();
    transcriptFirst.addRequest(transcript({ totals: true, tokens }));
    transcriptFirst.addRequest(route());
    for (const store of [spoolFirst, transcriptFirst]) {
      expect(store.requests({})).toEqual([expect.objectContaining({ totals: true })]);
    }
  });

  it("keeps the run-total flag when the result lands as a later write of a held request", () => {
    const store = createStore();
    store.addRequest(transcript({ tokens: { ...ZERO_TOKENS } }));
    store.addRequest(
      transcript({
        totals: true,
        tokens: { input: 62_639, output: 10_446, cacheRead: 857_600, cacheWrite: 0 },
      }),
    );
    expect(store.requests({})).toEqual([expect.objectContaining({ id: "req_011", totals: true })]);
  });

  it("does not pair calls of another agent, another model or far apart in time", () => {
    const store = createStore();
    store.addRequest(route({ agentId: "a99" }));
    store.addRequest(transcript({ id: "other-model", model: "claude-sonnet-5-5" }));
    store.addRequest(transcript({ id: "too-late", ts: T + 60_000 }));
    store.addRequest(transcript({ id: "other-agent" }));
    expect(store.requests({})).toHaveLength(4);
  });

  it("pairs each spool line with the closest transcript call once", () => {
    const store = createStore();
    store.addRequest(transcript({ id: "first", ts: T - 3000, latencyMs: 1230 }));
    store.addRequest(transcript({ id: "second", ts: T + 20, latencyMs: 2910 }));
    store.addRequest(route({ id: "r1", ts: T - 3010, latencyMs: 1230 }));
    store.addRequest(route({ id: "r2", ts: T, latencyMs: 2910 }));
    const rows = store.requests({});
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.upstream === "api.anthropic.com")).toBe(true);
  });

  it("counts a spool line with no transcript copy on its own, under the main agent", () => {
    const store = createStore();
    store.addRequest(route({ tokens: { input: 14, output: 16, cacheRead: 0, cacheWrite: 0 } }));
    expect(store.requests({})).toEqual([
      expect.objectContaining({ agentId: "main", upstream: "api.anthropic.com" }),
    ]);
  });
});

describe("upstream rows", () => {
  it("list every host once with its requests, tokens and cost, and name transcript-only calls plainly", () => {
    const store = createStore();
    store.addRequest(route({ id: "a", upstream: "api.anthropic.com" }));
    store.addRequest(transcript({ id: "b", upstream: "https://api.anthropic.com", ts: T + 600_000 }));
    store.addRequest(transcript({ id: "c", upstream: "", ts: T + 900_000 }));
    store.addRequest(
      route({
        id: "d",
        model: "kimi-k3",
        upstream: "api.moonshot.ai",
        provider: "Moonshot",
        route: "provider",
        tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
    );
    const rows = store.models().upstreams;
    expect(rows.map((row) => [row.host, row.requests])).toEqual(
      expect.arrayContaining([
        ["api.anthropic.com", 2],
        ["Claude Code direct (no router)", 1],
        ["api.moonshot.ai", 1],
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.host === "api.moonshot.ai")?.costUsd).toEqual(expect.any(Number));
  });
});

describe("pruneWaiting", () => {
  const recordOf = (records: Map<string, number>) => (id: string) =>
    records.has(id) ? { ts: records.get(id) ?? 0 } : undefined;

  it("drops waiting entries older than the match window and records the store evicted", () => {
    const records = new Map<string, number>([
      ["fresh", 19_000],
      ["stale", 0],
      ["future", 25_000],
    ]);
    const waiting = new Map<string, string>([
      ["fresh", "main"],
      ["stale", "main"],
      ["future", "main"],
      ["evicted", "main"],
    ]);
    pruneWaiting(waiting, 20_000, recordOf(records));
    expect([...waiting]).toEqual([
      ["fresh", "main"],
      ["future", "main"],
    ]);
  });

  it("empties a Set the same way, leaving nothing for the scan to trip over", () => {
    const records = new Map<string, number>([["kept", 15_000]]);
    const waiting = new Set<string>(["kept", "gone", "ancient"]);
    pruneWaiting(waiting, 20_000, recordOf(records));
    expect([...waiting]).toEqual(["kept"]);
  });
});

describe("the waiting maps a catch-up feeds", () => {
  /** `n` unpairable transcript calls of one session and model, spaced past the match window. */
  function storm(store: Store, n: number): void {
    for (let at = 1; at <= n; at += 1) {
      store.addRequest(transcript({ id: `t${at}`, ts: T + at * 11_000 }));
    }
  }

  it("still pairs a call with its spool line inside the window, however many pairs came before", () => {
    const store = createStore();
    storm(store, 50);
    store.addRequest(route({ id: "late-route", ts: T + 600_000 }));
    store.addRequest(transcript({ id: "late-copy", ts: T + 600_000 + 40 }));
    const rows = store.requests({});
    expect(rows).toHaveLength(51);
    expect(rows.find((row) => row.id === "late-route")).toMatchObject({
      upstream: "api.anthropic.com",
      stopReason: "tool_use",
    });
  });

  it("stops pairing a spool line once a call more than the window newer has arrived", () => {
    const store = createStore();
    store.addRequest(route({ id: "early-route", ts: T }));
    storm(store, 3); // the second of these is already past the early line's window
    store.addRequest(transcript({ id: "late-echo", ts: T + 5_000 }));
    const rows = store.requests({ limit: 5_000 });
    expect(rows.find((row) => row.id === "early-route")).toMatchObject({ agentId: "main" });
    // the echo stands on its own: its router twin left the window before it arrived
    expect(rows.find((row) => row.id === "late-echo")?.route).toBeUndefined();
  });

  it("forgets a transcript copy's alias once newer pairs have pushed it out of the window", () => {
    const store = createStore();
    store.addRequest(route({ id: "first-route" }));
    store.addRequest(transcript({ id: "first-copy" }));
    for (let at = 1; at <= 600; at += 1) {
      // the alias map holds a bounded window of the newest pairs
      store.addRequest(route({ id: `rr${at}`, ts: T + at * 1_000 }));
      store.addRequest(transcript({ id: `tc${at}`, ts: T + at * 1_000 + 40 }));
    }
    store.addRequest(transcript({ id: "first-copy", ts: T + 2_000 }));
    const rows = store.requests({ limit: 5_000 });
    // the copy no longer folds into the held record: its alias was dropped with the oldest pairs
    expect(rows.filter((row) => row.id === "first-route" || row.id === "first-copy")).toHaveLength(2);
  });
});
