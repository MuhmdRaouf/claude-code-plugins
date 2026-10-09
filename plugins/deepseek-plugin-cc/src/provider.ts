import { defineProvider, type Provider } from "@muhmdraouf/core/domain/provider.ts";

export const DEEPSEEK_PROVIDER: Provider = defineProvider({
  name: "deepseek",
  display: "DeepSeek",
  slash: "/deepseek:",
  agentPrefix: "deepseek:",
  branchPrefix: "deepseek/",
  harness: "deepseek",
  artifactsEnv: "DEEPSEEK_ARTIFACTS",
  envPrefix: "DEEPSEEK",
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
    // DeepSeek's published figures (2026-10-09, https://api-docs.deepseek.com/quick_start/pricing): both models
    // carry a 1M context length and a "MAXIMUM: 384K" output, and run in thinking mode by default.
  },
  tierNames: { main: "deepseek", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: "https://api.deepseek.com/anthropic",
  auth: "bearer",
  keyEnv: ["DEEPSEEK_API_KEY"],
  keyFile: "~/.config/deepseek-plugin-cc/env",
  billingUrl: "https://platform.deepseek.com/top_up",
  keysUrl: "https://platform.deepseek.com/api_keys",
  strip: ["cache_control"],
  caveats: ["DeepSeek ignores cache_control"],
  router: {
    port: 18789,
    label: "com.muhmdraouf.deepseek-router",
    healthPath: "/deepseek-router/health",
    modelPrefixes: ["deepseek-"],
  },
});
