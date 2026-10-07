import { describe, expect, it } from "vitest";
import { isClaudeSessionVar, toolEnv } from "../../../../src/adapters/engines/shared/env.ts";
import { reportedModel } from "../../../../src/adapters/engines/shared/model.ts";

describe("toolEnv", () => {
  const withheld = (name: string): boolean => name === "ACME_API_KEY" || name.startsWith("ACME_");
  const reserved = (name: string): boolean => name.startsWith("TOOL_") || name.endsWith("_API_KEY");

  it("passes the user's own environment, minus the plugin's provider and the Claude Code session", () => {
    const env = toolEnv(
      {
        HOME: "/home/user",
        UNSET: undefined,
        OPENAI_API_KEY: "users-own",
        TOOL_CONFIG: "/home/user/.tool",
        ACME_API_KEY: "plugin-key",
        ACME_BASE_URL: "https://acme.test",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:18800",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "big-9",
        CLAUDE_PLUGIN_ROOT: "/plugins/acme",
        CLAUDECODE: "1",
      },
      { GREETING: "hi", TOOL_CONFIG: "/elsewhere", OTHER_API_KEY: "k", ACME_REGION: "cn", CLAUDECODE: "0" },
      withheld,
      reserved,
    );

    expect(env).toEqual({
      HOME: "/home/user",
      OPENAI_API_KEY: "users-own",
      TOOL_CONFIG: "/home/user/.tool",
      GREETING: "hi",
    });
  });

  it("knows Claude Code's routing and session variables from the user's own", () => {
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_ENTRYPOINT",
    ])
      expect(isClaudeSessionVar(name)).toBe(true);
    for (const name of ["ANTHROPIC_API_KEY", "HOME", "CLAUDIA"]) expect(isClaudeSessionVar(name)).toBe(false);
  });
});

describe("reportedModel", () => {
  it("is the tool's own provider and model, as the tool names them", () => {
    expect(reportedModel({ provider: "zai", model: "glm-5.3" })).toBe("zai/glm-5.3");
    expect(reportedModel({ provider: "openrouter", model: "openrouter/qwen" })).toBe("openrouter/qwen");
    expect(reportedModel({ model: "glm-5.3" })).toBe("glm-5.3");
    expect(reportedModel({ provider: "", model: "glm-5.3" })).toBe("glm-5.3");
    expect(reportedModel({ provider: "zai" })).toBeUndefined();
    expect(reportedModel({ provider: "zai", model: "" })).toBeUndefined();
  });
});
