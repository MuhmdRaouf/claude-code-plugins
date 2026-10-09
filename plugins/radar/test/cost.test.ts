import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADVISOR_LIMITS, advise } from "../src/cost/advisor.ts";
import { attribute, attributionTree, rangeStart, spendSince } from "../src/cost/attribution.ts";
import { createLedger, dayKey, LEDGER_DAYS, ledgerDir, parseDay } from "../src/cost/ledger.ts";
import {
  addCost,
  costByFamily,
  costFamilyOf,
  costOfAll,
  flashOf,
  isSmallModel,
  normalizeModel,
  pluginOf,
  requestCost,
} from "../src/cost/prices.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import { makeEnv, makeRequest, makeTool, writeText } from "./helpers.ts";

const M = { ...ZERO_TOKENS, input: 1_000_000 };
const DAY = 86_400_000;
const ZAI = "https://api.z.ai";

describe("prices", () => {
  it("normalizes ids and finds rows case-insensitively", () => {
    expect(normalizeModel("zai/GLM-5.3[1m]")).toBe("glm-5.3");
    expect(normalizeModel("minimax-m3")).toBe("minimax-m3");
  });

  it("prices a claude request with its 1 h writes, fast mode and US geo", () => {
    // 1 M in, 1 M out, 1 M cache read, 1 M 5 m + 1 M 1 h writes: fast rates 8/40, cache 0.4/10/16, then ×1.1
    const cost = requestCost(
      makeRequest({
        model: "claude-opus-5-5",
        ts: Date.parse("2026-10-08T12:00:00Z"),
        tokens: { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 2e6 },
        cacheWrite1h: 1e6,
        speed: "fast",
        geo: "us",
      }),
    );
    expect(cost?.usd).toBeCloseTo(81.84);
    expect(cost?.detail).toEqual(["Anthropic list", "fast mode", "US geo ×1.1", "1 h cache writes"]);
  });

  it("prices a zai request by its upstream host and every token kind at its own rate", () => {
    // stopReason set: an in-flight record (no stop reason, no output) is never priced
    const cost = requestCost(
      makeRequest({ model: "glm-5.3", upstream: "https://api.z.ai", tokens: M, stopReason: "end_turn" }),
    );
    expect(cost?.usd).toBeCloseTo(1.4);
    expect(cost?.detail).toEqual(["Z.ai list"]);
    const kinds = requestCost(
      makeRequest({
        model: "glm-5.3",
        upstream: "https://api.z.ai",
        tokens: { input: 0, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 },
      }),
    );
    expect(kinds?.usd).toBeCloseTo(4.66);
    const writes = requestCost(
      makeRequest({
        model: "kimi-k3",
        upstream: "https://api.moonshot.ai",
        tokens: { ...ZERO_TOKENS, cacheWrite: 1e6 },
        stopReason: "end_turn",
      }),
    );
    expect(writes?.usd).toBeCloseTo(3);
  });

  it("prices a deepseek request off-peak at half", () => {
    // Saturday 12:00 UTC: outside both weekday peak windows, so the 1.32 input rate bills at half
    const cost = requestCost(
      makeRequest({
        model: "deepseek-v4-pro",
        upstream: "https://api.deepseek.com",
        ts: Date.parse("2026-10-10T12:00:00Z"),
        tokens: M,
        stopReason: "end_turn",
      }),
    );
    expect(cost?.usd).toBeCloseTo(0.66);
    expect(cost?.detail).toEqual(["DeepSeek list", "off-peak ×0.5"]);
  });

  it("leaves what nothing prices at null", () => {
    expect(requestCost(makeRequest({ model: "not-a-model" }))).toBeNull();
    expect(requestCost(makeRequest({ model: "claude-x" }))).toBeNull();
  });

  it("never prices a request still streaming: no stop reason and no output yet", () => {
    expect(requestCost(makeRequest({ model: "glm-5.3", upstream: ZAI, tokens: M }))).toBeNull();
    // the same numbers once the request has finished do price
    expect(
      requestCost(makeRequest({ model: "glm-5.3", upstream: ZAI, tokens: M, stopReason: "end_turn" }))?.usd,
    ).toBeCloseTo(1.4);
  });

  it("sums costs, treating null as nothing priced", () => {
    expect(addCost(null, null)).toBeNull();
    expect(addCost(null, 1)).toBe(1);
    expect(addCost(2, null)).toBe(2);
    expect(addCost(1, 2)).toBe(3);
    expect(costOfAll([])).toBeNull();
    expect(
      costOfAll([
        { model: "glm-5.3", upstream: "https://api.z.ai", ts: 0, tokens: M },
        { model: "claude-x", ts: 0, tokens: M },
      ]),
    ).toBeCloseTo(1.4);
  });

  it("splits a request list's cost by family, each family null until something of it prices", () => {
    expect(costFamilyOf("zai/glm-5.3[1m]")).toBe("glm");
    expect(costFamilyOf("claude-opus-5-5")).toBe("claude");
    expect(costFamilyOf("Opus-5.5")).toBe("claude"); // a sonnet/haiku/opus id reads as Claude's
    expect(costFamilyOf("kimi-k3")).toBe("other");
    expect(costFamilyOf("not-a-model")).toBe("other");
    const split = costByFamily([
      { model: "claude-opus-5-5", upstream: "https://api.anthropic.com", ts: 0, tokens: M },
      { model: "glm-5.3", upstream: "https://api.z.ai", ts: 0, tokens: M },
      { model: "kimi-k3", upstream: "https://api.moonshot.ai", ts: 0, tokens: M },
      { model: "not-a-model", ts: 0, tokens: M }, // unpriced: no family, no sum
    ]);
    expect(split.claude).toBeGreaterThan(0);
    expect(split.glm).toBeCloseTo(1.4);
    expect(split.other).toBeGreaterThan(0);
    // the parts and costOfAll price the very same requests, so they always agree
    expect(addCost(addCost(split.claude, split.glm), split.other)).toBeCloseTo(
      costOfAll([
        { model: "claude-opus-5-5", upstream: "https://api.anthropic.com", ts: 0, tokens: M },
        { model: "glm-5.3", upstream: "https://api.z.ai", ts: 0, tokens: M },
        { model: "kimi-k3", upstream: "https://api.moonshot.ai", ts: 0, tokens: M },
      ]) ?? -1,
    );
    expect(costByFamily([{ model: "not-a-model", ts: 0, tokens: M }])).toEqual({
      claude: null,
      glm: null,
      other: null,
    });
    expect(costByFamily([])).toEqual({ claude: null, glm: null, other: null });
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
  it("records requests by id, replacing repeats and skipping requests with no model", () => {
    const { env } = makeEnv();
    const now = Date.now();
    const ledger = createLedger(env, () => now);
    ledger.record(makeRequest({ id: "a", ts: now - 1000, model: "glm-5.3", tokens: M }));
    ledger.record(makeRequest({ id: "a", ts: now - 1000, model: "glm-5.3", tokens: { ...M, output: 5 } }));
    ledger.record(makeRequest({ id: "a", ts: now - 1000, model: "glm-5.3", tokens: { ...M, output: 5 } }));
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
    ledger.nameSession("s1", {
      project: "app",
      title: "fix it",
      repo: "/w/repo",
      parentSessionId: null,
      name: null,
    });
    ledger.nameSession("s1", {
      project: "app",
      title: "fix it",
      repo: "/w/repo",
      parentSessionId: null,
      name: null,
    });
    ledger.nameAgent("s1", "w1", { name: "explorer", type: "Explore", description: "look around" });
    ledger.nameAgent("s1", "w1", { name: "explorer", type: "Explore", description: "look around" });
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
      sessions: {
        s1: { project: "app", title: "fix it", repo: "/w/repo", parentSessionId: null, name: null },
      },
      agents: { "s1:w1": { name: "explorer", type: "Explore", description: "look around" } },
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
    expect(createLedger({ HOME: "/nonexistent-radar" }).rows(0)).toEqual([]);
  });

  it("parses only well-formed entries, reading an older ledger's bare agent names", () => {
    const day = parseDay(
      JSON.stringify({
        rows: { ok: [1, "m", "s", "a", 1, 2, 3, 4], bad: [1, "m"], worse: "x" },
        sessions: {
          s: { project: "p", title: 3, repo: "/w/r", parentSessionId: "par", name: "n" },
          t: null,
          u: { project: "p", repo: 7 },
        },
        agents: { "s:a": "legacy", "s:b": { name: "renamed", type: "Explore", description: "D" }, "s:c": 4 },
      }),
    );
    expect(Object.keys(day.rows)).toEqual(["ok"]);
    expect(day.sessions).toEqual({
      s: { project: "p", title: null, repo: "/w/r", parentSessionId: "par", name: "n" },
      t: { project: null, title: null, repo: null, parentSessionId: null, name: null },
      u: { project: "p", title: null, repo: null, parentSessionId: null, name: null },
    });
    expect(day.agents).toEqual({
      "s:a": { name: "legacy", type: null, description: null },
      "s:b": { name: "renamed", type: "Explore", description: "D" },
    });
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
  const names = {
    sessions: { s1: { project: "app", title: null, repo: null, parentSessionId: null, name: null } },
    agents: { "s1:w1": { name: "explorer", type: null, description: null } },
  };

  it("starts today at local midnight and the longer ranges 7 and 30 days back", () => {
    expect(rangeStart("day", now)).toBe(new Date(2026, 9, 8).getTime());
    expect(rangeStart("week", now)).toBe(now - 7 * DAY);
    expect(rangeStart("month", now)).toBe(now - 30 * DAY);
  });

  it("groups by repo, project, session, agent and model, priciest first", () => {
    const byRepo = attribute(
      rows,
      "repo",
      {
        ...names,
        sessions: { ...names.sessions, s1: { ...names.sessions.s1, repo: "/Users/raouf/proxbeam" } },
      },
      rangeStart("week", now),
    );
    expect(byRepo.map((r) => [r.key, r.label])).toEqual([
      ["/Users/raouf/proxbeam", "~/proxbeam"],
      ["(no project)", "(no project)"],
    ]);
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

  it("falls back to the project when a session has no repo", () => {
    const mixed = {
      sessions: {
        s1: { project: "app", title: null, repo: null, parentSessionId: null, name: null },
        s2: { project: "site", title: null, repo: "/w/site", parentSessionId: null, name: null },
      },
      agents: {},
    };
    const few = [
      { id: "1", ts: now, model: "glm-5.3", sessionId: "s1", agentId: "main", tokens: M },
      { id: "2", ts: now, model: "glm-5.3", sessionId: "s2", agentId: "main", tokens: M },
    ];
    // equal spend keeps the first-seen group first; the repo-less session rides under its project name
    expect(attribute(few, "repo", mixed, 0).map((r) => [r.key, r.label])).toEqual([
      ["app", "app"],
      ["/w/site", "/w/site"],
    ]);
  });

  it("nests the tree repo → session → agent → model, with jobs under the session that ran them", () => {
    const treeNames = {
      sessions: {
        parent: { project: null, title: null, repo: "/w/repo", parentSessionId: null, name: "the parent" },
        job: { project: null, title: null, repo: "/w/repo", parentSessionId: "parent", name: "the job" },
        loose: { project: null, title: null, repo: "/w/repo", parentSessionId: "ghost", name: "loose job" },
        away: { project: null, title: null, repo: "/w/other", parentSessionId: null, name: null },
      },
      agents: { "parent:w1": { name: "explorer", type: "Explore", description: "read around" } },
    };
    const at = now - 1000;
    const treeRows = [
      { id: "1", ts: at, model: "glm-5.3", sessionId: "parent", agentId: "main", tokens: M },
      { id: "2", ts: at, model: "glm-5.3-flash", sessionId: "parent", agentId: "w1", tokens: M },
      { id: "3", ts: at, model: "kimi-k3", sessionId: "job", agentId: "main", tokens: M },
      { id: "4", ts: at, model: "deepseek-flash", sessionId: "loose", agentId: "main", tokens: M },
      { id: "5", ts: at, model: "claude-x", sessionId: "away", agentId: "main", tokens: M },
    ];
    const tree = attributionTree(treeRows, treeNames, 0);
    expect(tree.map((repo) => [repo.kind, repo.key])).toEqual([
      ["repo", "/w/repo"],
      ["repo", "/w/other"],
    ]);
    const repo = tree[0];
    expect(repo?.requests).toBe(4);
    expect([...(repo?.children.map((s) => s.label) ?? [])].sort()).toEqual(["loose job", "the parent"]);
    const parent = repo?.children.find((s) => s.label === "the parent");
    expect(parent?.requests).toBe(2); // the job's rows stay the job's own: nothing is counted twice
    expect(parent?.children.map((n) => [n.kind, n.label, n.note])).toEqual([
      ["agent", "main", null],
      ["agent", "read around", "Explore"],
      ["session", "the job", null],
    ]);
    const job = parent?.children[2];
    expect(job?.requests).toBe(1);
    expect(job?.children[0]?.children.map((m) => m.label)).toEqual(["kimi-k3"]);
    expect(parent?.mix).toEqual([
      { model: "glm-5.3", tokens: 1_000_000 },
      { model: "glm-5.3-flash", tokens: 1_000_000 },
    ]);
    expect(repo?.mix.map((part) => part.model)).toEqual([
      "deepseek-flash",
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k3",
    ]);
    // an unattached job (its parent is gone) hangs directly under its repo, and models sort by spend
    const loose = repo?.children.find((s) => s.label === "loose job");
    expect(loose?.children[0]?.children.map((m) => m.label)).toEqual(["deepseek-flash"]);
    expect(tree[1]?.children[0]?.children[0]?.children.map((m) => m.label)).toEqual(["claude-x"]);
  });

  it("respects the range in the tree and orders agents main-first, everything by spend", () => {
    const treeNames = {
      sessions: { s1: { project: null, title: null, repo: "/w/repo", parentSessionId: null, name: null } },
      agents: {},
    };
    const treeRows = [
      { id: "1", ts: now - 1000, model: "kimi-k3", sessionId: "s1", agentId: "w2", tokens: M },
      { id: "2", ts: now - 2000, model: "glm-5.3", sessionId: "s1", agentId: "w1", tokens: M },
      { id: "3", ts: now - 3 * DAY, model: "glm-5.3", sessionId: "s1", agentId: "main", tokens: M },
    ];
    const tree = attributionTree(treeRows, treeNames, rangeStart("day", now));
    const session = tree[0]?.children[0];
    expect(session?.children.map((a) => a.label)).toEqual(["w2", "w1"]); // kimi ($3) out-spends glm ($1.40)
    const month = attributionTree(treeRows, treeNames, rangeStart("month", now));
    expect(month[0]?.children[0]?.children.map((a) => a.label)).toEqual(["main", "w2", "w1"]);
  });

  it("keeps a corrupted parent loop from hanging the tree: every member becomes a top row", () => {
    const looped = {
      sessions: {
        s1: { project: null, title: null, repo: "/w/repo", parentSessionId: "s2", name: "a" },
        s2: { project: null, title: null, repo: "/w/repo", parentSessionId: "s1", name: "b" },
      },
      agents: {},
    };
    const one = [
      { id: "1", ts: now, model: "glm-5.3", sessionId: "s1", agentId: "main", tokens: M },
      { id: "2", ts: now, model: "glm-5.3", sessionId: "s2", agentId: "main", tokens: M },
    ];
    const tree = attributionTree(one, looped, 0);
    expect(tree[0]?.children.map((s) => s.label)).toEqual(["a", "b"]);
  });

  it("folds a session's model mix to one entry per model across its agents", () => {
    const names = {
      sessions: { s1: { project: null, title: null, repo: "/w/repo", parentSessionId: null, name: null } },
      agents: {},
    };
    const at = now - 1000;
    const rows = [
      { id: "1", ts: at, model: "glm-5.3", sessionId: "s1", agentId: "main", tokens: M },
      { id: "2", ts: at, model: "glm-5.3", sessionId: "s1", agentId: "w1", tokens: M },
      { id: "3", ts: at, model: "kimi-k3", sessionId: "s1", agentId: "w2", tokens: M },
    ];
    const session = attributionTree(rows, names, 0)[0]?.children[0];
    // two agents behind glm-5.3 are one bar segment carrying both agents' tokens, not two entries
    expect(session?.mix).toEqual([
      { model: "glm-5.3", tokens: 2_000_000 },
      { model: "kimi-k3", tokens: 1_000_000 },
    ]);
    expect(session?.requests).toBe(3);
    expect(session?.tokens).toEqual({ ...ZERO_TOKENS, input: 3_000_000 });
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
      makeRequest({ id: "1", agentId: "w1", model: "glm-5.3", upstream: ZAI, tokens: small }),
      makeRequest({ id: "2", agentId: "w1", model: "glm-5.3", upstream: ZAI, tokens: small }),
      makeRequest({ id: "3", agentId: "w2", model: "glm-5.3", upstream: ZAI, tokens: small }),
      makeRequest({ id: "4", agentId: "w3", model: "glm-5.3-flash", upstream: ZAI, tokens: small }),
      makeRequest({ id: "5", agentId: "w4", model: "claude-opus-5", tokens: small }),
      makeRequest({ id: "6", agentId: "main", model: "glm-5.3", upstream: ZAI, tokens: small }),
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
    const glmCost = requestCost(makeRequest({ model: "glm-5.3", upstream: ZAI, tokens: small }))?.usd ?? 0;
    const flashCost =
      requestCost(makeRequest({ model: "glm-5.3-flash", upstream: ZAI, tokens: small }))?.usd ?? 0;
    const saving = glmCost * 2 - flashCost * 2;
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

  it("round-trip a request's pricing fields beside its tokens", () => {
    const { env } = makeEnv();
    const ledger = createLedger(env);
    ledger.record(
      makeRequest({
        ts: Date.now(),
        tokens: { ...ZERO_TOKENS, input: 10, cacheWrite: 6 },
        cacheWrite1h: 2,
        speed: "fast",
        geo: "us",
        serviceTier: "priority",
      }),
    );
    ledger.record(makeRequest({ id: "req-2", ts: Date.now() }));
    ledger.flush();
    const rows = ledger.rows(0);
    expect(rows.find((r) => r.id === "req-1")).toMatchObject({
      tokens: { input: 10, cacheWrite: 6 },
      cacheWrite1h: 2,
      speed: "fast",
      geo: "us",
      serviceTier: "priority",
    });
    // a request that said nothing reads back with the fields absent, not null
    expect(rows.find((r) => r.id === "req-2")?.cacheWrite1h).toBeUndefined();
    expect(rows.find((r) => r.id === "req-2")?.speed).toBeUndefined();
  });

  it("still read an old eight-slot row, pricing it from the model alone", () => {
    const { env } = makeEnv();
    writeText(
      join(ledgerDir(env), `${dayKey(Date.now())}.json`),
      JSON.stringify({
        version: 1,
        rows: { "old-1": [Date.now(), "claude-opus-5-5", "s1", "main", 1_000_000, 0, 0, 0] },
        sessions: {},
        agents: {},
      }),
    );
    const ledger = createLedger(env);
    const rows = ledger.rows(0);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ id: "old-1", model: "claude-opus-5-5", tokens: { input: 1_000_000 } });
    expect(row?.cacheWrite1h).toBeUndefined();
    expect(row?.speed).toBeUndefined();
    // priced through the model-id fallback: opus-5-5 is 4/M input, and no condition applies without a record
    expect(row === undefined ? null : requestCost(row)?.usd).toBeCloseTo(4);
  });
});
