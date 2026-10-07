import { describe, expect, it } from "vitest";
import { ENGINE_TOOLS, ENGINES, isEngine, isEngineTool } from "../../src/domain/engine.ts";

describe("engines", () => {
  it("claude plus the three delegation tools", () => {
    expect(ENGINES).toEqual(["claude", "omp", "opencode", "pi"]);
    expect(ENGINE_TOOLS).toEqual(["omp", "opencode", "pi"]);
    expect(isEngine("claude")).toBe(true);
    expect(isEngine("cursor")).toBe(false);
    expect(isEngine(3)).toBe(false);
    expect(isEngineTool("claude")).toBe(false);
    expect(isEngineTool("pi")).toBe(true);
  });
});
