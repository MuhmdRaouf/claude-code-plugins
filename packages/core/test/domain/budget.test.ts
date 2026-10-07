import { describe, expect, it } from "vitest";
import { BUDGET_STALE_MS, budgetMessage, budgetStop, providerScope } from "../../src/domain/budget.ts";

const NOW = 1_800_000_000_000;

const status = (stopped: readonly string[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  updatedAt: NOW - 1000,
  stopped,
  spend: [],
  ...extra,
});

const budgets = (...entries: readonly unknown[]) => ({ version: 1, budgets: entries });

describe("budgetStop: what the observatory's status says about one plugin", () => {
  it("stops a plugin whose own scope is stopped, and every plugin when total is", () => {
    expect(budgetStop("zai", status(["provider:zai"]), undefined, NOW)).toEqual({
      scope: "provider:zai",
      period: undefined,
    });
    expect(budgetStop("kimi", status(["provider:zai"]), undefined, NOW)).toBeUndefined();
    expect(budgetStop("kimi", status(["total"]), undefined, NOW)).toEqual({
      scope: "total",
      period: undefined,
    });
    // The plugin's own scope is named first when both are stopped.
    expect(budgetStop("zai", status(["total", "provider:zai"]), undefined, NOW)?.scope).toBe("provider:zai");
    expect(providerScope("qwen")).toBe("provider:qwen");
  });

  it("stops nothing when the status is missing, unparsable, of another version, or stale either way", () => {
    expect(budgetStop("zai", undefined, undefined, NOW)).toBeUndefined();
    expect(budgetStop("zai", "garbage", undefined, NOW)).toBeUndefined();
    expect(budgetStop("zai", { stopped: ["provider:zai"] }, undefined, NOW)).toBeUndefined();
    expect(budgetStop("zai", status(["provider:zai"], { version: 2 }), undefined, NOW)).toBeUndefined();
    expect(
      budgetStop("zai", status(["provider:zai"], { stopped: "provider:zai" }), undefined, NOW),
    ).toBeUndefined();
    const old = status(["provider:zai"], { updatedAt: NOW - BUDGET_STALE_MS - 1 });
    expect(budgetStop("zai", old, undefined, NOW)).toBeUndefined();
    const fresh = status(["provider:zai"], { updatedAt: NOW - BUDGET_STALE_MS });
    expect(budgetStop("zai", fresh, undefined, NOW)).toBeDefined();
    const future = status(["provider:zai"], { updatedAt: NOW + BUDGET_STALE_MS + 1 });
    expect(budgetStop("zai", future, undefined, NOW)).toBeUndefined();
  });

  it("takes the period from the stop budget that is over, else the scope's first stop budget", () => {
    const set = budgets(
      { id: "w", scope: "provider:zai", period: "week", limitUsd: 5, action: "stop" },
      { id: "warn", scope: "provider:zai", period: "day", limitUsd: 1, action: "warn" },
      { id: "m", scope: "provider:zai", period: "month", limitUsd: 20, action: "stop" },
      { id: "t", scope: "total", period: "day", limitUsd: 9, action: "stop" },
    );
    const over = status(["provider:zai"], { spend: [{ id: "m", spentUsd: 21, limitUsd: 20, pct: 105 }] });
    expect(budgetStop("zai", over, set, NOW)).toEqual({ scope: "provider:zai", period: "month" });
    expect(budgetStop("zai", status(["provider:zai"]), set, NOW)).toEqual({
      scope: "provider:zai",
      period: "week",
    });
    expect(budgetStop("kimi", status(["total"]), set, NOW)).toEqual({ scope: "total", period: "day" });
  });

  it("skips a budget entry that does not parse and keeps the rest; a broken spend list is no spend", () => {
    const set = budgets({ id: "x", scope: "provider:zai", period: "year", action: "stop" }, "nope", {
      id: "d",
      scope: "provider:zai",
      period: "day",
      limitUsd: 1,
      action: "stop",
    });
    expect(budgetStop("zai", status(["provider:zai"], { spend: "bad" }), set, NOW)).toEqual({
      scope: "provider:zai",
      period: "day",
    });
    expect(budgetStop("zai", status(["provider:zai"]), { budgets: "no" }, NOW)?.period).toBeUndefined();
  });

  it("words the refusal the same in every router", () => {
    expect(budgetMessage("Z.ai GLM", { scope: "provider:zai", period: "month" })).toBe(
      "Z.ai GLM budget reached for this month: raise or lift it in the Observatory dashboard (/observatory:open)",
    );
    expect(budgetMessage("Kimi", { scope: "total", period: undefined })).toBe(
      "Kimi budget reached for this period: raise or lift it in the Observatory dashboard (/observatory:open)",
    );
  });
});
