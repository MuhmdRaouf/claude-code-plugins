import { describe, expect, it } from "vitest";
import type { AlertKind } from "../src/alerts/engine.ts";
import { ICONS } from "../src/ui/icons.ts";
import {
  alertLabel,
  budgetTone,
  eventMeta,
  latencyClass,
  modelColor,
  providerColor,
  STATUS_COLOR,
  TOKEN_KINDS,
} from "../src/ui/palette.ts";

describe("TOKEN_KINDS", () => {
  it("gives each token kind its own series colour and a readable label", () => {
    expect(TOKEN_KINDS.map((kind) => kind.key)).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
    expect(TOKEN_KINDS.map((kind) => kind.label)).toEqual(["Input", "Output", "Cache read", "Cache write"]);
    expect(new Set(TOKEN_KINDS.map((kind) => kind.color)).size).toBe(4);
    for (const kind of TOKEN_KINDS) expect(kind.color).toMatch(/^var\(--series-\d\)$/);
  });
});

describe("latencyClass", () => {
  it("is success under 60% of budget, warning under 80%, danger at or beyond", () => {
    expect(latencyClass(0)).toBe("var(--success)");
    expect(latencyClass(0.59)).toBe("var(--success)");
    expect(latencyClass(0.6)).toBe("var(--warning)");
    expect(latencyClass(0.79)).toBe("var(--warning)");
    expect(latencyClass(0.8)).toBe("var(--danger)");
    expect(latencyClass(1.4)).toBe("var(--danger)");
  });
});

describe("STATUS_COLOR", () => {
  it("maps every tone to a semantic token", () => {
    expect(Object.keys(STATUS_COLOR).sort()).toEqual(["err", "idle", "info", "ok", "warn"]);
    expect(STATUS_COLOR.ok).toBe("var(--success)");
    expect(STATUS_COLOR.err).toBe("var(--danger)");
    expect(STATUS_COLOR.warn).toBe("var(--warning)");
    expect(STATUS_COLOR.info).toBe("var(--info)");
    expect(STATUS_COLOR.idle).toBe("var(--muted)");
  });
});

describe("eventMeta", () => {
  it("maps every hook event and route to an icon, a tone and plain words", () => {
    expect(eventMeta("SessionStart")).toEqual({ icon: "play", tone: "ok", label: "Session started" });
    expect(eventMeta("SessionEnd")).toEqual({ icon: "stop", tone: "idle", label: "Session ended" });
    expect(eventMeta("UserPromptSubmit")).toEqual({ icon: "message", tone: "info", label: "Prompt" });
    expect(eventMeta("PreToolUse")).toEqual({ icon: "wrench", tone: "info", label: "Tool started" });
    expect(eventMeta("PostToolUse")).toEqual({ icon: "check", tone: "ok", label: "Tool finished" });
    expect(eventMeta("PostToolUseFailure")).toEqual({ icon: "close", tone: "err", label: "Tool failed" });
    expect(eventMeta("SubagentStart")).toEqual({ icon: "branch", tone: "info", label: "Subagent started" });
    expect(eventMeta("SubagentStop")).toEqual({ icon: "merge", tone: "idle", label: "Subagent finished" });
    expect(eventMeta("Stop")).toEqual({ icon: "pause", tone: "idle", label: "Turn ended" });
    expect(eventMeta("PreCompact")).toEqual({ icon: "fold", tone: "warn", label: "Compacting" });
    expect(eventMeta("Notification")).toEqual({ icon: "bell", tone: "warn", label: "Notification" });
    expect(eventMeta("route")).toEqual({ icon: "arrows", tone: "info", label: "Routed" });
  });

  it("falls back to a neutral dot that keeps the raw kind", () => {
    expect(eventMeta("SomethingNew")).toEqual({ icon: "dot", tone: "idle", label: "SomethingNew" });
    expect(eventMeta("")).toEqual({ icon: "dot", tone: "idle", label: "Event" });
  });

  it("only ever names icons that exist", () => {
    const kinds = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse"];
    for (const kind of [...kinds, "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "x"]) {
      expect(Object.keys(ICONS)).toContain(eventMeta(kind).icon);
    }
  });
});

describe("providerColor", () => {
  it("colours every known provider from the series and falls back for the rest", () => {
    expect(providerColor("Anthropic")).toBe("var(--series-4)");
    expect(providerColor("Z.ai")).toBe("var(--series-1)");
    expect(providerColor("Moonshot")).toBe("var(--series-5)");
    expect(providerColor("DeepSeek")).toBe("var(--series-2)");
    expect(providerColor("MiniMax")).toBe("var(--series-6)");
    expect(providerColor("Qwen")).toBe("var(--series-8)");
    expect(providerColor("route")).toBe("var(--series-1)");
    expect(providerColor("other")).toBe("var(--muted)");
  });

  it("treats missing as other", () => {
    expect(providerColor(null)).toBe("var(--muted)");
    expect(providerColor(undefined)).toBe("var(--muted)");
    expect(providerColor("made-up")).toBe("var(--muted)");
  });
});

describe("modelColor", () => {
  it("stays loyal to a model and spreads several across the series", () => {
    expect(modelColor("glm-5.3")).toBe(modelColor("glm-5.3"));
    for (const color of ["glm-5.3", "claude-opus-5", "kimi-k3", "deepseek-v4-pro", ""].map(modelColor))
      expect(color).toMatch(/^var\(--series-\d\)$/);
    expect(
      new Set(["glm-5.3", "claude-opus-5", "kimi-k3", "deepseek-v4-pro"].map(modelColor)).size,
    ).toBeGreaterThan(1);
  });
});

describe("alertLabel", () => {
  it("names every alert kind in plain words", () => {
    const kinds: AlertKind[] = ["stuck", "loop", "retry_storm", "context", "budget"];
    expect(kinds.map(alertLabel)).toEqual(["Stuck", "Loop", "Retry storm", "Context nearly full", "Budget"]);
  });
});

describe("budgetTone", () => {
  it("is ok under 80% of the budget, warn from there and err at the limit", () => {
    expect(budgetTone(10)).toBe("ok");
    expect(budgetTone(79.9)).toBe("ok");
    expect(budgetTone(80)).toBe("warn");
    expect(budgetTone(99)).toBe("warn");
    expect(budgetTone(100)).toBe("err");
    expect(budgetTone(120)).toBe("err");
  });
});
