import { defineProvider, type Provider } from "../../../src/domain/provider.ts";

/** The provider the chaos suite's real router processes serve: no shared name with any plugin, every port set by env. */
export const CHAOS_PROVIDER: Provider = defineProvider({
  name: "chaos",
  display: "Chaos Models",
  slash: "/chaos:",
  agentPrefix: "chaos:",
  branchPrefix: "chaos/",
  harness: "chaos",
  artifactsEnv: "CHAOS_ARTIFACTS",
  envPrefix: "CHAOS",
  catalog: {
    main: { tier: "main", id: "chaos-big", label: "Chaos Big" },
    flash: { tier: "flash", id: "chaos-small", label: "Chaos Small" },
  },
  tierNames: { main: "big", flash: "small" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "flash",
  workerLabel: "claude",
  baseUrl: "http://127.0.0.1:9/anthropic",
  auth: "bearer",
  keyEnv: ["CHAOS_API_KEY"],
  keyFile: "~/.config/chaos/env",
  billingUrl: "https://billing.example.test/top-up",
  keysUrl: "https://keys.example.test/api-keys",
  strip: [],
  caveats: [],
  router: {
    port: 9,
    label: "test.chaos-router",
    healthPath: "/chaos-router/health",
    modelPrefixes: ["chaos-"],
  },
});
