import { describe, expect, it } from "vitest";
import { KIMI_PROVIDER } from "../src/provider.ts";

// The naming scheme every provider follows and what no two providers may share are checked across all five plugins in
// core (test/plugins/providers.test.ts); this file pins what is kimi's own.
describe("kimi is the data kimi-plugin-cc ships", () => {
  it("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", () => {
    expect({
      display: KIMI_PROVIDER.display,
      catalog: KIMI_PROVIDER.catalog,
      baseUrl: KIMI_PROVIDER.baseUrl,
      keyEnv: KIMI_PROVIDER.keyEnv,
      billingUrl: KIMI_PROVIDER.billingUrl,
      keysUrl: KIMI_PROVIDER.keysUrl,
      port: KIMI_PROVIDER.router.port,
      modelPrefixes: KIMI_PROVIDER.router.modelPrefixes,
      strip: KIMI_PROVIDER.strip,
      caveats: KIMI_PROVIDER.caveats,
    }).toEqual({
      display: "Moonshot Kimi",
      catalog: {
        main: {
          tier: "main",
          id: "kimi-k3",
          label: "Kimi K3",
          behavesAs: "claude-opus-5-5",
          maxOutputTokens: 1048576,
          defaultEffort: "xhigh",
        },
        flash: { tier: "flash", id: "kimi-k2.6", label: "Kimi K2.6" },
      },
      baseUrl: "https://api.moonshot.ai/anthropic",
      keyEnv: ["KIMI_API_KEY"],
      billingUrl: "https://platform.kimi.ai/console",
      keysUrl: "https://platform.kimi.ai/console/api-keys",
      port: 18788,
      modelPrefixes: ["kimi-"],
      strip: [],
      caveats: [],
    });
  });
});
