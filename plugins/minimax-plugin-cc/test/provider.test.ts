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
      keysUrl: MINIMAX_PROVIDER.keysUrl,
      port: MINIMAX_PROVIDER.router.port,
      modelPrefixes: MINIMAX_PROVIDER.router.modelPrefixes,
      strip: MINIMAX_PROVIDER.strip,
      caveats: MINIMAX_PROVIDER.caveats,
      defaultTier: MINIMAX_PROVIDER.defaultTier,
      pingTier: MINIMAX_PROVIDER.pingTier,
    }).toEqual({
      display: "MiniMax",
      catalog: {
        main: {
          tier: "main",
          id: "MiniMax-M3",
          label: "MiniMax M3",
          behavesAs: "claude-opus-5-5",
          defaultEffort: "xhigh",
        },
        flash: {
          tier: "flash",
          id: "MiniMax-M2.7-highspeed",
          label: "MiniMax M2.7 Highspeed",
          defaultEffort: "xhigh",
        },
      },
      baseUrl: "https://api.minimax.io/anthropic",
      keyEnv: ["MINIMAX_API_KEY"],
      billingUrl: "https://platform.minimax.io/user-center/payment/balance",
      keysUrl: "https://platform.minimax.io/console/access",
      port: 18790,
      modelPrefixes: ["MiniMax-"],
      strip: ["context_management"],
      caveats: ["MiniMax ignores context_management"],
      // The price sheet (core's prices.ts, read off MiniMax's page) bills highspeed at twice M3 from the first
      // token, so the owner's call is: default work and the setup ping run on M3, highspeed is the fast tier.
      defaultTier: { edit: "main", exec: "main", readonly: "main" },
      pingTier: "main",
    });
  });
});
