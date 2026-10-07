import { describe, expect, it } from "vitest";
import { MINIMAX_PROVIDER } from "../src/provider.ts";

// The naming scheme every provider follows and what no two providers may share are checked across all five plugins in
// core (test/plugins/providers.test.ts); this file pins what is minimax's own.
describe("minimax is the data minimax-plugin-cc ships", () => {
  it("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", () => {
    expect({
      display: MINIMAX_PROVIDER.display,
      catalog: MINIMAX_PROVIDER.catalog,
      baseUrl: MINIMAX_PROVIDER.baseUrl,
      keyEnv: MINIMAX_PROVIDER.keyEnv,
      billingUrl: MINIMAX_PROVIDER.billingUrl,
      port: MINIMAX_PROVIDER.router.port,
      modelPrefixes: MINIMAX_PROVIDER.router.modelPrefixes,
      strip: MINIMAX_PROVIDER.strip,
      caveats: MINIMAX_PROVIDER.caveats,
    }).toEqual({
      display: "MiniMax",
      catalog: {
        main: { tier: "main", id: "MiniMax-M3", label: "MiniMax M3" },
        flash: { tier: "flash", id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
      },
      baseUrl: { intl: "https://api.minimax.io/anthropic", cn: "https://api.minimax.cn/anthropic" },
      keyEnv: ["MINIMAX_API_KEY"],
      billingUrl: "https://platform.minimax.io/user-center/payment/balance",
      port: 18790,
      modelPrefixes: ["MiniMax-"],
      strip: ["context_management"],
      caveats: ["MiniMax ignores context_management"],
    });
  });
});
