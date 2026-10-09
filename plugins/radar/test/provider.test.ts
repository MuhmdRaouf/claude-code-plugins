import { describe, expect, it } from "vitest";
import { DEFAULT_UPSTREAM, providerOf, upstreamHost } from "../src/shared/provider.ts";

describe("providerOf", () => {
  it("groups model ids by prefix, case-insensitively", () => {
    expect(providerOf("claude-opus-5-5")).toBe("Anthropic");
    expect(providerOf("GLM-4.7")).toBe("Z.ai");
    expect(providerOf("kimi-k2")).toBe("Moonshot");
    expect(providerOf("deepseek-v4")).toBe("DeepSeek");
    expect(providerOf("MiniMax-M2")).toBe("MiniMax");
    expect(providerOf("qwen3-max")).toBe("Qwen");
    expect(providerOf("QwQ-32B")).toBe("Qwen");
  });

  it("falls back to other for anything unknown, missing or empty", () => {
    expect(providerOf("gpt-9")).toBe("other");
    expect(providerOf("")).toBe("other");
    expect(providerOf(undefined)).toBe("other");
    expect(providerOf(null)).toBe("other");
  });
});

describe("DEFAULT_UPSTREAM", () => {
  it("is the Anthropic API", () => {
    expect(DEFAULT_UPSTREAM).toBe("https://api.anthropic.com");
  });
});

describe("upstreamHost", () => {
  it("shows a host for a URL and the raw value for something unparseable", () => {
    expect(upstreamHost("https://api.anthropic.com")).toBe("api.anthropic.com");
    expect(upstreamHost("http://localhost:8787/v1")).toBe("localhost:8787");
    expect(upstreamHost("not a url at all")).toBe("not a url at all");
  });

  it("names a request with no upstream as a direct Claude Code call", () => {
    expect(upstreamHost("")).toBe("Claude Code direct (no router)");
    expect(upstreamHost(undefined)).toBe("Claude Code direct (no router)");
    expect(upstreamHost(null)).toBe("Claude Code direct (no router)");
  });
});
