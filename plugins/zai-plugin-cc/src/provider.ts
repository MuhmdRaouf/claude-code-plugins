import { defineProvider, type Provider } from "@muhmdraouf/core/domain/provider.ts";

export const ZAI_PROVIDER: Provider = defineProvider({
  name: "zai",
  display: "Z.ai GLM",
  slash: "/zai:",
  agentPrefix: "zai:",
  branchPrefix: "zai/",
  harness: "zai",
  artifactsEnv: "ZAI_ARTIFACTS",
  envPrefix: "ZAI",
  catalog: {
    main: { tier: "main", id: "glm-5.3", label: "GLM 5.3" },
    flash: { tier: "flash", id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
  },
  tierNames: { main: "glm", flash: "flash" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: { intl: "https://api.z.ai/api/anthropic", cn: "https://open.bigmodel.cn/api/anthropic" },
  auth: "bearer",
  keyEnv: ["ZAI_API_KEY"],
  keyFile: "~/.config/zai-plugin-cc/env",
  billingUrl: "https://z.ai/manage-apikey/billing",
  strip: [],
  caveats: [],
  router: {
    port: 18787,
    label: "dev.muhmdraouf.zai-router",
    healthPath: "/zai-router/health",
    modelPrefixes: ["glm-"],
  },
});
