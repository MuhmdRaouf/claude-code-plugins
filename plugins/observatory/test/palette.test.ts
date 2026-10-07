import { describe, expect, it } from "vitest";
import { ICON_NAMES } from "../src/ui/icons.ts";
import {
  eventMeta,
  latencyClass,
  providerColor,
  RANGE_MS,
  SERIES,
  STATUS_COLOR,
  TOKEN_KINDS,
} from "../src/ui/palette.ts";

describe("RANGE_MS", () => {
  it("holds the three chart windows", () => {
    expect(RANGE_MS["5m"]).toBe(300_000);
    expect(RANGE_MS["1h"]).toBe(3_600_000);
    expect(RANGE_MS["24h"]).toBe(86_400_000);
  });
});

describe("SERIES and TOKEN_KINDS", () => {
  it("lists the eight semantic series tokens in chart order", () => {
    expect(SERIES).toHaveLength(8);
    expect(SERIES[0]).toBe("var(--series-1)");
    expect(SERIES[7]).toBe("var(--series-8)");
  });

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
      expect(ICON_NAMES).toContain(eventMeta(kind).icon);
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
