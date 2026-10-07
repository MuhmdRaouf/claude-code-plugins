import { defineProvider, type Provider } from "@muhmdraouf/core/domain/provider.ts";

export const KIMI_PROVIDER: Provider = defineProvider({
  name: "kimi",
  display: "Moonshot Kimi",
  slash: "/kimi:",
  agentPrefix: "kimi:",
  branchPrefix: "kimi/",
  harness: "kimi",
  artifactsEnv: "KIMI_ARTIFACTS",
  envPrefix: "KIMI",
  catalog: {
    main: { tier: "main", id: "kimi-k3", label: "Kimi K3" },
    flash: { tier: "flash", id: "kimi-k2.6", label: "Kimi K2.6" },
  },
  tierNames: { main: "kimi", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: { intl: "https://api.moonshot.ai/anthropic" },
  auth: "bearer",
  keyEnv: ["KIMI_API_KEY"],
  keyFile: "~/.config/kimi-plugin-cc/env",
  billingUrl: "https://platform.kimi.ai/console",
  strip: [],
  caveats: [],
  router: {
    port: 18788,
    label: "com.muhmdraouf.kimi-router",
    healthPath: "/kimi-router/health",
    modelPrefixes: ["kimi-"],
  },
});
