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
    main: { tier: "main", id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    flash: { tier: "flash", id: "deepseek-flash", label: "DeepSeek Flash" },
  },
  tierNames: { main: "deepseek", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: { intl: "https://api.deepseek.com/anthropic" },
  auth: "bearer",
  keyEnv: ["DEEPSEEK_API_KEY"],
  keyFile: "~/.config/deepseek-plugin-cc/env",
  billingUrl: "https://platform.deepseek.com/top_up",
  strip: ["cache_control"],
  caveats: ["DeepSeek ignores cache_control"],
  router: {
    port: 18789,
    label: "com.muhmdraouf.deepseek-router",
    healthPath: "/deepseek-router/health",
    modelPrefixes: ["deepseek-"],
  },
});
