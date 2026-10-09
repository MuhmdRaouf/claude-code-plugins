import { describe, expect, it } from "vitest";
import { DEEPSEEK_PROVIDER } from "../src/provider.ts";

// The naming scheme every provider follows and what no two providers may share are checked across all five plugins in
// core (test/plugins/providers.test.ts); this file pins what is deepseek's own.
describe("deepseek is the data deepseek-plugin-cc ships", () => {
  it("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", () => {
    expect({
      display: DEEPSEEK_PROVIDER.display,
      catalog: DEEPSEEK_PROVIDER.catalog,
      baseUrl: DEEPSEEK_PROVIDER.baseUrl,
      keyEnv: DEEPSEEK_PROVIDER.keyEnv,
      billingUrl: DEEPSEEK_PROVIDER.billingUrl,
      keysUrl: DEEPSEEK_PROVIDER.keysUrl,
      port: DEEPSEEK_PROVIDER.router.port,
      modelPrefixes: DEEPSEEK_PROVIDER.router.modelPrefixes,
      strip: DEEPSEEK_PROVIDER.strip,
      caveats: DEEPSEEK_PROVIDER.caveats,
    }).toEqual({
      display: "DeepSeek",
      catalog: {
        main: {
          tier: "main",
          id: "deepseek-v4-pro",
          label: "DeepSeek V4 Pro",
          behavesAs: "claude-opus-5-5",
          maxOutputTokens: 393216,
          defaultEffort: "xhigh",
        },
        flash: {
          tier: "flash",
          id: "deepseek-flash",
          label: "DeepSeek Flash",
          behavesAs: "claude-opus-5-5",
          maxOutputTokens: 393216,
          defaultEffort: "xhigh",
        },
      },
      baseUrl: "https://api.deepseek.com/anthropic",
      keyEnv: ["DEEPSEEK_API_KEY"],
      billingUrl: "https://platform.deepseek.com/top_up",
      keysUrl: "https://platform.deepseek.com/api_keys",
      port: 18789,
      modelPrefixes: ["deepseek-"],
      strip: ["cache_control"],
      caveats: ["DeepSeek ignores cache_control"],
    });
  });
});
