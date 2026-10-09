import { describe, expect, it } from "vitest";
import { QWEN_PROVIDER } from "../src/provider.ts";

// The naming scheme every provider follows and what no two providers may share are checked across all five plugins in
// core (test/plugins/providers.test.ts); this file pins what is qwen's own.
describe("qwen is the data qwen-plugin-cc ships", () => {
  it("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", () => {
    expect({
      display: QWEN_PROVIDER.display,
      catalog: QWEN_PROVIDER.catalog,
      baseUrl: QWEN_PROVIDER.baseUrl,
      keyEnv: QWEN_PROVIDER.keyEnv,
      billingUrl: QWEN_PROVIDER.billingUrl,
      keysUrl: QWEN_PROVIDER.keysUrl,
      port: QWEN_PROVIDER.router.port,
      modelPrefixes: QWEN_PROVIDER.router.modelPrefixes,
      strip: QWEN_PROVIDER.strip,
      caveats: QWEN_PROVIDER.caveats,
    }).toEqual({
      display: "Alibaba Qwen",
      catalog: {
        main: {
          tier: "main",
          id: "qwen3.8-max",
          label: "Qwen 3.8 Max",
          behavesAs: "claude-opus-5-5",
          defaultEffort: "xhigh",
        },
        flash: {
          tier: "flash",
          id: "qwen3.8-flash",
          label: "Qwen 3.8 Flash",
          behavesAs: "claude-opus-5-5",
          defaultEffort: "xhigh",
        },
      },
      baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
      keyEnv: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
      billingUrl: "https://usercenter2-intl.aliyun.com/billing",
      keysUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
      port: 18791,
      modelPrefixes: ["qwen"],
      strip: ["context_management"],
      caveats: ["Qwen ignores context_management"],
    });
  });
});
