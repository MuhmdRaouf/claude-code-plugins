import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  budgetStatusPath,
  budgetsPath,
  computeStatus,
  inScope,
  periodStart,
  readBudgets,
  spendFor,
  validateBudget,
  validateBudgets,
  writeBudgets,
  writeStatus,
} from "../src/budget/budgets.ts";
import type { LedgerRow } from "../src/cost/ledger.ts";
import {
  DEFAULT_SETTINGS,
  readDismissed,
  readSettings,
  validateSettings,
  writeDismissed,
  writeSettings,
} from "../src/server/settings.ts";
import { ZERO_TOKENS } from "../src/shared/model.ts";
import { pluginLabel, scopeLabel } from "../src/shared/provider.ts";
import { makeEnv, writeText } from "./helpers.ts";

const NOW = new Date(2026, 9, 8, 15, 0).getTime(); // a Thursday
const M = { ...ZERO_TOKENS, input: 1_000_000 };
const row = (id: string, ts: number, model: string): LedgerRow => ({
  id,
  ts,
  model,
  sessionId: "s",
  agentId: "main",
  tokens: M,
});

describe("budget validation", () => {
  const good = { id: "b1", scope: "provider:zai", period: "day", limitUsd: 5.555, action: "stop" };

  it("accepts a well-formed budget and rounds the limit to cents", () => {
    expect(validateBudget(good)).toEqual({ ...good, limitUsd: 5.56 });
    expect(validateBudget({ ...good, scope: "total" })).toMatchObject({ scope: "total" });
  });

  it("says what is wrong with a bad one", () => {
    expect(validateBudget(null)).toMatch(/object/);
    expect(validateBudget({ ...good, id: "has space" })).toMatch(/id/);
    expect(validateBudget({ ...good, scope: "provider:" })).toMatch(/scope/);
    expect(validateBudget({ ...good, scope: "zai" })).toMatch(/scope/);
    expect(validateBudget({ ...good, period: "year" })).toMatch(/period/);
    expect(validateBudget({ ...good, limitUsd: 0 })).toMatch(/limitUsd/);
    expect(validateBudget({ ...good, limitUsd: "5" })).toMatch(/limitUsd/);
    expect(validateBudget({ ...good, action: "block" })).toMatch(/action/);
  });

  it("validates whole lists: shape, size and duplicate ids", () => {
    expect(validateBudgets({ budgets: [good] })).toHaveLength(1);
    expect(validateBudgets([good])).toHaveLength(1);
    expect(validateBudgets({})).toMatch(/budgets/);
    expect(validateBudgets("x")).toMatch(/budgets/);
    expect(validateBudgets([good, good])).toMatch(/duplicate/);
    expect(validateBudgets([good, { ...good, id: "b2", period: "x" }])).toMatch(/^budget 2: period/);
    expect(validateBudgets(Array.from({ length: 51 }, (_, i) => ({ ...good, id: `b${i}` })))).toMatch(
      /at most/,
    );
  });
});

describe("budgets.json", () => {
  it("is absent by default, written 0600 and atomically, and read back tolerantly", () => {
    const { env } = makeEnv();
    expect(readBudgets(env)).toEqual([]);
    writeBudgets(env, [{ id: "b1", scope: "total", period: "month", limitUsd: 10, action: "warn" }]);
    expect(statSync(budgetsPath(env)).mode & 0o777).toBe(0o600);
    expect(readBudgets(env)).toHaveLength(1);
    writeText(
      budgetsPath(env),
      JSON.stringify({
        budgets: [
          { id: "b1", scope: "total", period: "month", limitUsd: 10, action: "warn" },
          { id: "b1", scope: "total", period: "day", limitUsd: 1, action: "warn" },
          { id: "bad" },
        ],
      }),
    );
    expect(readBudgets(env).map((b) => b.period)).toEqual(["month"]);
    writeText(budgetsPath(env), "{oops");
    expect(readBudgets(env)).toEqual([]);
    writeText(budgetsPath(env), JSON.stringify({ budgets: "no" }));
    expect(readBudgets(env)).toEqual([]);
  });
});

describe("spend", () => {
  it("starts periods at local midnight, Monday and the 1st", () => {
    expect(periodStart("day", NOW)).toBe(new Date(2026, 9, 8).getTime());
    expect(periodStart("week", NOW)).toBe(new Date(2026, 9, 5).getTime());
    expect(periodStart("week", new Date(2026, 9, 11, 9).getTime())).toBe(new Date(2026, 9, 5).getTime());
    expect(periodStart("month", NOW)).toBe(new Date(2026, 9, 1).getTime());
  });

  it("counts a provider scope's own models and the total scope every priced one", () => {
    expect(inScope("total", "claude-x")).toBe(true);
    expect(inScope("provider:zai", "glm-5.3")).toBe(true);
    expect(inScope("provider:zai", "kimi-k3")).toBe(false);
    expect(inScope("provider:zai", "claude-x")).toBe(false);
  });

  it("sums the current period only and reports a percentage", () => {
    const rows = [
      row("a", NOW - 1000, "glm-5.3"),
      row("b", NOW - 2 * 86_400_000, "glm-5.3"),
      row("c", NOW - 1000, "kimi-k3"),
      row("d", NOW - 1000, "claude-x"),
      row("e", NOW + 1000, "glm-5.3"),
    ];
    const zai = spendFor(
      { id: "z", scope: "provider:zai", period: "day", limitUsd: 2, action: "stop" },
      rows,
      NOW,
    );
    expect(zai).toMatchObject({ spentUsd: 1.4, pct: 70, periodStart: new Date(2026, 9, 8).getTime() });
    const total = spendFor(
      { id: "t", scope: "total", period: "month", limitUsd: 4, action: "warn" },
      rows,
      NOW,
    );
    expect(total.spentUsd).toBeCloseTo(5.8);
    const none = spendFor(
      { id: "n", scope: "provider:qwen", period: "day", limitUsd: 1, action: "warn" },
      rows,
      NOW,
    );
    expect(none).toMatchObject({ spentUsd: 0, pct: 0 });
  });

  it("lists a stop budget's scope as stopped at 100%, never a warn budget's", () => {
    const rows = [row("a", NOW - 1000, "glm-5.3")];
    const status = computeStatus(
      [
        { id: "z", scope: "provider:zai", period: "day", limitUsd: 1, action: "stop" },
        { id: "z2", scope: "provider:zai", period: "week", limitUsd: 1, action: "stop" },
        { id: "t", scope: "total", period: "day", limitUsd: 1, action: "warn" },
        { id: "k", scope: "provider:kimi", period: "day", limitUsd: 1, action: "stop" },
      ],
      rows,
      NOW,
    );
    expect(status).toMatchObject({ version: 1, updatedAt: NOW, stopped: ["provider:zai"] });
    expect(status.spend.map((s) => s.id)).toEqual(["z", "z2", "t", "k"]);
  });

  it("publishes budget-status.json 0600 and reports a failed write", () => {
    const { env, home } = makeEnv();
    const status = computeStatus([], [], NOW);
    expect(writeStatus(env, status)).toBe(true);
    expect(JSON.parse(readFileSync(budgetStatusPath(env), "utf8"))).toEqual(status);
    expect(statSync(budgetStatusPath(env)).mode & 0o777).toBe(0o600);
    writeText(`${home}/blocked`, "file");
    expect(writeStatus({ ...env, OBSERVATORY_HOME: `${home}/blocked/state` }, status)).toBe(false);
  });
});

describe("settings and dismissals", () => {
  it("defaults to notifications on and validates updates", () => {
    const { env } = makeEnv();
    expect(readSettings(env)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings({ notifications: false }, DEFAULT_SETTINGS)).toEqual({ notifications: false });
    expect(validateSettings({ notifications: "no" }, DEFAULT_SETTINGS)).toMatch(/true or false/);
    expect(validateSettings({ theme: 1 }, DEFAULT_SETTINGS)).toMatch(/unknown/);
    expect(validateSettings([], DEFAULT_SETTINGS)).toMatch(/object/);
    writeSettings(env, { notifications: false });
    expect(readSettings(env)).toEqual({ notifications: false });
  });

  it("keeps dismissals for a week", () => {
    const { env } = makeEnv();
    expect(readDismissed(env, NOW).size).toBe(0);
    writeDismissed(
      env,
      new Map([
        ["fresh", NOW - 1000],
        ["old", NOW - 8 * 86_400_000],
      ]),
    );
    expect([...readDismissed(env, NOW).keys()]).toEqual(["fresh"]);
  });

  it("names scopes and plugins for people", () => {
    expect(scopeLabel("total")).toBe("Total");
    expect(scopeLabel("provider:zai")).toBe("Z.ai");
    expect(scopeLabel("provider:acme")).toBe("acme");
    expect(scopeLabel("odd")).toBe("odd");
    expect(pluginLabel("deepseek")).toBe("DeepSeek");
  });
});
