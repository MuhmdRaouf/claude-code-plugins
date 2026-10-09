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
    main: {
      tier: "main",
      id: "qwen3.8-max",
      label: "Qwen 3.8 Max",
      behavesAs: "claude-opus-5-5",
      defaultEffort: "xhigh",
    },
    flash: {
      tier: "flash",
      id: "qwen3.8-flash",
      label: "Qwen 3.8 Flash",
      behavesAs: "claude-opus-5-5",
      defaultEffort: "xhigh",
    },
    // Alibaba Cloud's published figures (2026-10-09, https://help.aliyun.com/zh/model-studio/text-generation-model):
    // both models run a 1M-token window and support thinking mode. No output cap is published for either
    // (https://www.alibabacloud.com/help/en/model-studio/model-pricing), so maxOutputTokens stays unset.
  },
  tierNames: { main: "qwen", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
  auth: "bearer",
  keyEnv: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  keyFile: "~/.config/qwen-plugin-cc/env",
  billingUrl: "https://usercenter2-intl.aliyun.com/billing",
  keysUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
  strip: ["context_management"],
  caveats: ["Qwen ignores context_management"],
  router: {
    port: 18791,
    label: "com.muhmdraouf.qwen-router",
    healthPath: "/qwen-router/health",
    modelPrefixes: ["qwen"],
  },
});
