import type { StateRootRule } from "../../src/adapters/state-root.ts";
import type { WorkerTerms } from "../../src/domain/brief.ts";
import { defineProvider, type Provider } from "../../src/domain/provider.ts";
import type { WorkerCapabilities } from "../../src/ports/index.ts";

/**
 * The shared suites came from zai and assert its output, so they run on a copy of zai's names (the reference provider)
 * and of the claude worker's terms. zai's own tests check its real provider and worker still equal these.
 */
export const REFERENCE_PROVIDER: Provider = defineProvider({
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

/** The reference provider's state-root rule. */
export const REFERENCE_STATE_ROOT: StateRootRule = {
  envVar: "ZAI_STATE_DIR",
  dataPrefix: "zai-",
  xdgName: "zai",
};

/** The reference worker's capabilities: the claude worker's. */
export const REFERENCE_CAPS: WorkerCapabilities = {
  name: "claude-headless",
  sessionKey: "caller",
  nativeSchema: true,
  budget: true,
  efforts: ["low", "high", "max"],
  briefNotes: {
    effort: "passed to claude --effort",
    addDirs: "passed as --add-dir",
    budgetUsd: "passed as --max-budget-usd",
    readonly: "plan mode, read tools only",
  },
};

/** A provider that shares no name with zai: rendering with it proves nothing zai-specific is hardcoded. */
export const ACME_PROVIDER: Provider = defineProvider({
  name: "acme",
  display: "Acme Models",
  slash: "/acme:",
  agentPrefix: "acme:",
  branchPrefix: "acme-jobs/",
  harness: "acme-harness",
  artifactsEnv: "ACME_OUT",
  envPrefix: "ACME",
  catalog: {
    main: { tier: "main", id: "big-model-9", label: "Big Model 9" },
    flash: { tier: "flash", id: "small-model-9", label: "Small Model 9" },
  },
  tierNames: { main: "big", flash: "quick" },
  defaultTier: { edit: "main", exec: "flash", readonly: "flash" },
  pingTier: "main",
  workerLabel: "acmebot",
  baseUrl: { intl: "https://api.acme.test/anthropic", cn: "https://acme.cn.test/anthropic" },
  auth: "bearer",
  keyEnv: ["ACME_API_KEY"],
  keyFile: "~/.config/acme/env",
  billingUrl: "https://billing.example.test/top-up",
  strip: ["trace"],
  caveats: ["acme ignores the trace field"],
  router: {
    port: 18800,
    label: "test.acme-router",
    healthPath: "/acme-router/health",
    modelPrefixes: ["big-", "small-"],
  },
});

/** A worker that shares no term with the claude worker, and has no spending cap. */
export const ACME_WORKER: WorkerTerms = {
  efforts: ["gentle", "firm", "fierce"],
  budget: false,
  briefNotes: {
    effort: "sent as acmebot --zeal",
    addDirs: "mounted read-only",
    budgetUsd: "refused: acmebot has no spending cap",
    readonly: "answered from the repo, nothing written",
  },
};

/** Text with zai's own names: what an ACME rendering must never contain. */
export const ZAI_NAMES = /zai|z\.ai|glm-5\.3|claude/i;
