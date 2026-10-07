import { defineProvider, type Provider } from "@muhmdraouf/core/domain/provider.ts";

export const MINIMAX_PROVIDER: Provider = defineProvider({
  name: "minimax",
  display: "MiniMax",
  slash: "/minimax:",
  agentPrefix: "minimax:",
  branchPrefix: "minimax/",
  harness: "minimax",
  artifactsEnv: "MINIMAX_ARTIFACTS",
  envPrefix: "MINIMAX",
  catalog: {
    main: { tier: "main", id: "MiniMax-M3", label: "MiniMax M3" },
    flash: { tier: "flash", id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
  },
  tierNames: { main: "minimax", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: { intl: "https://api.minimax.io/anthropic", cn: "https://api.minimax.cn/anthropic" },
  auth: "bearer",
  keyEnv: ["MINIMAX_API_KEY"],
  keyFile: "~/.config/minimax-plugin-cc/env",
  billingUrl: "https://platform.minimax.io/user-center/payment/balance",
  strip: ["context_management"],
  caveats: ["MiniMax ignores context_management"],
  router: {
    port: 18790,
    label: "com.muhmdraouf.minimax-router",
    healthPath: "/minimax-router/health",
    modelPrefixes: ["MiniMax-"],
  },
});
