// The provider as data: the only provider-specific file, read by the plugin's own tests, by the shared suites in
// @muhmdraouf/plugin-test and by scripts/check-siblings.mjs (which normalises the five against it). The plugin ships
// no runtime source; the plugin-core binary carries its own copy of this data.
export const MINIMAX_PROVIDER = {
  name: "minimax",
  display: "MiniMax",
  slash: "/minimax:",
  agentPrefix: "minimax:",
  branchPrefix: "minimax/",
  harness: "minimax",
  artifactsEnv: "MINIMAX_ARTIFACTS",
  envPrefix: "MINIMAX",
  agents: { main: "MiniMax-M3", flash: "MiniMax-M2.7-highspeed" },
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
    // MiniMax's published figures (2026-10-09, https://platform.minimax.io/docs/api-reference/text-anthropic-api):
    // MiniMax-M3 runs a 1,000,000-token window with thinking off by default (adaptive turns it on);
    // MiniMax-M2.7-highspeed runs 204,800 tokens and cannot stop thinking. No output cap is published for either
    // model (https://platform.minimax.io/docs/guides/models-intro), so maxOutputTokens stays unset. M3 is also the
    // cheaper model per token (https://platform.minimax.io/docs/guides/pricing-paygo), so everything defaults to it.
  },
  tierNames: { main: "minimax", flash: "flash" },
  defaultTier: { edit: "main", exec: "main", readonly: "main" },
  pingTier: "main",
  workerLabel: "claude",
  baseUrl: "https://api.minimax.io/anthropic",
  auth: "bearer",
  keyEnv: ["MINIMAX_API_KEY"],
  keyFile: "~/.config/minimax-plugin-cc/env",
  billingUrl: "https://platform.minimax.io/user-center/payment/balance",
  keysUrl: "https://platform.minimax.io/console/access",
  strip: ["context_management"],
  caveats: ["MiniMax ignores context_management"],
  router: {
    port: 18790,
    label: "com.muhmdraouf.minimax-router",
    healthPath: "/minimax-router/health",
    modelPrefixes: ["MiniMax-"],
  },
};
