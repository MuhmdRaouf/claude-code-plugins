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
    main: {
      tier: "main",
      id: "kimi-k3",
      label: "Kimi K3",
      behavesAs: "claude-opus-5-5",
      maxOutputTokens: 1048576,
      defaultEffort: "xhigh",
    },
    flash: { tier: "flash", id: "kimi-k2.6", label: "Kimi K2.6" },
    // Moonshot's published figures (2026-10-09): kimi-k3 runs a 1,048,576-token window
    // (https://platform.kimi.ai/docs/pricing/chat) and takes max_completion_tokens up to 1048576, with a
    // reasoning_effort of low/high/max and max the default (https://platform.kimi.ai/docs/api/chat). Kimi K2.6
    // runs a 262,144-token window; Moonshot publishes no output cap or effort control for it, so those stay unset.
  },
  tierNames: { main: "kimi", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: "https://api.moonshot.ai/anthropic",
  auth: "bearer",
  keyEnv: ["KIMI_API_KEY"],
  keyFile: "~/.config/kimi-plugin-cc/env",
  billingUrl: "https://platform.kimi.ai/console",
  keysUrl: "https://platform.kimi.ai/console/api-keys",
  strip: [],
  caveats: [],
  router: {
    port: 18788,
    label: "com.muhmdraouf.kimi-router",
    healthPath: "/kimi-router/health",
    modelPrefixes: ["kimi-"],
  },
});
