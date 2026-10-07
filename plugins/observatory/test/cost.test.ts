import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADVISOR_LIMITS, advise } from "../src/cost/advisor.ts";
import { attribute, rangeStart, spendSince } from "../src/cost/attribution.ts";
import { createLedger, dayKey, LEDGER_DAYS, ledgerDir, parseDay } from "../src/cost/ledger.ts";
import {
  addCost,
  costOf,
  costOfAll,
  flashOf,
  isSmallModel,
  normalizeModel,
  pluginOf,
  priceOf,
} from "../src/cost/prices.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import { makeEnv, makeRequest, makeTool, writeText } from "./helpers.ts";

const M = { ...ZERO_TOKENS, input: 1_000_000 };
const DAY = 86_400_000;

describe("prices", () => {
  it("normalizes ids and finds rows case-insensitively", () => {
    expect(normalizeModel("zai/GLM-5.3[1m]")).toBe("glm-5.3");
    expect(priceOf("minimax-m3")?.input).toBe(0.3);
    expect(priceOf("claude-opus-5")).toBeNull();
  });

  it("prices every token kind at its own rate and refuses unknown models", () => {
    expect(costOf("glm-5.3", M)).toBeCloseTo(1.4);
    expect(costOf("glm-5.3", { input: 0, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })).toBeCloseTo(4.66);
    expect(costOf("kimi-k3", { ...ZERO_TOKENS, cacheWrite: 1e6 })).toBe(3);
    expect(costOf("claude-sonnet-5-5", M)).toBeNull();
  });

  it("sums costs, treating null as nothing priced and skipping route echoes", () => {
    expect(addCost(null, null)).toBeNull();
    expect(addCost(null, 1)).toBe(1);
    expect(addCost(2, null)).toBe(2);
    expect(addCost(1, 2)).toBe(3);
    expect(costOfAll([])).toBeNull();
    expect(
      costOfAll([
        { model: "glm-5.3", tokens: M },
        { model: "glm-5.3", tokens: M, provider: "route" },
        { model: "claude-x", tokens: M },
      ]),
    ).toBeCloseTo(1.4);
  });

  it("maps models to plugins and to their flash siblings", () => {
    expect(pluginOf("glm-5.3")).toBe("zai");
    expect(pluginOf("kimi-k3")).toBe("kimi");
    expect(pluginOf("deepseek-flash")).toBe("deepseek");
    expect(pluginOf("MiniMax-M3")).toBe("minimax");
    expect(pluginOf("qwen3.8-max")).toBe("qwen");
    expect(pluginOf("claude-opus-5")).toBeNull();
    expect(flashOf("glm-5.3")).toBe("glm-5.3-flash");
    expect(flashOf("claude-opus-5")).toBeNull();
    expect(isSmallModel("glm-5.3-flash")).toBe(true);
    expect(isSmallModel("claude-haiku-5")).toBe(true);
    expect(isSmallModel("glm-5.3")).toBe(false);
  });
});

describe("ledger", () => {
  it("records requests by id, replacing repeats, skipping route echoes and synthetic messages", () => {
    const { env } = makeEnv();
    const now = Date.now();
    const ledger = createLedger(env, () => now);
    ledger.record(makeRequest({ id: "a", ts: now - 1000, model: "glm-5.3", tokens: M }));
    ledger.record(makeRequest({ id: "a", ts: now - 1000, model: "glm-5.3", tokens: { ...M, output: 5 } }));
    ledger.record(makeRequest({ id: "a", ts: now - 1000, model: "glm-5.3", tokens: { ...M, output: 5 } }));
    ledger.record(makeRequest({ id: "r", provider: "route", ts: now }));
    ledger.record(makeRequest({ id: "s", model: "<synthetic>", ts: now }));
    ledger.record(makeRequest({ id: "e", model: "", ts: now }));
    ledger.record(makeRequest({ id: "old", ts: now - (LEDGER_DAYS + 2) * DAY }));
    const rows = ledger.rows(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokens.output).toBe(5);
    expect(ledger.rows(now)).toHaveLength(0);
  });

  it("moves a request that changed day, and flushes 0600 day files a new ledger reads back", () => {
    const { env } = makeEnv();
    const now = Date.now();
    const ledger = createLedger(env, () => now);
    ledger.record(makeRequest({ id: "a", ts: now - 2 * DAY }));
    ledger.record(makeRequest({ id: "a", ts: now }));
    ledger.nameSession("s1", "app", "fix it");
    ledger.nameSession("s1", "app", "fix it");
    ledger.nameAgent("s1", "w1", "explorer");
    ledger.nameAgent("s1", "w1", "explorer");
    const before = ledger.version();
    ledger.flush();
    ledger.flush();
    expect(ledger.version()).toBe(before);
    const files = readdirSync(ledgerDir(env));
    expect(files).toContain(`${dayKey(now)}.json`);
    expect(statSync(join(ledgerDir(env), `${dayKey(now)}.json`)).mode & 0o777).toBe(0o600);
    const again = createLedger(env, () => now);
    expect(again.rows(0).map((r) => r.id)).toEqual(["a"]);
    expect(again.names()).toEqual({
      sessions: { s1: { project: "app", title: "fix it" } },
      agents: { "s1:w1": "explorer" },
    });
  });

  it("prunes days past the window and survives broken files and a missing dir", () => {
    const { env } = makeEnv();
    const now = Date.now();
    const dir = ledgerDir(env);
    writeText(join(dir, `${dayKey(now - (LEDGER_DAYS + 3) * DAY)}.json`), "{}");
    writeText(join(dir, `${dayKey(now - DAY)}.json`), "{broken");
    writeText(join(dir, "notes.txt"), "ignored");
    const ledger = createLedger(env, () => now);
    expect(ledger.rows(0)).toEqual([]);
    // a later clock: yesterday's file falls out of the window too
    const later = createLedger(env, () => now + LEDGER_DAYS * DAY);
    later.record(makeRequest({ id: "x", ts: now + LEDGER_DAYS * DAY }));
    later.flush();
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([
      `${dayKey(now + LEDGER_DAYS * DAY)}.json`,
    ]);
    expect(createLedger({ HOME: "/nonexistent-observatory" }).rows(0)).toEqual([]);
  });

  it("parses only well-formed entries", () => {
    const day = parseDay(
      JSON.stringify({
        rows: { ok: [1, "m", "s", "a", 1, 2, 3, 4], bad: [1, "m"], worse: "x" },
        sessions: { s: { project: "p", title: 3 }, t: null },
        agents: { "s:a": "n", "s:b": 4 },
      }),
    );
    expect(Object.keys(day.rows)).toEqual(["ok"]);
    expect(day.sessions).toEqual({ s: { project: "p", title: null }, t: { project: null, title: null } });
    expect(day.agents).toEqual({ "s:a": "n" });
    expect(parseDay("[]").rows).toEqual({});
  });

  it("never throws when the directory cannot be written", () => {
    const { env, home } = makeEnv();
    writeText(join(home, "state"), "a file where the state dir should be");
    const ledger = createLedger(env);
    ledger.record(makeRequest({ ts: Date.now() }));
    expect(() => ledger.flush()).not.toThrow();
  });
});

describe("attribution", () => {
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  const rows = [
    { id: "1", ts: now - 1000, model: "glm-5.3", sessionId: "s1", agentId: "main", tokens: M },
    { id: "2", ts: now - 2000, model: "glm-5.3", sessionId: "s1", agentId: "w1", tokens: M },
    { id: "3", ts: now - 3000, model: "claude-x", sessionId: "s2", agentId: "main", tokens: M },
    { id: "4", ts: now - 3 * DAY, model: "deepseek-flash", sessionId: "s3", agentId: "w9", tokens: M },
  ];
  const names = { sessions: { s1: { project: "app", title: null } }, agents: { "s1:w1": "explorer" } };

  it("starts today at local midnight and the longer ranges 7 and 30 days back", () => {
    expect(rangeStart("day", now)).toBe(new Date(2026, 9, 8).getTime());
    expect(rangeStart("week", now)).toBe(now - 7 * DAY);
    expect(rangeStart("month", now)).toBe(now - 30 * DAY);
  });

  it("groups by project, session, agent and model, priciest first", () => {
    const byProject = attribute(rows, "project", names, rangeStart("week", now));
    expect(byProject.map((r) => [r.label, r.requests, r.unpriced])).toEqual([
      ["app", 2, 0],
      ["(no project)", 2, 1],
    ]);
    expect(byProject[0]?.costUsd).toBeCloseTo(2.8);
    const bySession = attribute(rows, "session", names, rangeStart("day", now));
    expect(bySession.map((r) => r.label)).toEqual(["app · s1", "s2"]);
    expect(bySession[1]?.costUsd).toBeNull();
    const byAgent = attribute(rows, "agent", names, 0);
    expect(byAgent.map((r) => r.label)).toEqual([
      "main · app · s1",
      "explorer · app · s1",
      "w9 · s3",
      "main · s2",
    ]);
    expect(attribute(rows, "model", names, 0).map((r) => r.key)).toEqual([
      "glm-5.3",
      "deepseek-flash",
      "claude-x",
    ]);
  });

  it("totals what was spent since a moment", () => {
    expect(spendSince(rows, rangeStart("day", now))).toBeCloseTo(2.8);
    expect(spendSince([], 0)).toBeNull();
  });
});

describe("model advisor", () => {
  const small = { ...ZERO_TOKENS, input: 10_000, output: 500 };

  it("finds main-model subagent runs that only read, and prices the flash saving", () => {
    const requests = [
      makeRequest({ id: "1", agentId: "w1", model: "glm-5.3", tokens: small }),
      makeRequest({ id: "2", agentId: "w1", model: "glm-5.3", tokens: small }),
      makeRequest({ id: "3", agentId: "w2", model: "glm-5.3", tokens: small }),
      makeRequest({ id: "4", agentId: "w3", model: "glm-5.3-flash", tokens: small }),
      makeRequest({ id: "5", agentId: "w4", model: "claude-opus-5", tokens: small }),
      makeRequest({ id: "6", agentId: "main", model: "glm-5.3", tokens: small }),
      makeRequest({ id: "7", agentId: "w5", model: "glm-5.3", tokens: small, provider: "route" }),
    ];
    const tools = [
      makeTool({ id: "t1", agentId: "w1", name: "Read" }),
      makeTool({ id: "t2", agentId: "w2", name: "Edit" }),
      makeTool({ id: "t3", agentId: "w4", name: "Grep" }),
      makeTool({ id: "t4", agentId: "nobody", name: "Read" }),
      makeTool({ id: "t5", agentId: null, name: "Read" }),
    ];
    const report = advise(requests, tools);
    expect(report.runsChecked).toBe(3);
    expect(report.candidates).toBe(2);
    expect(report.byModel.map((r) => [r.model, r.runs, r.flash])).toEqual([
      ["claude-opus-5", 1, null],
      ["glm-5.3", 1, "glm-5.3-flash"],
    ]);
    const saving = (costOf("glm-5.3", small) ?? 0) * 2 - (costOf("glm-5.3-flash", small) ?? 0) * 2;
    expect(report.savingUsd).toBeCloseTo(saving);
    expect(report.examples).toHaveLength(2);
  });

  it("skips runs that are too big", () => {
    const many = Array.from({ length: ADVISOR_LIMITS.maxRequests + 1 }, (_, i) =>
      makeRequest({ id: `r${i}`, agentId: "w1", model: "glm-5.3" }),
    );
    expect(advise(many, []).candidates).toBe(0);
    const loud = [makeRequest({ agentId: "w1", model: "glm-5.3", tokens: { ...ZERO_TOKENS, output: 9000 } })];
    expect(advise(loud, [])).toMatchObject({ runsChecked: 1, candidates: 0, savingUsd: null });
  });
});

describe("ledger files", () => {
  it("contain numbers and ids only", () => {
    const { env } = makeEnv();
    const ledger = createLedger(env);
    ledger.record(makeRequest({ ts: Date.now() }));
    ledger.flush();
    const text = readFileSync(join(ledgerDir(env), `${dayKey(Date.now())}.json`), "utf8");
    expect(JSON.parse(text)).toMatchObject({ version: 1, rows: { "req-1": expect.any(Array) } });
  });
});
