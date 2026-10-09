import { describe, expect, it } from "vitest";
import { modelColor, modelKey } from "../src/model-color.ts";

describe("modelKey", () => {
  it("recognises every family, case-insensitively and as a substring", () => {
    expect(modelKey("claude-opus-4-6")).toBe("opus");
    expect(modelKey("Claude Sonnet 4.5")).toBe("sonnet");
    expect(modelKey("claude-haiku-4-5")).toBe("haiku");
    expect(modelKey("glm-5.3")).toBe("glm");
    expect(modelKey("GLM-5.3-Flash")).toBe("glm-flash");
    expect(modelKey("Kimi-K2-Thinking")).toBe("kimi");
    expect(modelKey("kimi-k2")).toBe("kimi");
    expect(modelKey("moonshot-v1-8k")).toBe("kimi");
    expect(modelKey("deepseek-chat")).toBe("deepseek");
    expect(modelKey("MiniMax-M2")).toBe("minimax");
    expect(modelKey("qwen3-max")).toBe("qwen");
  });

  it("puts a glm model with flash in the glm-flash family, not glm", () => {
    expect(modelKey("glm-5.3-flash")).toBe("glm-flash");
    expect(modelKey("glm-flash")).toBe("glm-flash");
  });

  it("falls back to other for unknown or empty names", () => {
    expect(modelKey("gpt-5")).toBe("other");
    expect(modelKey("")).toBe("other");
  });
});

describe("modelColor", () => {
  it("returns the family's custom property as a var() reference", () => {
    expect(modelColor("claude-opus-4-6")).toBe("var(--model-opus)");
    expect(modelColor("glm-5.3-flash")).toBe("var(--model-glm-flash)");
    expect(modelColor("gpt-5")).toBe("var(--model-other)");
  });
});
