import { defineProvider, type Provider } from "@muhmdraouf/core/domain/provider.ts";

export const QWEN_PROVIDER: Provider = defineProvider({
  name: "qwen",
  display: "Alibaba Qwen",
  slash: "/qwen:",
  agentPrefix: "qwen:",
  branchPrefix: "qwen/",
  harness: "qwen",
  artifactsEnv: "QWEN_ARTIFACTS",
  envPrefix: "QWEN",
  catalog: {
    main: { tier: "main", id: "qwen3.8-max", label: "Qwen 3.8 Max" },
    flash: { tier: "flash", id: "qwen3.8-flash", label: "Qwen 3.8 Flash" },
  },
  tierNames: { main: "qwen", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: { intl: "https://dashscope-intl.aliyuncs.com/apps/anthropic" },
  auth: "bearer",
  keyEnv: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  keyFile: "~/.config/qwen-plugin-cc/env",
  billingUrl: "https://usercenter2-intl.aliyun.com/billing",
  strip: ["context_management"],
  caveats: ["Qwen ignores context_management"],
  router: {
    port: 18791,
    label: "com.muhmdraouf.qwen-router",
    healthPath: "/qwen-router/health",
    modelPrefixes: ["qwen"],
  },
});
