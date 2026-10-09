import type { Mode } from "./brief.ts";
import type { ModelRef, ModelTier } from "./model.ts";

/**
 * Every name the plugin shows its users and everything else provider-specific the shared code reads, as data. Each
 * plugin defines its own (src/provider.ts) and wires it into Deps, so the shared code spells no provider's names.
 */
export interface Provider {
  /** The CLI's name: message prefix `<name>: …`, `<name> job <id>`, the synopsis, the temp index dir prefix. */
  readonly name: string;
  /** The provider as people know it, e.g. "Z.ai GLM"; setup, key and error lines name it. */
  readonly display: string;
  /** Slash-command prefix, e.g. "/zai:" in `/zai:board`. */
  readonly slash: string;
  /** Agent prefix, e.g. "zai:" in `zai:glm-5.3`. */
  readonly agentPrefix: string;
  /** The dispatch agents (without the prefix) a run names per tier: the shipped catalog's model ids, so zai's are
   *  glm-5.3 and glm-5.3-flash. `defineProvider` derives them; a model bump renames the agents with it. The env
   *  overrides `resolveProvider` applies leave them as shipped, because the agent files carry these names. */
  readonly agents: Readonly<Record<ModelTier, string>>;
  /** Edit jobs work on branch `<branchPrefix><id>`. */
  readonly branchPrefix: string;
  /** Names the harness in the commit trailer `Worked-by: <model id> via <harness>`. */
  readonly harness: string;
  /** The variable naming an exec job's artifacts dir, for the worker and the gates. */
  readonly artifactsEnv: string;
  /** Environment-variable prefix: `${envPrefix}_MAX_CONCURRENCY` caps the adaptive limit, `${envPrefix}_MODEL_*`
   *  overrides the catalog, `${envPrefix}_BASE_URL` the endpoint. */
  readonly envPrefix: string;
  /** The model behind each tier; a brief names a tier by its `tierNames` name or by its model id. */
  readonly catalog: Readonly<Record<ModelTier, ModelRef>>;
  /** The name a brief's `model:` line uses for each tier; zai's main stays "glm", so existing briefs still parse. */
  readonly tierNames: Readonly<Record<ModelTier, string>>;
  /** The tier a brief gets when it names none. */
  readonly defaultTier: Readonly<Record<Mode, ModelTier>>;
  /** The tier `setup --ping` asks. */
  readonly pingTier: ModelTier;
  /** What runs the model, as setup and worker errors name it. */
  readonly workerLabel: string;
  /** The Anthropic-compatible endpoint. */
  readonly baseUrl: string;
  /** How the key authenticates a request; today's only style carries it as a Bearer token. */
  readonly auth: "bearer";
  /** API key environment variables in priority order (qwen also accepts DASHSCOPE_API_KEY). */
  readonly keyEnv: readonly string[];
  /** The key file `setup` writes and the worker and router read instead (mode 600). */
  readonly keyFile: string;
  /** Where the user tops up the account (the provider's billing or top-up page): named when the provider refuses a
   *  request for lack of balance or quota. */
  readonly billingUrl: string;
  /** Where the user creates an API key (the provider's key page): linked from the one-time key page. */
  readonly keysUrl: string;
  /** Request fields this provider rejects; the router strips them from provider-bound requests. Default: unchanged. */
  readonly strip: readonly string[];
  /** The catalog model that serves requests carrying a web_search server tool, when only one model of the catalog
   *  does: the router reroutes such requests to it, whatever model they asked for. Optional: no rerouting. */
  readonly webSearchModel?: string;
  /** Model caveats brief writers must heed, one sentence each, printed in the brief template. */
  readonly caveats: readonly string[];
  /** This plugin's own router: its port, its legacy service label, health path, and the model prefixes it claims. */
  readonly router: {
    readonly port: number;
    /** zai keeps its historical `dev.muhmdraouf.zai-router`; new plugins use `com.muhmdraouf.<name>-router`. */
    readonly label: string;
    /** The GET path answering `{"ok":true,"name":…,"provider":…}`. */
    readonly healthPath: string;
    /** A request whose model id starts with one of these goes to the provider; everything else to Anthropic untouched. */
    readonly modelPrefixes: readonly string[];
  };
}

/** A provider as a plugin writes it: everything but the agent names, which come from its catalog. */
type ProviderSpec = Omit<Provider, "agents">;

/** The provider with its agents named by its catalog's model ids: one place names a model, and the agents follow. */
export function defineProvider(spec: ProviderSpec): Provider {
  return { ...spec, agents: { main: spec.catalog.main.id, flash: spec.catalog.flash.id } };
}

/** The environment a provider reads: the process environment's string values (missing keys undefined). */
export type EnvLookup = Readonly<Record<string, string | undefined>>;

/** Every model env override a provider honours, uppercased tier appended: `${envPrefix}_MODEL_MAIN`, `_MODEL_FLASH`. */
export function modelEnvName(provider: Provider, tier: ModelTier): string {
  return `${provider.envPrefix}_MODEL_${tier.toUpperCase()}`;
}

/** The env vars the router service reads: `${envPrefix}_ROUTER_PORT`, `_ROUTER_URL`, `_ROUTER_ANTHROPIC_URL`. */
export function routerEnvName(provider: Provider, knob: "PORT" | "URL" | "ANTHROPIC_URL"): string {
  return `${provider.envPrefix}_ROUTER_${knob}`;
}

/**
 * The provider with env overrides applied, because provider catalogs change faster than releases:
 * `${envPrefix}_MODEL_MAIN`/`_MODEL_FLASH` replace the catalog's ids, `${envPrefix}_BASE_URL` the endpoint.
 */
export function resolveProvider(provider: Provider, env: EnvLookup): Provider {
  const withId = (tier: ModelTier, id: string): ModelRef => ({ ...provider.catalog[tier], id });
  const catalog: Record<ModelTier, ModelRef> = {
    main: withId("main", env[modelEnvName(provider, "main")] ?? provider.catalog.main.id),
    flash: withId("flash", env[modelEnvName(provider, "flash")] ?? provider.catalog.flash.id),
  };
  const baseUrl = env[`${provider.envPrefix}_BASE_URL`] ?? provider.baseUrl;
  return { ...provider, catalog, baseUrl };
}

/** Which model ids a provider's router takes: its resolved catalog ids (env overrides included) and its prefixes. The
 *  one answer to "is this our model?" that the worker, the front, the emergency passthrough and the peer registry all
 *  share. Plain data, so a registry entry is one and the builtin-only passthrough bundle may build one. */
export interface ModelClaim {
  readonly ids: readonly string[];
  readonly prefixes: readonly string[];
}

/** The claim of a provider as this process runs it: pass the resolved provider (`resolveProvider`), so an overridden
 *  model id outside the usual prefix is still this provider's. */
export function modelClaim(provider: Provider): ModelClaim {
  return {
    ids: [provider.catalog.main.id, provider.catalog.flash.id],
    prefixes: provider.router.modelPrefixes,
  };
}

/** True when the claim covers the model: one of its ids, or an id with one of its prefixes. "" is nobody's. */
export function claims(claim: ModelClaim, model: string): boolean {
  if (model === "") return false;
  return claim.ids.includes(model) || claim.prefixes.some((prefix) => model.startsWith(prefix));
}
