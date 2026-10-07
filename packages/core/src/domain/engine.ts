/**
 * The engines a job can run on: `claude` (headless Claude Code on the provider's
 * Anthropic-compatible endpoint) and three delegation tools — omp, opencode and pi. The plugin does not own the tools:
 * each runs exactly as the user set it up (its own login, provider, default model and config), and the plugin only
 * bridges a job to it — the worktree, the brief, the events, the access, the deadline and the process group. Every
 * provider plugin offers all three the same way; the provider's model only watches the run (the wrapper agent).
 */
export const ENGINES = ["claude", "omp", "opencode", "pi"] as const;
export type Engine = (typeof ENGINES)[number];

/** The delegation tools: every engine but claude, which is always enabled. */
export const ENGINE_TOOLS = ["omp", "opencode", "pi"] as const;
export type EngineTool = (typeof ENGINE_TOOLS)[number];

export function isEngine(value: unknown): value is Engine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

export function isEngineTool(value: unknown): value is EngineTool {
  return typeof value === "string" && (ENGINE_TOOLS as readonly string[]).includes(value);
}

// ── the engine config ──────────────────────────────────────────────────────────────────────────────────────────────
// Which delegation engines are enabled, who watches each one's runs, and the default engine. claude is implicit and
// always enabled; a plugin set up before engines existed has the config of claude only.

/** Who runs an engine's wrapper agent: the provider's main model (through the router) or Claude Sonnet. */
export type Watcher = "provider" | "sonnet";

export interface EngineSetting {
  readonly watcher: Watcher;
  /** What `<tool> --version` printed when the engine was enabled. */
  readonly version: string;
  /** The binary the engine was found at. */
  readonly path: string;
}

export interface EngineConfig {
  readonly engines: Readonly<Partial<Record<EngineTool, EngineSetting>>>;
  /** The engine a job runs on when neither `run --engine` nor the brief names one; claude when unset. */
  readonly defaultEngine?: Engine;
}

/** The config with one engine enabled (or its watcher changed); every other engine stays as it was. */
export function withEngine(config: EngineConfig, tool: EngineTool, setting: EngineSetting): EngineConfig {
  return { ...config, engines: { ...config.engines, [tool]: setting } };
}

/** Whether a job may run on the engine: claude always, a tool once its setup command enabled it. */
export function engineEnabled(config: EngineConfig, engine: Engine): boolean {
  return engine === "claude" || config.engines[engine] !== undefined;
}
